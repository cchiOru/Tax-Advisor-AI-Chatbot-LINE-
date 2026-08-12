'use strict';
/**
 * ============================================================================
 *  ตรวจสองเส้นทางที่ป้อนข้อมูลให้หน้าหลังบ้าน
 *    1. บันทึกคำสำคัญที่ค้นไม่เจอ ลงตาราง knowledge_gaps
 *    2. ปุ่มให้คะแนนคำตอบใน LINE บันทึกลงตาราง answer_feedback
 * ----------------------------------------------------------------------------
 *  ที่มาของชุดทดสอบนี้
 *
 *    ก่อนหน้านี้หน้าหลังบ้านสองหน้าคือความพึงพอใจกับความรู้ที่ยังขาด
 *    ไม่มีทางแสดงข้อมูลได้เลย เพราะไม่มีโหนดไหนเขียนลงสองตารางนั้น
 *    หน้าเว็บทำงานได้ปกติ ตารางว่างเปล่า และไม่มีอะไรฟ้องว่าผิด
 *    เป็นความผิดพลาดชนิดที่เงียบที่สุด คือทุกอย่างดูเหมือนทำงาน
 *
 *    ชุดนี้จึงตรวจตั้งแต่ว่ามีโหนดจริงไหม ต่อสายถูกไหม
 *    ไปจนถึงว่าโค้ดที่อยู่ในโหนดนั้นทำงานถูกต้องหรือเปล่า
 *
 *  สิ่งที่ชุดนี้ตรวจไม่ได้
 *    ตรวจไม่ได้ว่าคำสั่ง SQL รันกับ PostgreSQL จริงแล้วผ่าน
 *    เพราะไม่มีฐานข้อมูลตอนรันชุดทดสอบ
 *    ส่วนนั้นต้องยืนยันด้วย postgres/ตรวจ-เส้นทางข้อมูลหลังบ้าน.sql
 *
 *  วิธีรัน
 *    node --test tests/test-feedback-and-gaps.js
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, 'n8n', 'workflows', 'tax-advisor-workflow.json');
const wf = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));

function โหนด(ชื่อ) {
  const n = wf.nodes.find((x) => x.name === ชื่อ);
  assert.ok(n, `ไม่พบโหนดชื่อ "${ชื่อ}" ในไฟล์เวิร์กโฟลว์`);
  return n;
}

function ปลายทางของ(ชื่อ, สาย = 0) {
  const c = wf.connections[ชื่อ];
  if (!c || !c.main || !c.main[สาย]) return [];
  return c.main[สาย].map((x) => x.node);
}

// ---------------------------------------------------------------------------
//  เส้นทางที่ 1 บันทึกคำที่ค้นไม่เจอ
// ---------------------------------------------------------------------------

test('FG-01 ต้องมีโหนดบันทึกคำที่ค้นไม่เจอ และต่อจากโหนดเตรียมคำตอบ', () => {
  const n = โหนด('Log Knowledge Gap');
  assert.strictEqual(n.type, 'n8n-nodes-base.postgres');
  assert.ok(
    ปลายทางของ('Prepare LINE Reply').includes('Log Knowledge Gap'),
    'โหนดนี้ต้องต่อจาก Prepare LINE Reply ขนานกับการบันทึกบทสนทนา'
  );
  // ถ้าโหนดนี้พังแล้วทำให้ทั้งสายหยุด ผู้ใช้จะไม่ได้รับคำตอบเพราะเรื่องของผู้ดูแล
  assert.strictEqual(
    n.onError,
    'continueRegularOutput',
    'บันทึกไม่สำเร็จต้องไม่กระทบการตอบผู้ใช้'
  );
});

test('FG-02 คำสั่งบันทึกต้องไม่แทรกแถวเมื่อไม่มีคำที่ค้นไม่เจอ', () => {
  const sql = โหนด('Log Knowledge Gap').parameters.query;
  assert.match(sql, /WHERE \$1::varchar IS NOT NULL/,
    'ต้องมีเงื่อนไขกันไม่ให้แทรกแถวว่างเมื่อค้นเจอข้อมูลแล้ว');
  // เมื่อค่าที่ส่งมาเป็น null ล้วน PostgreSQL เดาชนิดข้อมูลไม่ได้ ต้องระบุชนิดไว้
  assert.match(sql, /\$1::varchar/, 'ต้องระบุชนิดข้อมูลของพารามิเตอร์');
  assert.match(sql, /ON CONFLICT \(keyword\) DO UPDATE/,
    'คำเดิมที่เจอซ้ำต้องเพิ่มตัวนับ ไม่ใช่แทรกแถวใหม่');
  assert.match(sql, /hit_count\s*=\s*knowledge_gaps\.hit_count \+ 1/);
});

test('FG-03 คำสั่งบันทึกช่องว่าง ต้องไม่แตะข้อมูลที่ระบุตัวผู้ใช้', () => {
  const n = โหนด('Log Knowledge Gap');
  const ทั้งโหนด = JSON.stringify(n);
  for (const ต้องห้าม of ['user_id', 'lineUserId', 'userMessage', 'line_user_id']) {
    assert.ok(
      !ทั้งโหนด.includes(ต้องห้าม),
      `โหนดนี้ต้องไม่อ้างถึง ${ต้องห้าม} เพราะจะทำให้ย้อนกลับไปหาว่าใครถามได้`
    );
  }
});

test('FG-04 คำที่ค้นไม่เจอต้องเป็นคำเดี่ยว ไม่ใช่ประโยคที่ผู้ใช้พิมพ์', () => {
  // โหนด Build Context เป็นคนหาคำนี้ จึงต้องตรวจที่ต้นทางด้วย
  // ถ้าวันหนึ่งมีคนเปลี่ยนให้ส่งทั้งประโยคมา ตารางจะกลายเป็นที่เก็บข้อความผู้ใช้ทันที
  const code = โหนด('Build Context').parameters.jsCode;
  assert.match(code, /missingKeyword = พบ\[0\] \|\| null/,
    'ต้องเลือกคำสำคัญคำเดียวจากรายการที่ดักได้ ไม่ใช่ส่งข้อความของผู้ใช้');
  assert.ok(
    !/missingKeyword\s*=\s*question/.test(code),
    'ห้ามกำหนดคำที่ค้นไม่เจอเป็นข้อความที่ผู้ใช้พิมพ์'
  );
});

// ---------------------------------------------------------------------------
//  เส้นทางที่ 2 ปุ่มให้คะแนนคำตอบ
// ---------------------------------------------------------------------------

/** รันโค้ดของโหนดแกะข้อมูลปุ่ม โดยจำลองสภาพแวดล้อมของ n8n */
function รันแกะข้อมูลปุ่ม(ข้อมูลปุ่ม, replyToken = 'TOKEN-FB') {
  const code = โหนด('Parse Feedback').parameters.jsCode;
  const $input = {
    first: () => ({
      json: { body: { events: [{ type: 'postback', replyToken, postback: { data: ข้อมูลปุ่ม } }] } },
    }),
  };
  const fn = new Function('$input', code);
  return fn($input)[0].json;
}

