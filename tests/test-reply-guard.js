/**
 * ทดสอบตรรกะของโหนด "Prepare LINE Reply"
 *
 * จุดสำคัญเชิงวิธีวิจัย: ไฟล์นี้ไม่ได้คัดลอกโค้ดมาทดสอบ แต่ "อ่านโค้ดจริง"
 * ออกมาจาก n8n/workflows/tax-advisor-workflow.json ที่นำไปใช้งานจริง
 * ผลการทดสอบจึงเป็นหลักฐานว่าโค้ดที่รันอยู่บนระบบมีพฤติกรรมตามที่รายงาน
 *
 * รันด้วย: node --test tests/test-reply-guard.js
 * (หรือรันทุกชุดพร้อมกัน: node --test tests/*.js)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, 'n8n', 'workflows', 'tax-advisor-workflow.json');

// ---------------------------------------------------------------------------
// ดึงโค้ดของโหนดออกมาจากไฟล์เวิร์กโฟลว์จริง
// ---------------------------------------------------------------------------
function loadNodeCode(nodeName) {
  const wf = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`ไม่พบโหนดชื่อ "${nodeName}" ในไฟล์เวิร์กโฟลว์`);
  return node.parameters.jsCode;
}

const PREPARE_CODE = loadNodeCode('Prepare LINE Reply');

/**
 * จำลองสภาพแวดล้อมของ n8n Code node แล้วรันโค้ดจริง
 *
 * @param {object} opts
 * @param {string|null} opts.output       คำตอบจาก AI Agent
 * @param {string} opts.questionCategory  ประเภทคำถามจากโหนด Build Context
 * @param {boolean} opts.error            จำลองกรณี AI Agent ผิดพลาด
 */
function runPrepareReply({
  output,
  questionCategory = 'คำนวณภาษี',
  error = false,
  upsertFailed = false,
  elapsedMs = 1234,
  ผลเครื่องมือ = null,
}) {
  const nodeData = {
    'Extract LINE Data': {
      replyToken: 'TOKEN-TEST',
      lineUserId: 'U-ผู้ใช้ทดสอบ',
      userMessage: 'คำถามทดสอบ',
      // ใช้จำลองกรณีระบบตอบช้าจน reply token หมดอายุ
      receivedAt: Date.now() - elapsedMs,
    },
    // เมื่อโหนด Upsert User ล้มเหลว n8n จะส่งรายการที่มีแต่ฟิลด์ error ต่อมา ไม่มี id
    'Upsert User': upsertFailed ? { error: 'connection refused' } : { id: 99 },
    'Build Context': {
      matchedKnowledge: 'หัวข้อทดสอบ',
      knowledgeHits: 1,
      questionCategory,
    },
  };

  // ผลเครื่องมือจะถูกส่งมาในรูปแบบเดียวกับที่ LangChain ส่งออกมาจริง
  // คือ intermediateSteps แต่ละขั้นมี observation เป็นสตริง JSON
  const intermediateSteps =
    ผลเครื่องมือ === null
      ? undefined
      : [{ action: { tool: 'เครื่องมือทดสอบ' }, observation: JSON.stringify(ผลเครื่องมือ) }];

  const $input = { first: () => ({ json: { output, error, intermediateSteps } }) };
  const $ = (name) => {
    if (!(name in nodeData)) throw new Error(`โค้ดเรียกโหนดที่ไม่มีอยู่: ${name}`);
    return { first: () => ({ json: nodeData[name] }) };
  };
  const $env = { ACTIVE_MODEL_NAME: 'model-ทดสอบ' };

  const fn = new Function('$input', '$', '$env', PREPARE_CODE);
  return fn($input, $, $env)[0].json;
}

const DISCLAIMER_MARK = 'กรมสรรพากร สายด่วน 1161';
const LINE_MAX = 2000;

// ---------------------------------------------------------------------------
// กลุ่มที่ 1: ด่านตรวจคำตอบผิดรูปแบบ (แบบจำลองพิมพ์ข้อมูลนำเข้าออกมาเป็นคำตอบ)
// ---------------------------------------------------------------------------
test('RG-01 คำตอบที่เป็น JSON ดิบต้องถูกแทนที่ ไม่หลุดถึงผู้ใช้', () => {
  const r = runPrepareReply({ output: '{"taxDue":10000,"monthsLate":3}' });
  assert.ok(!r.answer.includes('taxDue'), 'ข้อมูลดิบต้องไม่ปรากฏในคำตอบ');
  assert.match(r.answer, /ระบบประมวลผลคำถามนี้ไม่สมบูรณ์/);
});

test('RG-02 คำตอบที่ขึ้นต้นด้วยโค้ดบล็อก JSON ต้องถูกจับได้', () => {
  const r = runPrepareReply({ output: '```json\n{"income":{"salary":600000}}\n```' });
  assert.match(r.answer, /ระบบประมวลผลคำถามนี้ไม่สมบูรณ์/);
});

test('RG-03 คำตอบที่ขึ้นต้นด้วยวงเล็บเหลี่ยมต้องถูกจับได้', () => {
  const r = runPrepareReply({ output: '[{"name":"calculate_thai_personal_income_tax"}]' });
  assert.match(r.answer, /ระบบประมวลผลคำถามนี้ไม่สมบูรณ์/);
});

test('RG-04 คำตอบภาษาไทยปกติต้องผ่านด่านไปได้ ไม่ถูกจับผิด', () => {
  const r = runPrepareReply({ output: 'ภาษีที่ต้องชำระคือ 20,600 บาทค่ะ' });
  assert.ok(r.answer.startsWith('ภาษีที่ต้องชำระคือ 20,600 บาท'));
});

test('RG-05 คำตอบที่ "มี" JSON อยู่ตรงกลางแต่ขึ้นต้นด้วยข้อความ ต้องไม่ถูกจับผิด', () => {
  const r = runPrepareReply({ output: 'สรุปผลการคำนวณ {"ภาษี": 20600} ค่ะ' });
  assert.ok(r.answer.startsWith('สรุปผลการคำนวณ'));
});

