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
function runPrepareReply({ output, questionCategory = 'คำนวณภาษี', error = false, upsertFailed = false }) {
  const nodeData = {
    'Extract LINE Data': {
      replyToken: 'TOKEN-TEST',
      userMessage: 'คำถามทดสอบ',
      receivedAt: Date.now() - 1234,
    },
    // เมื่อโหนด Upsert User ล้มเหลว n8n จะส่งรายการที่มีแต่ฟิลด์ error ต่อมา ไม่มี id
    'Upsert User': upsertFailed ? { error: 'connection refused' } : { id: 99 },
    'Build Context': {
      matchedKnowledge: 'หัวข้อทดสอบ',
      knowledgeHits: 1,
      questionCategory,
    },
  };

  const $input = { first: () => ({ json: { output, error } }) };
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