test('FG-05 เส้นทางปุ่มต้องแยกจากเส้นทางความยินยอม', () => {
  assert.deepStrictEqual(
    ปลายทางของ('Filter: Postback Event'),
    ['Check Postback Type'],
    'ทุก postback ต้องผ่านตัวแยกชนิดก่อน ไม่ใช่วิ่งเข้าบันทึกความยินยอมตรง ๆ'
  );
  assert.deepStrictEqual(ปลายทางของ('Check Postback Type', 0), ['Parse Feedback']);
  assert.deepStrictEqual(ปลายทางของ('Check Postback Type', 1), ['Save Consent']);
  assert.deepStrictEqual(ปลายทางของ('Parse Feedback'), ['Save Feedback']);
  assert.deepStrictEqual(ปลายทางของ('Save Feedback'), ['Send Feedback Thanks']);
});

test('FG-06 เงื่อนไขแยกชนิดปุ่ม ต้องดูจากคำขึ้นต้นของข้อมูล', () => {
  const c = โหนด('Check Postback Type').parameters.conditions.conditions[0];
  assert.strictEqual(c.rightValue, 'fb=');
  assert.strictEqual(c.operator.operation, 'startsWith');
  // ถ้าใช้ contains แทน startsWith ข้อมูลของปุ่มยินยอมที่บังเอิญมีตัวอักษรนี้จะหลุดเข้ามา
  assert.notStrictEqual(c.operator.operation, 'contains');
});