test('RG-06 คำตอบว่างต้องกลายเป็นข้อความแจ้งข้อผิดพลาด', () => {
  const r = runPrepareReply({ output: '' });
  assert.match(r.answer, /ระบบขัดข้องชั่วคราว/);
});

test('RG-07 กรณี AI Agent ผิดพลาดต้องได้ข้อความแจ้งข้อผิดพลาด', () => {
  const r = runPrepareReply({ output: null, error: true });
  assert.match(r.answer, /ระบบขัดข้องชั่วคราว/);
});

// ---------------------------------------------------------------------------
// กลุ่มที่ 2: คำเตือนท้ายคำตอบ (เงื่อนไขจำเป็นก่อนนำไปใช้งานจริง)
// ---------------------------------------------------------------------------
const IN_SCOPE = ['คำนวณภาษี', 'บทลงโทษ', 'สิทธิ์ลดหย่อน', 'กำหนดยื่นภาษี', 'กฎหมายภาษี'];

for (const category of IN_SCOPE) {
  test(`RG-08 หมวด "${category}" ต้องมีคำเตือนต่อท้ายเสมอ`, () => {
    const r = runPrepareReply({ output: 'คำตอบตัวอย่าง', questionCategory: category });
    assert.ok(r.answer.includes(DISCLAIMER_MARK), 'ต้องมีคำเตือนและเบอร์สายด่วน');
  });
}

test('RG-09 คำถามนอกขอบเขตไม่ต้องมีคำเตือนเรื่องภาษี', () => {
  const r = runPrepareReply({ output: 'ขออภัยค่ะ เรื่องนี้อยู่นอกขอบเขต', questionCategory: 'อื่นๆ' });
  assert.ok(!r.answer.includes(DISCLAIMER_MARK));
});

test('RG-10 ข้อความแจ้งข้อผิดพลาดไม่ต้องมีคำเตือน', () => {
  const r = runPrepareReply({ output: '', questionCategory: 'คำนวณภาษี' });
  assert.ok(!r.answer.includes(DISCLAIMER_MARK));
});

test('RG-11 คำตอบยาวเกินขีดจำกัดต้องยังคงมีคำเตือนครบถ้วน', () => {
  const long = 'ก'.repeat(5000);
  const r = runPrepareReply({ output: long, questionCategory: 'คำนวณภาษี' });
  assert.ok(r.answer.length <= LINE_MAX, `ความยาว ${r.answer.length} ต้องไม่เกิน ${LINE_MAX}`);
  assert.ok(r.answer.endsWith('ก่อนยื่นจริง'), 'คำเตือนต้องอยู่ครบท้ายข้อความ');
  assert.ok(r.answer.includes(DISCLAIMER_MARK));
});

test('RG-12 คำตอบสั้นต้องไม่ถูกตัดทอน', () => {
  const r = runPrepareReply({ output: 'ภาษี 20,600 บาท', questionCategory: 'คำนวณภาษี' });
  assert.ok(!r.answer.includes('...'), 'คำตอบสั้นต้องไม่มีเครื่องหมายตัดทอน');
  assert.ok(r.answer.startsWith('ภาษี 20,600 บาท'));
});

// ---------------------------------------------------------------------------
// กลุ่มที่ 2ข: ความอ่านง่ายบน LINE — ต้องไม่มี Markdown หลุดไปถึงผู้ใช้
// ---------------------------------------------------------------------------
// LINE แสดงข้อความแบบ text เป็นข้อความธรรมดา ไม่ตีความ Markdown
// ถ้าปล่อยให้ ** หรือ ### หลุดไป ผู้ใช้จะเห็นเครื่องหมายเหล่านั้นเป็นตัวอักษรจริง
test('RG-17 ตัวหนา ** ต้องถูกแปลงเป็นข้อความธรรมดา', () => {
  const r = runPrepareReply({ output: 'ภาษีที่ต้องชำระ **2,050 บาท** ค่ะ' });
  assert.ok(!r.answer.includes('**'), 'ต้องไม่เหลือเครื่องหมายดอกจัน');
  assert.ok(r.answer.includes('2,050 บาท'));
});

test('RG-18 หัวข้อ # ## ### ต้องถูกแปลง', () => {
  const r = runPrepareReply({ output: '## สรุปผลการคำนวณ\nภาษี 20,600 บาท' });
  assert.ok(!r.answer.includes('#'));
  assert.ok(r.answer.startsWith('สรุปผลการคำนวณ'));
});

test('RG-19 รายการหัวข้อย่อยต้องกลายเป็นสัญลักษณ์ที่อ่านได้', () => {
  const r = runPrepareReply({ output: '- ค่าลดหย่อนส่วนตัว 60,000\n- ประกันสังคม 9,000' });
  assert.ok(r.answer.includes('• ค่าลดหย่อนส่วนตัว 60,000'));
  assert.ok(!/^-\s/m.test(r.answer));
});

test('RG-20 ตาราง Markdown ต้องแปลงเป็นบรรทัดที่อ่านได้บนมือถือ', () => {
  const md = '| รายการ | จำนวน |\n|---|---|\n| ส่วนตัว | 60,000 |\n| ประกันสังคม | 9,000 |';
  const r = runPrepareReply({ output: md });
  assert.ok(!r.answer.includes('|'), 'ต้องไม่เหลือเส้นตาราง');
  assert.ok(!r.answer.includes('---'));
  assert.ok(r.answer.includes('ส่วนตัว  60,000'));
});

test('RG-21 โค้ดบล็อกและโค้ดในบรรทัดต้องถูกถอดออก', () => {
  const r = runPrepareReply({ output: 'สูตรคือ `เงินได้สุทธิ x อัตรา` ค่ะ' });
  assert.ok(!r.answer.includes('`'));
  assert.ok(r.answer.includes('เงินได้สุทธิ x อัตรา'));
});

