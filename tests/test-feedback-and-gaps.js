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

test('FG-07 ปุ่มให้คะแนนต้องแนบไปกับคำตอบทั้งทาง reply และทาง push', () => {
  const code = โหนด('Prepare LINE Reply').parameters.jsCode;
  const จำนวน = (code.match(/quickReply: ปุ่มให้คะแนน/g) || []).length;
  assert.strictEqual(จำนวน, 2, 'ต้องแนบทั้ง linePayload และ pushPayload');
  assert.match(code, /label: 'ตรงคำถาม'/);
  assert.match(code, /label: 'ยังไม่ตรง'/);
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