/** รันโค้ดโหนดเตรียมคำตอบ โดยกำหนดได้ว่ารอบนี้ถึงเวลาถามความเห็นหรือยัง */
function รันเตรียมคำตอบ(ถึงรอบถาม) {
  const code = โหนด('Prepare LINE Reply').parameters.jsCode;
  const ข้อมูลโหนด = {
    'Extract LINE Data': {
      replyToken: 'T', lineUserId: 'U1', userMessage: 'ลดหย่อนบุตร', receivedAt: Date.now() - 1000,
    },
    'Upsert User': { id: 9, ask_feedback: ถึงรอบถาม },
    'Build Context': { matchedKnowledge: 'x', knowledgeHits: 2, questionCategory: 'สิทธิ์ลดหย่อน' },
  };
  const เข้าถึงโหนด = (ชื่อ) => ({ first: () => ({ json: ข้อมูลโหนด[ชื่อ] }) });
  const $input = {
    first: () => ({
      json: {
        output:
          'ลดหย่อนบุตรคนละ 30,000 บาทต่อปีค่ะ ' +
          'ข้อมูลนี้เป็นคำแนะนำเบื้องต้น ควรตรวจสอบกับกรมสรรพากรอีกครั้ง',
      },
    }),
  };
  return new Function('$input', '$', '$env', code)($input, เข้าถึงโหนด, {})[0].json;
}

test('FG-07 ถึงรอบถามความเห็น ปุ่มต้องแนบทั้งทางReply และทาง push', () => {
  const r = รันเตรียมคำตอบ(true);
  const ทางReply = r.linePayload.messages[0];
  assert.ok(ทางReply.quickReply, 'ไม่มีปุ่มในข้อความที่ส่งทางReply');
  assert.deepStrictEqual(
    r.pushPayload.messages[0],
    ทางReply,
    'ข้อความที่ส่งสองทางต้องเหมือนกันทุกประการ'
  );
  const ป้าย = ทางReply.quickReply.items.map((i) => i.action.label);
  assert.deepStrictEqual(ป้าย, ['ตรงคำถาม', 'ยังไม่ตรง']);
});

test('FG-07ก ยังไม่ถึงรอบ ต้องไม่มีคีย์ quickReply เลย ไม่ใช่ใส่เป็นค่าว่าง', () => {
  // ถ้าใส่ quickReply เป็น null LINE จะปฏิเสธทั้งข้อความ
  // ผู้ใช้จะไม่ได้รับคำตอบเลย ซึ่งเสียหายกว่าการไม่ได้ถามความเห็นมาก
  for (const กรณี of [false, undefined]) {
    const m = รันเตรียมคำตอบ(กรณี).linePayload.messages[0];
    assert.ok(
      !Object.prototype.hasOwnProperty.call(m, 'quickReply'),
      `กรณี ask_feedback = ${กรณี} ยังมีคีย์ quickReply ติดมาด้วย`
    );
    assert.ok(m.text && m.text.length > 0, 'คำตอบต้องยังส่งถึงผู้ใช้ตามปกติ');
  }
});