test('RG-22 ลิงก์ Markdown ต้องแสดง URL ให้ผู้ใช้กดได้', () => {
  const r = runPrepareReply({ output: 'ดูที่ [กรมสรรพากร](https://www.rd.go.th) ค่ะ' });
  assert.ok(r.answer.includes('https://www.rd.go.th'));
  assert.ok(!r.answer.includes(']('));
});

test('RG-23 เครื่องหมายคูณและดอกจันที่ไม่ใช่ Markdown ต้องไม่ถูกลบผิด', () => {
  const r = runPrepareReply({ output: 'คำนวณจาก 30,000 * 12 = 360,000 บาท' });
  assert.ok(r.answer.includes('30,000 * 12'), 'ดอกจันที่ใช้เป็นเครื่องหมายคูณต้องคงอยู่');
});

test('RG-24 ข้อความแจ้งข้อผิดพลาดต้องไม่ถูกแปลงจนผิดรูป', () => {
  const r = runPrepareReply({ output: '', questionCategory: 'คำนวณภาษี' });
  assert.match(r.answer, /ระบบขัดข้องชั่วคราว/);
  assert.ok(r.answer.includes('⚠️'), 'สัญลักษณ์เตือนต้องยังอยู่');
});

// ---------------------------------------------------------------------------
// กลุ่มที่ 2ค: บังคับความยาวคำตอบให้พอดีกับหน้าจอ LINE
// ---------------------------------------------------------------------------
// LINE พับข้อความยาวไว้หลังปุ่ม "ดูเพิ่มเติม" ซึ่งผู้ใช้ส่วนใหญ่ไม่กด
// คำสั่งระบบกำหนดความยาวไว้แล้วแต่แบบจำลองไม่ทำตาม จึงต้องบังคับด้วยโค้ด
const SOFT_LIMIT = 700;

test('RG-27 คำตอบยาวเกินขีดจำกัดต้องถูกตัดให้สั้นลง', () => {
  const long = Array.from({ length: 40 }, (_, i) => `บรรทัดที่ ${i + 1} เป็นข้อความทดสอบความยาว`).join('\n');
  const r = runPrepareReply({ output: long, questionCategory: 'คำนวณภาษี' });
  const body = r.answer.split('— ข้อมูลนี้')[0];
  assert.ok(body.length < long.length, 'ต้องสั้นลงจากเดิม');
  assert.ok(body.length <= SOFT_LIMIT + 60, `ความยาว ${body.length} ต้องอยู่ในเกณฑ์`);
});

test('RG-28 การตัดต้องเกิดที่ขอบบรรทัด ไม่ตัดกลางประโยค', () => {
  const long = Array.from({ length: 30 }, (_, i) => `รายการที่ ${i + 1} จำนวน ${i * 1000} บาท`).join('\n');
  const r = runPrepareReply({ output: long, questionCategory: 'คำนวณภาษี' });
  const body = r.answer.split('\n\nอยากรู้รายละเอียด')[0];
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    assert.ok(long.includes(line), `บรรทัด "${line}" ต้องเป็นบรรทัดที่สมบูรณ์จากต้นฉบับ`);
  }
});

test('RG-29 เมื่อถูกตัดต้องชวนให้ผู้ใช้ถามต่อ', () => {
  const long = 'ก'.repeat(300) + '\n' + 'ข'.repeat(300) + '\n' + 'ค'.repeat(300);
  const r = runPrepareReply({ output: long, questionCategory: 'คำนวณภาษี' });
  assert.match(r.answer, /ถามต่อได้เลย/);
});

test('RG-30 คำตอบสั้นต้องไม่ถูกแตะต้องและไม่มีข้อความชวนถามต่อ', () => {
  const short = 'ภาษีที่ต้องชำระคือ 20,600 บาทค่ะ';
  const r = runPrepareReply({ output: short, questionCategory: 'คำนวณภาษี' });
  assert.ok(r.answer.startsWith(short));
  assert.ok(!r.answer.includes('ถามต่อได้เลย'));
});

test('RG-31 คำตอบยาวมากต้องยังมีคำเตือนครบและไม่เกินขีดจำกัดของ LINE', () => {
  const r = runPrepareReply({ output: 'ก'.repeat(9000), questionCategory: 'คำนวณภาษี' });
  assert.ok(r.answer.includes(DISCLAIMER_MARK), 'คำเตือนต้องยังอยู่');
  assert.ok(r.answer.length <= LINE_MAX, `ความยาว ${r.answer.length}`);
});

// ---------------------------------------------------------------------------
// กลุ่มที่ 3: โครงสร้างข้อมูลที่ส่งออก
// ---------------------------------------------------------------------------
test('RG-13 linePayload ต้องมีเฉพาะฟิลด์ที่ LINE API รู้จัก', () => {
  const r = runPrepareReply({ output: 'คำตอบ' });
  assert.deepStrictEqual(Object.keys(r.linePayload).sort(), ['messages', 'replyToken']);
  assert.strictEqual(r.linePayload.messages[0].type, 'text');
  assert.strictEqual(r.linePayload.messages[0].text, r.answer);
});

test('RG-14 ข้อความที่ส่งให้ LINE ต้องไม่เกิน 2000 ตัวอักษรเสมอ', () => {
  for (const category of [...IN_SCOPE, 'อื่นๆ']) {
    const r = runPrepareReply({ output: 'ก'.repeat(9000), questionCategory: category });
    assert.ok(
      r.linePayload.messages[0].text.length <= LINE_MAX,
      `หมวด ${category} ยาว ${r.linePayload.messages[0].text.length} ตัวอักษร`
    );
  }
});

test('RG-15 ต้องบันทึกข้อมูลเชิงวิจัยครบทุกฟิลด์', () => {
  const r = runPrepareReply({ output: 'คำตอบ', questionCategory: 'บทลงโทษ' });
  assert.strictEqual(r.userDbId, 99);
  assert.strictEqual(r.questionCategory, 'บทลงโทษ');
  assert.strictEqual(r.knowledgeHits, 1);
  assert.strictEqual(r.matchedKnowledge, 'หัวข้อทดสอบ');
  assert.strictEqual(r.modelName, 'model-ทดสอบ');
  assert.ok(r.responseTimeMs >= 1234, 'เวลาตอบสนองต้องคำนวณจาก receivedAt');
});

// ---------------------------------------------------------------------------
// กลุ่มที่ 4: ความทนทานเมื่อฐานข้อมูลมีปัญหา
// ---------------------------------------------------------------------------
// ฐานข้อมูลใช้สำหรับบันทึกข้อมูลผู้ใช้และประวัติ ซึ่งเป็นงานรอง
// การตอบคำถามภาษีไม่ได้ขึ้นกับมัน ผู้ใช้จึงต้องได้รับคำตอบแม้ฐานข้อมูลล่ม
test('RG-25 ฐานข้อมูลบันทึกผู้ใช้ล้มเหลว ผู้ใช้ต้องยังได้รับคำตอบ', () => {
  const r = runPrepareReply({ output: 'ภาษีที่ต้องชำระคือ 20,600 บาทค่ะ', upsertFailed: true });
  assert.ok(r.linePayload.messages[0].text.includes('20,600'), 'คำตอบต้องยังส่งถึงผู้ใช้');
  assert.ok(r.linePayload.replyToken, 'ต้องมี replyToken สำหรับตอบกลับ');
});

test('RG-26 ฐานข้อมูลล้มเหลว คำเตือนต้องยังอยู่ครบ', () => {
  const r = runPrepareReply({ output: 'ภาษี 20,600 บาท', upsertFailed: true });
  assert.ok(r.answer.includes(DISCLAIMER_MARK));
});

test('RG-16 ชื่อแบบจำลองต้องเป็น unknown เมื่อไม่ได้ตั้งค่าตัวแปรสภาพแวดล้อม', () => {
  const fn = new Function('$input', '$', '$env', PREPARE_CODE);
  const out = fn(
    { first: () => ({ json: { output: 'คำตอบ' } }) },
    (name) =>
      ({
        'Extract LINE Data': { first: () => ({ json: { replyToken: 'T', userMessage: 'q', receivedAt: Date.now() } }) },
        'Upsert User': { first: () => ({ json: { id: 1 } }) },
        'Build Context': { first: () => ({ json: { questionCategory: 'อื่นๆ', knowledgeHits: 0, matchedKnowledge: null } }) },
      })[name],
    {}
  );
  assert.strictEqual(out[0].json.modelName, 'unknown');
});

// ---------------------------------------------------------------------------
//  เกณฑ์ความยาวแยกตามประเภทคำถาม
// ---------------------------------------------------------------------------
//  อาจารย์ที่ปรึกษาให้ความเห็นว่าคำตอบประเภทอธิบายยาวเกินกว่าที่คนทั่วไปจะอ่านจบ
//  ต่างจากคำตอบที่เป็นตัวเลขซึ่งต้องแจกแจงขั้นตอนให้ผู้ใช้ตรวจทานตามได้
//  จึงแยกเกณฑ์เป็นสองค่า คำถามคำนวณ 700 ตัวอักษร คำถามอธิบาย 420 ตัวอักษร
//
//  การทดสอบกลุ่มนี้กันสองอย่าง
//   1. กันไม่ให้ใครเผลอกลับไปใช้ค่าเดียวทั้งระบบ ซึ่งจะทำให้คำตอบอธิบายยาวเหมือนเดิม
//   2. กันไม่ให้ตั้งค่าคำถามอธิบายต่ำเกินจนตัดคำตอบสั้น ๆ ที่ปกติดีอยู่แล้ว

const LONG_ANSWER = Array.from({ length: 40 }, (_, i) => `บรรทัดที่ ${i + 1} อธิบายเรื่องภาษี`).join('\n');

test('RG-32 คำถามอธิบายต้องถูกตัดสั้นกว่าคำถามคำนวณอย่างชัดเจน', () => {
  const explain = runPrepareReply({ output: LONG_ANSWER, questionCategory: 'สิทธิ์ลดหย่อน' });
  const calc = runPrepareReply({ output: LONG_ANSWER, questionCategory: 'คำนวณภาษี' });

  assert.ok(
    explain.answer.length < calc.answer.length,
    `คำตอบอธิบาย ${explain.answer.length} ต้องสั้นกว่าคำตอบคำนวณ ${calc.answer.length}`
  );
});

test('RG-33 คำตอบประเภทอธิบายต้องไม่เกิน 420 ตัวอักษร ไม่นับคำเตือนและข้อความชวนถามต่อ', () => {
  for (const category of ['สิทธิ์ลดหย่อน', 'กำหนดยื่นภาษี', 'กฎหมายภาษี']) {
    const r = runPrepareReply({ output: LONG_ANSWER, questionCategory: category });
    const body = r.answer.split('\n\nอยากรู้รายละเอียดเพิ่ม')[0];
    assert.ok(body.length <= 420, `หมวด ${category} ได้ ${body.length} ตัวอักษร`);
  }
});

test('RG-34 คำถามคำนวณต้องยังยาวได้ถึง 700 ตัวอักษร เพื่อให้แจกแจงขั้นตอนครบ', () => {
  for (const category of ['คำนวณภาษี', 'บทลงโทษ']) {
    const r = runPrepareReply({ output: LONG_ANSWER, questionCategory: category });
    const body = r.answer.split('\n\nอยากรู้รายละเอียดเพิ่ม')[0];
    assert.ok(body.length > 420, `หมวด ${category} ต้องยาวเกิน 420 แต่ได้ ${body.length}`);
    assert.ok(body.length <= 700, `หมวด ${category} ต้องไม่เกิน 700 แต่ได้ ${body.length}`);
  }
});