test('FG-07ข ยังไม่ได้รัน migration 008 ต้องไม่ถามความเห็น แทนที่จะถามทุกครั้ง', () => {
  // คอลัมน์ยังไม่มี ค่าที่อ่านได้จะเป็น undefined
  // ต้องตีความว่าไม่ถาม ดีกว่ากลับไปถามทุกครั้งโดยไม่มีใครรู้ตัว
  const code = โหนด('Prepare LINE Reply').parameters.jsCode;
  assert.match(
    code,
    /ask_feedback === true/,
    'ต้องเทียบกับค่าจริงแบบเข้มงวด ไม่ใช่ใช้ค่าความจริงโดยปริยาย'
  );
});

test('FG-08 ป้ายปุ่มต้องไม่เกิน 20 ตัวอักษรตามข้อจำกัดของ LINE', () => {
  const code = โหนด('Prepare LINE Reply').parameters.jsCode;
  for (const m of code.matchAll(/label: '([^']+)'/g)) {
    assert.ok(m[1].length <= 20, `ป้าย "${m[1]}" ยาว ${m[1].length} ตัวอักษร เกินที่ LINE รับได้`);
  }
});

test('FG-09 แกะข้อมูลปุ่มได้ถูกต้องเมื่อค่าครบ', () => {
  const r = รันแกะข้อมูลปุ่ม('fb=1&c=2&h=3&t=2100');
  assert.strictEqual(r['ตรงคำถาม'], true);
  assert.strictEqual(r['จำนวนที่ค้นเจอ'], 3);
  assert.strictEqual(r['เวลาที่ใช้ตอบ'], 2100);
  assert.strictEqual(r.replyToken, 'TOKEN-FB');
  assert.ok(r['หมวด'], 'ต้องแปลลำดับหมวดกลับเป็นชื่อหมวดได้');
});

test('FG-10 กดว่ายังไม่ตรง ต้องบันทึกเป็นเท็จ ไม่ใช่ค่าว่าง', () => {
  const r = รันแกะข้อมูลปุ่ม('fb=0&c=0&h=0&t=800');
  assert.strictEqual(r['ตรงคำถาม'], false);
  assert.strictEqual(r['จำนวนที่ค้นเจอ'], 0, 'ค้นไม่เจอเลยคือศูนย์ ซึ่งเป็นข้อมูลที่ต้องเก็บ');
});

test('FG-11 ข้อมูลปุ่มที่ผิดรูป ต้องไม่ทำให้พัง และต้องไม่บันทึกตัวเลขมั่ว', () => {
  // ข้อมูลนี้มาจากฝั่งผู้ใช้ จึงต้องถือว่าอาจถูกแก้หรือถูกส่งมั่วได้เสมอ
  const กรณี = ['fb=1', 'fb=1&c=999&h=abc&t=-5', 'fb=x', '', 'fb=1&c=-1&h=&t='];
  for (const ข้อมูล of กรณี) {
    const r = รันแกะข้อมูลปุ่ม(ข้อมูล);
    assert.ok(typeof r['ตรงคำถาม'] === 'boolean', `${ข้อมูล} ต้องได้ค่าจริงหรือเท็จเสมอ`);
    for (const ช่อง of ['จำนวนที่ค้นเจอ', 'เวลาที่ใช้ตอบ']) {
      const v = r[ช่อง];
      assert.ok(
        v === null || (Number.isFinite(v) && v >= 0),
        `${ข้อมูล} ช่อง ${ช่อง} ได้ค่า ${v} ซึ่งไม่ควรเกิดขึ้น`
      );
    }
  }
  // ลำดับหมวดนอกช่วง ต้องกลายเป็นค่าว่าง ไม่ใช่ชื่อหมวดผิด ๆ
  assert.strictEqual(รันแกะข้อมูลปุ่ม('fb=1&c=999').หมวด, null);
  assert.strictEqual(รันแกะข้อมูลปุ่ม('fb=1&c=-1').หมวด, null);
});

test('FG-12 รายชื่อหมวดฝั่งส่งกับฝั่งรับ ต้องเป็นชุดเดียวกันและเรียงเหมือนกัน', () => {
  // ถ้าสองฝั่งเรียงต่างกันแม้ตำแหน่งเดียว คะแนนจะถูกบันทึกผิดหมวดทั้งหมด
  // โดยที่ระบบยังทำงานได้ปกติและไม่มีอะไรฟ้อง
  const ดึง = (ชื่อโหนด) => {
    const m = โหนด(ชื่อโหนด).parameters.jsCode.match(/const FEEDBACK_CATEGORIES = (\[[^\]]*\]);/);
    assert.ok(m, `หา FEEDBACK_CATEGORIES ในโหนด ${ชื่อโหนด} ไม่เจอ`);
    return JSON.parse(m[1]);
  };
  const ฝั่งส่ง = ดึง('Prepare LINE Reply');
  const ฝั่งรับ = ดึง('Parse Feedback');
  assert.deepStrictEqual(ฝั่งรับ, ฝั่งส่ง);
  assert.ok(ฝั่งส่ง.includes('อื่นๆ'), 'ต้องมีหมวดตั้งต้นสำหรับคำถามที่จำแนกไม่เข้าเกณฑ์ไหน');
});

test('FG-13 ทุกหมวดที่โหนด Build Context ตั้งได้ ต้องอยู่ในรายการหมวดของปุ่ม', () => {
  // ถ้าหมวดที่ตั้งได้จริงไม่อยู่ในรายการ indexOf จะคืน -1
  // แล้วคะแนนของหมวดนั้นจะถูกบันทึกเป็นค่าว่างทั้งหมดโดยไม่มีใครสังเกต
  const m = โหนด('Prepare LINE Reply').parameters.jsCode.match(
    /const FEEDBACK_CATEGORIES = (\[[^\]]*\]);/
  );
  const รายการ = JSON.parse(m[1]);
  const code = โหนด('Build Context').parameters.jsCode;
  const ที่ตั้งได้ = new Set();
  for (const x of code.matchAll(/questionCategory = '([^']+)'/g)) ที่ตั้งได้.add(x[1]);
  const กฎ = code.match(/const INTENT_RULES = (\[[\s\S]*?\]);/);
  if (กฎ) for (const r of JSON.parse(กฎ[1])) ที่ตั้งได้.add(r.category);

  const ขาด = [...ที่ตั้งได้].filter((c) => !รายการ.includes(c));
  assert.deepStrictEqual(ขาด, [], 'มีหมวดที่ระบบตั้งได้จริงแต่ไม่อยู่ในรายการของปุ่ม');
});

test('FG-14 การบันทึกคะแนนต้องไม่แตะข้อมูลที่ระบุตัวผู้ใช้และไม่เก็บคำตอบ', () => {
  const n = โหนด('Save Feedback');
  // ตัดชื่อตาราง answer_feedback ออกก่อน ไม่งั้นคำว่า answer ในชื่อตารางจะถูกนับเป็นการละเมิด
  const ทั้งโหนด = JSON.stringify(n).split('answer_feedback').join('«ตาราง»');
  for (const ต้องห้าม of ['user_id', 'lineUserId', 'userMessage', 'answer', 'line_user_id']) {
    assert.ok(!ทั้งโหนด.includes(ต้องห้าม), `โหนดบันทึกคะแนนต้องไม่อ้างถึง ${ต้องห้าม}`);
  }
  assert.match(
    n.parameters.query,
    /INSERT INTO answer_feedback\s*\n?\s*\(is_helpful, category, knowledge_hits, response_time_ms\)/,
    'ต้องบันทึกเฉพาะสี่ช่องนี้เท่านั้น'
  );
  // โค้ดที่แกะข้อมูลปุ่มก็ต้องไม่แตะรหัสผู้ใช้ที่ติดมากับเหตุการณ์
  assert.ok(
    !โหนด('Parse Feedback').parameters.jsCode.includes('source'),
    'โหนดแกะข้อมูลปุ่มต้องไม่อ่านฟิลด์ source ซึ่งมีรหัสผู้ใช้อยู่'
  );
});