test('RG-35 คำตอบอธิบายที่สั้นอยู่แล้วต้องไม่ถูกแตะต้อง', () => {
  const short = 'ค่าลดหย่อนส่วนตัวหักได้ 60,000 บาทค่ะ ตามมาตรา 47(1)(ก)';
  const r = runPrepareReply({ output: short, questionCategory: 'สิทธิ์ลดหย่อน' });

  assert.ok(r.answer.startsWith(short), 'ข้อความเดิมต้องอยู่ครบ ไม่ถูกตัด');
  assert.ok(!r.answer.includes('อยากรู้รายละเอียดเพิ่ม'), 'ไม่ควรต่อข้อความชวนถามต่อ เพราะไม่ได้ถูกตัด');
});

test('RG-36 คำตอบที่ถูกตัดต้องบอกผู้ใช้ว่าถามต่อได้ ไม่ใช่จบห้วน ๆ', () => {
  const r = runPrepareReply({ output: LONG_ANSWER, questionCategory: 'สิทธิ์ลดหย่อน' });
  assert.ok(r.answer.includes('ถามต่อได้เลยค่ะ'));
});

// ---------------------------------------------------------------------------
//  บังคับคำลงท้ายให้ตรงกับบุคลิกของบอท
// ---------------------------------------------------------------------------
//  บอทชื่อ คุณภาษี เป็นผู้หญิง ลงท้ายว่า ค่ะ ตลอด
//  คำสั่งระบบสั่งไว้แล้ว แต่วัดผลพบว่าแบบจำลองยังหลุดใช้ ครับ เป็นบางครั้ง
//  เป็นบทเรียนเดียวกับเรื่องคำเตือนและการเรียกเครื่องมือ
//  สิ่งที่ต้องรับประกันได้ทุกครั้ง ต้องบังคับด้วยกฎ ไม่ใช่ขอความร่วมมือ

test('RG-37 คำตอบต้องไม่มีคำว่า ครับ หลงเหลือ', () => {
  const r = runPrepareReply({
    output: 'ใช่ครับ เงินเพิ่มมีเพดานสูงสุดตามมาตรา 27 ครับ',
    questionCategory: 'บทลงโทษ',
  });
  assert.ok(!r.answer.includes('ครับ'), `ยังพบคำว่า ครับ ในคำตอบ: ${r.answer}`);
  assert.ok(r.answer.includes('ค่ะ'));
});

test('RG-38 แทนที่ ครับ แล้วต้องไม่เกิด ค่ะ ซ้อนกัน', () => {
  const r = runPrepareReply({ output: 'ขออภัยครับๆ', questionCategory: 'อื่นๆ' });
  assert.ok(!r.answer.includes('ค่ะๆ'), `พบคำลงท้ายซ้อนกัน: ${r.answer}`);
});

test('RG-39 คำตอบที่ใช้ ค่ะ อยู่แล้วต้องไม่ถูกแก้', () => {
  const original = 'ค่าลดหย่อนส่วนตัวหักได้ 60,000 บาทค่ะ';
  const r = runPrepareReply({ output: original, questionCategory: 'สิทธิ์ลดหย่อน' });
  assert.ok(r.answer.startsWith(original));
});

// ---------------------------------------------------------------------------
//  บรรทัด "คำนวณจาก" ต้องถูกเติมด้วยโค้ด ไม่ใช่หวังให้แบบจำลองยกมาเอง
// ---------------------------------------------------------------------------
//  เคยสั่งในคำสั่งระบบให้ยกบรรทัดนี้มาแสดง แต่วัดจากการใช้งานจริงแล้วไม่ทำตาม
//  จึงย้ายมาบังคับด้วยโค้ด ตามหลักการเดิมของงานนี้
//
//  บรรทัดนี้ทำสองอย่าง
//    1. บอกว่าระบบตีความโจทย์ที่กำกวมว่าอย่างไร เช่น บุตรสอง คิดเป็น 2 คน
//    2. เผยให้เห็นเมื่อแบบจำลองส่งค่าผิดช่อง ซึ่งเดิมความผิดพลาดแบบนี้ซ่อนอยู่

function runWithSteps(output, steps, questionCategory = 'คำนวณภาษี') {
  const fn = new Function('$input', '$', '$env', PREPARE_CODE);
  return fn(
    { first: () => ({ json: { output, intermediateSteps: steps } }) },
    (name) =>
      ({
        'Extract LINE Data': {
          first: () => ({ json: { replyToken: 'T', userMessage: 'q', receivedAt: Date.now() } }),
        },
        'Upsert User': { first: () => ({ json: { id: 1, consent_status: 'granted' } }) },
        'Build Context': {
          first: () => ({ json: { questionCategory, knowledgeHits: 2, matchedKnowledge: 'x' } }),
        },
      })[name],
    {}
  )[0].json;
}

const STEP = [
  {
    observation: JSON.stringify({
      สำเร็จ: true,
      คำนวณจาก: 'เงินเดือน 600,000 บาท · ค่าลดหย่อนบุตร 2 คน 60,000 บาท',
      สรุป: { ภาษีที่ต้องชำระ: 15500 },
    }),
  },
];

test('RG-40 ต้องเติมบรรทัดคำนวณจากให้เอง เมื่อแบบจำลองไม่ยกมา', () => {
  const r = runWithSteps('ภาษีที่ต้องชำระคือ 15,500 บาทค่ะ', STEP);
  assert.ok(r.answer.startsWith('คำนวณจาก '), `ไม่ได้เติมบรรทัดให้: ${r.answer.slice(0, 60)}`);
  assert.ok(r.answer.includes('บุตร 2 คน'), 'ต้องเห็นการตีความจำนวนบุตร');
  assert.ok(r.answer.includes('15,500'), 'คำตอบเดิมต้องยังอยู่ครบ');
});