test('FG-15 ข้อมูลที่แนบไปกับปุ่ม ต้องไม่ยาวเกินที่ LINE รับได้', () => {
  // LINE จำกัดข้อมูลใน postback ไว้ที่ 300 ตัวอักษร
  // นี่คือเหตุผลที่ส่งลำดับหมวดเป็นตัวเลข แทนที่จะส่งชื่อหมวดเป็นภาษาไทย
  const LINE_POSTBACK_MAX = 300;
  const ยาวสุด = 'fb=0&c=99&h=999&t=' + '9'.repeat(9);
  assert.ok(
    ยาวสุด.length <= LINE_POSTBACK_MAX,
    `ข้อมูลปุ่มกรณียาวที่สุดคือ ${ยาวสุด.length} ตัวอักษร`
  );
  // กันไม่ให้วันหลังมีคนเปลี่ยนไปส่งชื่อหมวดเป็นข้อความ
  const code = โหนด('Prepare LINE Reply').parameters.jsCode;
  assert.match(code, /'&c=' \+ เลขหมวด/, 'ต้องส่งลำดับหมวดเป็นตัวเลข ไม่ใช่ชื่อหมวด');
});

// ---------------------------------------------------------------------------
//  เส้นทางที่ 3 ดักคำทักทายก่อนเรียกแบบจำลองภาษา
// ---------------------------------------------------------------------------
//  พบตอนใช้งานจริง ผู้ใช้พิมพ์ว่า สวัสดีคับ
//  ระบบค้นฐานข้อมูล ประกอบบริบทราว 3,000 ตัวอักษร ส่งเข้าแบบจำลอง
//  แล้วตอบเรื่องอัตราภาษีตามมาตรา 48(1) กลับมา ทั้งที่ไม่มีใครถาม
//
//  ความเสี่ยงของการดักคือดักผิด ถ้าคำถามจริงถูกดัก
//  ผู้ใช้จะได้ข้อความทักทายกลับไปแทนคำตอบ ซึ่งแย่กว่าตอบยาวเกินไปมาก
//  ชุดนี้จึงยิงคำถามทางการทั้ง 115 ข้อเข้าไป เพื่อยืนยันว่าไม่มีข้อไหนถูกดัก
// ---------------------------------------------------------------------------

/** รันโค้ดของโหนดดักคำทักทาย โดยจำลองสภาพแวดล้อมของ n8n */
function รันดักคำทักทาย(ข้อความ) {
  const code = โหนด('Check Small Talk').parameters.jsCode;
  const เข้าถึงโหนด = () => ({
    first: () => ({ json: { userMessage: ข้อความ, replyToken: 'TOKEN-ST' } }),
  });
  return new Function('$json', '$', code)({}, เข้าถึงโหนด)[0].json;
}

test('FG-16 คำทักทายและคำขอบคุณ ต้องถูกดักไว้ทุกแบบ', () => {
  const ต้องดักได้ = [
    'สวัสดีคับ', 'สวัสดีครับ', 'สวัสดีค่ะ', 'หวัดดี', 'ดีครับ',
    'Hello', 'hi', 'ฮัลโหล',
    'ขอบคุณครับ', 'ขอบคุณมากค่ะ', 'ขอบใจ', 'thank you',
    'บายครับ', 'ลาก่อน', 'ทดสอบ', 'อยู่ไหมครับ',
  ];
  const หลุด = ต้องดักได้.filter((m) => !รันดักคำทักทาย(m)['เป็นคำทักทาย']);
  assert.deepStrictEqual(หลุด, [], 'ข้อความเหล่านี้ควรถูกดัก แต่หลุดไปเรียกแบบจำลอง');
});

test('FG-17 คำถามภาษีจริงทั้ง 115 ข้อ ต้องไม่ถูกดักแม้แต่ข้อเดียว', () => {
  const ดิบ = require(path.join(ROOT, 'evaluation', 'test-questions-official.json'));
  const คำถาม = Array.isArray(ดิบ) ? ดิบ : Object.values(ดิบ).find(Array.isArray);
  assert.ok(คำถาม && คำถาม.length >= 100, 'อ่านชุดคำถามทางการไม่ได้');

  const ถูกดัก = คำถาม
    .filter((q) => รันดักคำทักทาย(q.question)['เป็นคำทักทาย'])
    .map((q) => `${q.id} ${q.question}`);
  assert.deepStrictEqual(
    ถูกดัก,
    [],
    'คำถามจริงถูกดักเป็นคำทักทาย ผู้ใช้จะไม่ได้คำตอบ\n  ' + ถูกดัก.join('\n  ')
  );
});

test('FG-18 ทักทายแล้วถามต่อในประโยคเดียว ต้องไม่ถูกดัก', () => {
  // คนไทยทักทายนำหน้าคำถามเป็นเรื่องปกติ ถ้าดักตรงนี้ผิดจะเสียหายมาก
  const ต้องผ่านไปตอบ = [
    'สวัสดีครับ ลดหย่อนบุตรเท่าไหร่',
    'ขอบคุณครับ แล้วคู่สมรสล่ะ',
    'สวัสดี 2567 ยื่นเมื่อไหร่',
    'หวัดดีครับ อยากถามเรื่องประกันสังคม',
  ];
  const โดนดัก = ต้องผ่านไปตอบ.filter((m) => รันดักคำทักทาย(m)['เป็นคำทักทาย']);
  assert.deepStrictEqual(โดนดัก, [], 'ประโยคที่มีคำถามอยู่ด้วย ต้องถูกส่งไปตอบตามปกติ');
});

test('FG-19 คำทักทายต้องถูกดักก่อนทุกขั้นตอนที่มีค่าใช้จ่าย', () => {
  // ลำดับที่ถูกต้องคือ ดักคำทักทายก่อน แล้วจึงดึงโปรไฟล์และอัปเดตผู้ใช้
  //
  // ครั้งแรกวางตัวดักไว้หลัง Upsert User ซึ่งใช้งานจริงแล้วพบว่าผิด
  // เพราะตัวนับรอบถามความเห็นอยู่ในคำสั่งอัปเดตผู้ใช้
  // คำทักทายจึงกินรอบนั้นไป ทั้งที่ระบบไม่ได้ตอบอะไรให้ผู้ใช้ประเมิน
  // ผลคือทักทายหนึ่งครั้ง แล้วคำถามจริงข้อถัดไปไม่ถูกถามความเห็น
  assert.deepStrictEqual(
    ปลายทางของ('Check Consent Command', 1),
    ['Check Small Talk'],
    'ข้อความปกติต้องผ่านตัวดักคำทักทายก่อนถึงขั้นตอนอื่น'
  );
  assert.deepStrictEqual(ปลายทางของ('Check Small Talk'), ['Is Small Talk']);
  assert.deepStrictEqual(ปลายทางของ('Is Small Talk', 0), ['Send Small Talk Reply']);
  assert.deepStrictEqual(ปลายทางของ('Is Small Talk', 1), ['Get LINE Profile']);

  // ทางของคำทักทายต้องจบที่การส่งข้อความ ไม่ไหลต่อไปที่ไหนอีก
  assert.deepStrictEqual(ปลายทางของ('Send Small Talk Reply'), [],
    'ตอบคำทักทายแล้วต้องจบ ไม่ไหลต่อไปส่วนที่เสียโทเคน');
});