test('RG-41 ถ้าแบบจำลองยกมาเองแล้ว ต้องไม่เติมซ้ำเป็นสองบรรทัด', () => {
  const r = runWithSteps('คำนวณจาก เงินเดือน 600,000 บาท\nภาษีที่ต้องชำระคือ 15,500 บาทค่ะ', STEP);
  const count = (r.answer.match(/คำนวณจาก/g) || []).length;
  assert.strictEqual(count, 1, `พบบรรทัดคำนวณจาก ${count} ครั้ง`);
});

test('RG-42 คำถามที่ไม่ได้เรียกเครื่องคำนวณ ต้องไม่มีบรรทัดนี้', () => {
  const r = runWithSteps('ค่าลดหย่อนส่วนตัวหักได้ 60,000 บาทค่ะ', [], 'สิทธิ์ลดหย่อน');
  assert.ok(!r.answer.includes('คำนวณจาก'));
});

test('RG-43 ข้อมูลขั้นตอนกลางผิดรูปแบบ ต้องไม่ทำให้ระบบพัง', () => {
  // n8n อาจเปลี่ยนโครงสร้างในเวอร์ชันใหม่ ระบบต้องยังตอบผู้ใช้ได้เสมอ
  for (const steps of [undefined, null, 'ไม่ใช่อาร์เรย์', [{}], [{ observation: 'ไม่ใช่ JSON' }]]) {
    const r = runWithSteps('ภาษีที่ต้องชำระคือ 15,500 บาทค่ะ', steps);
    assert.ok(r.answer.includes('15,500'), `พังเมื่อขั้นตอนกลางเป็น ${JSON.stringify(steps)}`);
  }
});

test('RG-44 ข้อความแจ้งข้อผิดพลาดต้องไม่ถูกเติมบรรทัดคำนวณจาก', () => {
  const r = runWithSteps('', STEP);
  assert.ok(!r.answer.includes('คำนวณจาก'), 'ไม่มีการคำนวณเกิดขึ้น จึงไม่ควรมีบรรทัดนี้');
});

// ---------------------------------------------------------------------------
// กลุ่มที่ 8: ตาข่ายรองรับเมื่อ reply token หมดอายุ
// ---------------------------------------------------------------------------
//  ที่มา
//    reply token ของ LINE ใช้ได้ราว 60 วินาทีนับจากเวลาที่ผู้ใช้ส่งข้อความ
//    ถ้าหมดอายุแล้วยังเรียก Reply API อยู่ LINE จะปฏิเสธ
//    ผู้ใช้จะไม่ได้รับอะไรเลย ไม่มีแม้แต่ข้อความบอกว่าเกิดอะไรขึ้น
//    ทั้งที่ระบบคำนวณคำตอบถูกต้องเรียบร้อยแล้ว เป็นความล้มเหลวแบบเงียบ
//
//    พบจากการวัดผลรอบที่ 8 คำถามเดียวกัน (Q33) ใช้เวลา 139 และ 169 วินาที
//    ในสองรอบ แต่รอบที่สามใช้แค่ 2.1 วินาที มัธยฐานทั้งชุดคือ 1.4 วินาที
//    จึงไม่ใช่คำถามที่หนัก แต่เป็นบริการแบบจำลองช้าเป็นครั้งคราว
//    ซึ่งควบคุมไม่ได้และต้องออกแบบระบบให้รองรับ

const wfJson = () => JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
const findNode = (name) => wfJson().nodes.find((n) => n.name === name);

test('RG-45 คำตอบที่ตอบทันเวลา ต้องเลือกส่งด้วย Reply API ซึ่งใช้ฟรี', () => {
  const r = runPrepareReply({ output: 'คำตอบทดสอบ', elapsedMs: 2000 });
  assert.strictEqual(r.useReplyToken, true);
  assert.strictEqual(r.linePayload.replyToken, 'TOKEN-TEST');
});

test('RG-46 คำตอบที่ช้าจน token หมดอายุ ต้องเปลี่ยนไปใช้ Push API', () => {
  const r = runPrepareReply({ output: 'คำตอบทดสอบ', elapsedMs: 65000 });
  assert.strictEqual(r.useReplyToken, false, 'ช้า 65 วินาทีแล้วยังจะใช้ reply token อยู่');
  assert.strictEqual(r.pushPayload.to, 'U-ผู้ใช้ทดสอบ', 'ต้องส่งเข้าห้องแชทของผู้ใช้คนที่ถาม');
});

test('RG-47 เกณฑ์เวลาต้องเผื่อไว้ก่อนถึง 60 วินาที ไม่ใช่ตั้งชิดเส้นพอดี', () => {
  // ถ้าตั้งไว้ที่ 60 วินาทีเป๊ะ จะมีกรณีที่คำนวณว่าทันแต่พอส่งจริงกลับไม่ทัน
  // เพราะยังต้องใช้เวลาเดินทางในเครือข่ายและเวลาที่โหนดถัดไปทำงานอีก
  const ก่อนเส้น = runPrepareReply({ output: 'คำตอบ', elapsedMs: 55000 });
  assert.strictEqual(ก่อนเส้น.useReplyToken, false, 'ที่ 55 วินาทีควรเผื่อไว้แล้ว');
});

test('RG-48 ทั้งสองช่องทางต้องส่งข้อความเดียวกัน ผู้ใช้ต้องไม่ได้คำตอบที่ต่างกัน', () => {
  const เร็ว = runPrepareReply({ output: 'คำตอบทดสอบ', elapsedMs: 2000 });
  const ช้า = runPrepareReply({ output: 'คำตอบทดสอบ', elapsedMs: 65000 });
  assert.strictEqual(เร็ว.linePayload.messages[0].text, เร็ว.pushPayload.messages[0].text);
  assert.strictEqual(ช้า.linePayload.messages[0].text, ช้า.pushPayload.messages[0].text);
});

test('RG-49 เวิร์กโฟลว์ต้องมีด่านตัดสินใจและปลายทางครบทั้งสองทาง', () => {
  const conn = wfJson().connections;
  assert.ok(findNode('Check Reply Token'), 'ไม่พบโหนด Check Reply Token');
  assert.ok(findNode('Push to LINE'), 'ไม่พบโหนด Push to LINE');

  const branches = conn['Check Reply Token'].main;
  assert.strictEqual(branches[0][0].node, 'Reply to LINE', 'ทางจริงต้องไป Reply API');
  assert.strictEqual(branches[1][0].node, 'Push to LINE', 'ทางเท็จต้องไป Push API');
});