test('FG-19ก คำทักทายต้องไม่ไปแตะตัวนับรอบถามความเห็น', () => {
  // ตัวนับอยู่ในคำสั่งของโหนด Upsert User
  // จึงต้องแน่ใจว่าเส้นทางคำทักทายไม่ผ่านโหนดนั้นเลย
  const ที่เยี่ยม = new Set();
  const เดิน = (ชื่อ) => {
    if (ที่เยี่ยม.has(ชื่อ)) return;
    ที่เยี่ยม.add(ชื่อ);
    const c = wf.connections[ชื่อ];
    if (!c || !c.main) return;
    for (const สาย of c.main) for (const ป of สาย || []) เดิน(ป.node);
  };
  เดิน('Send Small Talk Reply');

  for (const ต้องไม่ผ่าน of ['Upsert User', 'Get LINE Profile', 'Search Tax Knowledge',
                             'AI Agent (Tax Advisor)', 'AI Agent (No Memory)']) {
    assert.ok(
      !ที่เยี่ยม.has(ต้องไม่ผ่าน),
      `เส้นทางคำทักทายไม่ควรไปถึงโหนด ${ต้องไม่ผ่าน}`
    );
  }
});

test('FG-20 ป้ายบนปุ่มตัวอย่างคำถาม ต้องไม่เกิน 20 ตัวอักษรตามข้อจำกัดของ LINE', () => {
  const r = รันดักคำทักทาย('สวัสดี');
  const items = r.linePayload.messages[0].quickReply.items;
  assert.ok(items.length >= 3, 'ควรมีตัวอย่างคำถามอย่างน้อยสามข้อ');
  for (const i of items) {
    assert.ok(
      i.action.label.length <= 20,
      `ป้าย "${i.action.label}" ยาว ${i.action.label.length} ตัวอักษร`
    );
    // ป้ายสั้นได้ แต่ข้อความที่ส่งจริงต้องเป็นคำถามเต็มที่ระบบตอบได้
    assert.ok(i.action.text.length >= i.action.label.length);
  }
});

test('FG-21 คำอำลากับคำทักทาย ต้องตอบคนละอย่าง', () => {
  const ทัก = รันดักคำทักทาย('สวัสดีครับ').linePayload.messages[0].text;
  const ลา = รันดักคำทักทาย('ขอบคุณครับ').linePayload.messages[0].text;
  assert.notStrictEqual(ทัก, ลา, 'ตอบคนบอกลาว่า ถามได้เลย จะดูไม่เข้าใจภาษาคน');
  assert.ok(ทัก.includes('คุณภาษี'), 'ข้อความทักทายควรแนะนำตัว');
});

test('FG-22 คำถามในปุ่มตัวอย่าง ห้ามมีตัวเลขที่เป็นข้อมูลส่วนตัวของผู้ใช้', () => {
  // ครั้งแรกเขียนปุ่มไว้ว่า "เงินเดือน 30,000 บาท เสียภาษีเท่าไหร่"
  // ผู้ใช้กดปุ่มเดียว ระบบคำนวณภาษีจากเงินเดือนที่ผู้ใช้ไม่เคยบอกทันที
  // แล้วตอบเป็นตัวเลขภาษีที่ดูน่าเชื่อถือ ซึ่งผู้ใช้อาจเข้าใจว่าเป็นของตัวเอง
  //
  // ระบบที่ตอบเรื่องเงินของคนอื่น ห้ามสมมติตัวเลขให้ผู้ใช้เด็ดขาด
  const items = รันดักคำทักทาย('สวัสดี').linePayload.messages[0].quickReply.items;
  for (const i of items) {
    assert.ok(
      !/[0-9๐-๙]/.test(i.action.text),
      `ปุ่ม "${i.action.label}" ส่งคำถามที่มีตัวเลข "${i.action.text}" ` +
        'ซึ่งเป็นการสมมติข้อมูลของผู้ใช้'
    );
  }
});