test('RG-50 Push API ต้องยิงไปที่ปลายทางของตัวเอง ไม่ใช่ปลายทางของ Reply', () => {
  const push = findNode('Push to LINE');
  assert.ok(/\/message\/push$/.test(push.parameters.url), `ปลายทางผิด: ${push.parameters.url}`);
  assert.ok(
    push.parameters.jsonBody.includes('pushPayload'),
    'Push API ต้องใช้ pushPayload ไม่ใช่ linePayload ที่มี replyToken อยู่ข้างใน'
  );
});

test('RG-51 การบันทึกบทสนทนาต้องเกิดขึ้นไม่ว่าจะส่งทางไหน', () => {
  // ถ้าเอา Log Conversation ไปต่อท้ายด่านตัดสินใจ จะบันทึกได้แค่ทางเดียว
  // ข้อมูลของกรณีที่ตอบช้าซึ่งเป็นกรณีที่น่าสนใจที่สุดจะหายไปจากงานวิจัย
  const targets = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8')).connections['Prepare LINE Reply']
    .main[0].map((x) => x.node);
  assert.ok(targets.includes('Log Conversation'), 'ต้องบันทึกจากจุดก่อนแยกทาง');
  assert.ok(targets.includes('Check Reply Token'));
});


// ---------------------------------------------------------------------------
// กลุ่มที่ 8: ด่านกันแบบจำลองเขียนทับตัวเลขจากเครื่องคำนวณ
// ---------------------------------------------------------------------------
//
// ที่มา: การวัดผลรอบวันที่ 12 สิงหาคม คำถามข้อ 41 ผิด 2 ใน 3 รอบ
//   คำถาม   "มีรายได้จากค่าเช่าบ้านปีละ 400,000 บาท โสด ภาษีเท่าไหร่"
//   เครื่องคำนวณส่งค่า 3,500 บาท กลับมาเหมือนกันทั้งสามรอบ
//   แต่แบบจำลองตอบว่า "0 บาท เนื่องจากได้รับยกเว้นตามมาตรา 48(2)"
//   โดยรายการแยกทุกบรรทัดก่อนหน้าถูกต้องหมด ผิดเฉพาะบรรทัดสุดท้าย
//
// เหตุใดจึงต้องแก้ด้วยโค้ด ไม่ใช่แก้คำสั่งระบบ
//   คำสั่งระบบระบุไว้อยู่แล้วว่า "ใช้ตัวเลขจากเครื่องมือเท่านั้น" แต่ไม่เป็นผล
//   เพราะคำสั่งเป็นเพียงข้อความที่แบบจำลองอาจทำตามหรือไม่ก็ได้
//   ด่านนี้ทำงานหลังแบบจำลองตอบเสร็จ จึงบังคับได้แน่นอนทุกครั้ง
//
// ทิศทางของความผิดพลาดสำคัญ: ตอบต่ำกว่าความจริง ผู้ใช้ที่เชื่อจะยื่นภาษีขาด
// และถูกประเมินเงินเพิ่มย้อนหลัง จึงเป็นความผิดพลาดที่ยอมให้เกิดไม่ได้

const ผลค่าเช่า400000 = {
  สำเร็จ: true,
  ปีภาษี: 2567,
  คำนวณจาก: '40(5) ค่าเช่า (building) 400,000 บาท',
  สรุป: {
    เงินได้พึงประเมินรวม: 400000,
    หักค่าใช้จ่าย: 120000,
    หักค่าลดหย่อน: 60000,
    หักเงินบริจาค: 0,
    เงินได้สุทธิ: 220000,
    ภาษีที่ต้องชำระ: 3500,
    ภาษีหักณที่จ่าย: 0,
    ต้องชำระเพิ่ม: 3500,
  },
};

const คำตอบผิดจริงจากการวัดผล =
  'ภาษีที่ต้องชำระคือ 0 บาทค่ะ เนื่องจากได้รับยกเว้นภาษีตามมาตรา 48(2) แห่งประมวลรัษฎากร ' +
  'คำนวณจาก 40(5) ค่าเช่า (building) 400,000 บาท - เงินได้รวม 400,000 บาท - ' +
  'หักค่าใช้จ่าย 120,000 บาท - หักค่าลดหย่อน 60,000 บาท - เงินได้สุทธิ 220,000 บาท - ' +
  'ภาษีที่ต้องชำระ 0 บาท (ได้รับยกเว้น) 🏠';

test('RG-52 คำตอบที่ทิ้งตัวเลขจากเครื่องคำนวณ ต้องถูกเขียนใหม่จากผลของเครื่องมือ', () => {
  const r = runPrepareReply({
    output: คำตอบผิดจริงจากการวัดผล,
    ผลเครื่องมือ: ผลค่าเช่า400000,
  });
  assert.strictEqual(r['ด่านตัวเลขทำงาน'], true, 'ด่านต้องจับได้ว่าคำตอบไม่มีตัวเลขของเครื่องมือ');
  assert.ok(r.answer.includes('3,500'), 'คำตอบใหม่ต้องมีตัวเลขจริงจากเครื่องคำนวณ');
});

test('RG-53 เหตุผลทางกฎหมายที่แบบจำลองแต่งขึ้น ต้องหายไปพร้อมกับตัวเลขผิด', () => {
  // แค่แก้ตัวเลขไม่พอ เพราะคำอธิบายรอบตัวเลขก็ผิดตามไปด้วย
  // ถ้าแก้เฉพาะเลขจะได้คำตอบว่า "3,500 บาท เนื่องจากได้รับยกเว้น" ซึ่งขัดแย้งในตัวเอง
  const r = runPrepareReply({
    output: คำตอบผิดจริงจากการวัดผล,
    ผลเครื่องมือ: ผลค่าเช่า400000,
  });
  assert.ok(!r.answer.includes('48(2)'), 'ข้ออ้างทางกฎหมายที่ไม่ถูกต้องต้องไม่หลงเหลือ');
  assert.ok(!r.answer.includes('ยกเว้น'), 'คำว่ายกเว้นต้องไม่หลงเหลืออยู่ในคำตอบ');
});

test('RG-54 คำตอบที่ถูกต้องอยู่แล้ว ต้องไม่ถูกด่านแตะต้อง', () => {
  // ข้อนี้สำคัญกว่าข้ออื่นในกลุ่ม เพราะถ้าด่านทำงานพร่ำเพรื่อ
  // จะทำลายคำตอบที่ดี 343 ข้อเพื่อแก้คำตอบผิด 2 ข้อ
  const ดีอยู่แล้ว = 'ภาษีที่ต้องชำระคือ 3,500 บาทค่ะ คำนวณจากค่าเช่า 400,000 บาท';
  const r = runPrepareReply({ output: ดีอยู่แล้ว, ผลเครื่องมือ: ผลค่าเช่า400000 });
  assert.notStrictEqual(r['ด่านตัวเลขทำงาน'], true, 'ด่านไม่ควรทำงานกับคำตอบที่ถูกต้อง');
  assert.ok(r.answer.startsWith(ดีอยู่แล้ว), 'คำตอบเดิมต้องถูกส่งต่อโดยไม่ถูกดัดแปลง');
});

test('RG-55 ตัวเลขที่เขียนแบบไม่มีลูกน้ำ ต้องนับว่าตรงกัน', () => {
  const r = runPrepareReply({
    output: 'ภาษีที่ต้องชำระคือ 3500 บาทค่ะ',
    ผลเครื่องมือ: ผลค่าเช่า400000,
  });
  assert.notStrictEqual(r['ด่านตัวเลขทำงาน'], true, '3500 กับ 3,500 คือจำนวนเดียวกัน');
});

test('RG-56 คำถามที่ไม่ได้เรียกเครื่องคำนวณ ด่านต้องไม่ทำงาน', () => {
  const r = runPrepareReply({ output: 'ยื่นภาษีได้ถึงวันที่ 31 มีนาคม ค่ะ' });
  assert.notStrictEqual(r['ด่านตัวเลขทำงาน'], true);
  assert.ok(r.answer.startsWith('ยื่นภาษีได้ถึงวันที่ 31 มีนาคม'));
});

test('RG-57 ด่านต้องครอบคลุมเครื่องคำนวณค่าปรับด้วย ไม่ใช่เฉพาะเครื่องคำนวณภาษี', () => {
  const ผลค่าปรับ = {
    สำเร็จ: true,
    สรุป: {
      ภาษีที่ต้องชำระ: 10000,
      เงินเพิ่ม: 450,
      ค่าปรับ: 2000,
      รวมที่ต้องชำระเพิ่ม: 2450,
      รวมทั้งสิ้นพร้อมภาษี: 12450,
    },
  };
  const r = runPrepareReply({
    output: 'ไม่ต้องเสียค่าปรับค่ะ เพราะยื่นล่าช้าไม่เกินกำหนด',
    ผลเครื่องมือ: ผลค่าปรับ,
  });
  assert.strictEqual(r['ด่านตัวเลขทำงาน'], true);
  assert.ok(r.answer.includes('2,450'), 'ต้องแสดงยอดที่ต้องชำระเพิ่มจริง');
});

test('RG-58 คำตอบที่ถูกเขียนใหม่ ต้องยังมีข้อความกำกับตามเงื่อนไขงานวิจัย', () => {
  const r = runPrepareReply({
    output: คำตอบผิดจริงจากการวัดผล,
    ผลเครื่องมือ: ผลค่าเช่า400000,
  });
  assert.ok(r.answer.includes(DISCLAIMER_MARK), 'คำตอบที่สร้างใหม่ต้องไม่หลุดข้อความกำกับ');
  assert.ok(r.answer.length <= LINE_MAX);
});

test('RG-59 ด่านต้องไม่กลบข้อความแจ้งข้อผิดพลาดของระบบ', () => {
  // ถ้าแบบจำลองล้มเหลวจนต้องขึ้นข้อความขัดข้อง แต่เครื่องมือเคยทำงานสำเร็จ
  // ด่านต้องไม่เอาผลเครื่องมือมาสร้างคำตอบทับ เพราะสิ่งที่ผิดพลาดคือขั้นตอนอื่น
  const r = runPrepareReply({ output: '', ผลเครื่องมือ: ผลค่าเช่า400000 });
  assert.match(r.answer, /ระบบขัดข้องชั่วคราว/);
});

test('RG-60 ผลเครื่องมือที่อ่านไม่ออก ต้องไม่ทำให้โหนดทั้งโหนดล้มเหลว', () => {
  // ถ้าด่านโยนข้อผิดพลาดออกมา ผู้ใช้จะไม่ได้รับคำตอบเลย
  // ซึ่งแย่กว่าการได้รับคำตอบที่ยังไม่ได้ตรวจ
  const code = loadNodeCode('Prepare LINE Reply');
  const $input = {
    first: () => ({
      json: { output: 'คำตอบปกติค่ะ', intermediateSteps: [{ observation: 'ไม่ใช่ JSON เลย' }] },
    }),
  };
  const $ = (name) =>
    ({
      first: () => ({
        json: {
          'Extract LINE Data': { replyToken: 'T', lineUserId: 'U', userMessage: 'x', receivedAt: Date.now() },
          'Upsert User': { id: 1 },
          'Build Context': { matchedKnowledge: 'x', knowledgeHits: 1, questionCategory: 'ทั่วไป' },
        }[name],
      }),
    });
  assert.doesNotThrow(() => new Function('$input', '$', '$env', code)($input, $, {}));
});
