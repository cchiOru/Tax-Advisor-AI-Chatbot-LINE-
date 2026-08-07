'use strict';
/**
 * ============================================================================
 *  ตรวจว่าระบบไม่เก็บข้อมูลของผู้ใช้ที่ไม่ได้ยินยอม
 * ----------------------------------------------------------------------------
 *  ทำไมต้องมีชุดทดสอบนี้
 *    การเก็บข้อมูลของคนที่ไม่ได้ยินยอมเป็นความผิดพลาดที่แก้ย้อนหลังไม่ได้
 *    ต่างจากคำตอบผิดที่ตอบใหม่ได้ ข้อมูลที่เก็บไปแล้วจะลบทีหลังก็สายไปแล้ว
 *    และเป็นความผิดพลาดที่มองไม่เห็นด้วย เพราะระบบยังทำงานปกติทุกอย่าง
 *
 *    ชุดทดสอบนี้จึงอ่านไฟล์ workflow ที่ใช้งานจริงมาตรวจโครงสร้างโดยตรง
 *    ไม่ได้ตรวจจากเอกสารหรือความจำ ถ้าใครแก้เวิร์กโฟลว์แล้วเผลอทำให้
 *    เส้นทางของคนที่ไม่ยินยอมไปเชื่อมกับหน่วยความจำหรือการบันทึก จะรู้ทันที
 *
 *  วิธีรัน
 *    node --test tests/test-consent-guard.js
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WF = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'n8n', 'workflows', 'tax-advisor-workflow.json'), 'utf8')
);
const nodeByName = (n) => WF.nodes.find((x) => x.name === n);
const conn = WF.connections;

// รวบรวมว่าโหนดปลายทางแต่ละตัวมีอะไรต่อเข้ามาบ้าง แยกตามชนิดการเชื่อม
function incoming(target) {
  const out = [];
  for (const [src, types] of Object.entries(conn)) {
    for (const [type, branches] of Object.entries(types)) {
      for (const branch of branches) {
        for (const item of branch) {
          if (item.node === target) out.push({ src, type });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
//  โครงสร้างของเส้นทางที่ไม่ยินยอม
// ---------------------------------------------------------------------------

test('CG-01 ต้องมีตัวแทนปัญญาประดิษฐ์แยกสำหรับผู้ที่ไม่ยินยอม', () => {
  assert.ok(nodeByName('AI Agent (No Memory)'), 'ไม่พบโหนด AI Agent (No Memory)');
  assert.ok(nodeByName('AI Agent (Tax Advisor)'), 'ไม่พบโหนด AI Agent (Tax Advisor)');
});

test('CG-02 ตัวแทนของผู้ที่ไม่ยินยอมต้องไม่ต่อกับหน่วยความจำเด็ดขาด', () => {
  const links = incoming('AI Agent (No Memory)').filter((x) => x.type === 'ai_memory');
  assert.strictEqual(
    links.length,
    0,
    `พบการเชื่อมหน่วยความจำเข้ากับเส้นทางที่ไม่ยินยอม: ${JSON.stringify(links)}`
  );
});

test('CG-03 ตัวแทนของผู้ที่ยินยอมต้องต่อกับหน่วยความจำ ไม่งั้นฟีเจอร์ที่สัญญาไว้จะไม่มีจริง', () => {
  const links = incoming('AI Agent (Tax Advisor)').filter((x) => x.type === 'ai_memory');
  assert.strictEqual(links.length, 1, 'เส้นทางที่ยินยอมต้องมีหน่วยความจำต่ออยู่หนึ่งตัว');
});

test('CG-04 ตัวแทนทั้งสองต้องใช้แบบจำลองและเครื่องมือชุดเดียวกัน คำตอบจึงจะเหมือนกัน', () => {
  const pick = (name) =>
    incoming(name)
      .filter((x) => x.type === 'ai_tool' || x.type === 'ai_languageModel')
      .map((x) => `${x.src}:${x.type}`)
      .sort();

  assert.deepStrictEqual(
    pick('AI Agent (No Memory)'),
    pick('AI Agent (Tax Advisor)'),
    'สองเส้นทางได้เครื่องมือไม่เท่ากัน ผู้ที่ไม่ยินยอมจะได้คำตอบด้อยกว่า ซึ่งเท่ากับบังคับให้ยินยอม'
  );
});

test('CG-05 ตัวแทนทั้งสองต้องใช้คำสั่งระบบเดียวกัน', () => {
  const a = nodeByName('AI Agent (Tax Advisor)').parameters.options.systemMessage;
  const b = nodeByName('AI Agent (No Memory)').parameters.options.systemMessage;
  assert.strictEqual(a, b);
});

// ---------------------------------------------------------------------------
//  การบันทึกบทสนทนา
// ---------------------------------------------------------------------------

test('CG-06 คำสั่งบันทึกบทสนทนาต้องมีเงื่อนไขตรวจความยินยอมอยู่ในตัวคำสั่งเอง', () => {
  const q = nodeByName('Log Conversation').parameters.query;
  assert.ok(
    /WHERE\s+\$9::text\s*=\s*'granted'/.test(q),
    'ไม่พบเงื่อนไขตรวจความยินยอมในคำสั่ง SQL ที่ใช้บันทึกบทสนทนา'
  );
});

test('CG-07 ค่าที่ส่งเข้าคำสั่งบันทึกต้องอ่านสถานะความยินยอมมาจากฐานข้อมูลจริง', () => {
  const r = nodeByName('Log Conversation').parameters.options.queryReplacement;
  assert.ok(
    r.includes("$('Upsert User').first().json.consent_status"),
    'ต้องอ่านสถานะจากผลของ Upsert User ไม่ใช่ค่าที่ตั้งไว้เอง'
  );
});

test('CG-08 คำสั่งบันทึกผู้ใช้ต้องคืนสถานะความยินยอมกลับมาด้วย ไม่งั้นด่านอื่นตรวจไม่ได้', () => {
  const q = nodeByName('Upsert User').parameters.query;
  assert.ok(/RETURNING[^;]*consent_status/.test(q));
});

// ---------------------------------------------------------------------------
//  การขอความยินยอมและการถอน
// ---------------------------------------------------------------------------

test('CG-09 ผู้ใช้ใหม่ต้องถูกตั้งเป็นยังไม่ตอบ ห้ามตั้งเป็นยินยอมอัตโนมัติ', () => {
  const q = nodeByName('Register User on Follow').parameters.query;
  assert.ok(q.includes("'pending'"), 'ต้องสร้างระเบียนด้วยสถานะ pending');
  assert.ok(!/VALUES[^;]*'granted'/.test(q), 'ห้ามตั้งเป็น granted ตอนสร้างระเบียน');
});

test('CG-10 ข้อความขอความยินยอมต้องบอกครบทั้งวัตถุประสงค์ ผลของการปฏิเสธ และวิธีถอน', () => {
  const body = nodeByName('Send Consent Request').parameters.jsonBody;
  const ต้องมี = [
    'จำบทสนทนาก่อนหน้า',      // วัตถุประสงค์ข้อหนึ่ง
    'ปรับปรุงคำตอบ',           // วัตถุประสงค์ข้อสอง
    'ชื่อบัญชี LINE',          // ขอบเขตข้อมูลที่เก็บ
    'ถ้าไม่ยินยอม',            // ผลของการปฏิเสธ
    'ลบข้อมูลของฉัน',          // วิธีถอนความยินยอม
  ];
  for (const คำ of ต้องมี) {
    assert.ok(body.includes(คำ), `ข้อความขอความยินยอมขาดเรื่อง "${คำ}"`);
  }
});

test('CG-11 ต้องมีปุ่มให้เลือกทั้งยินยอมและไม่ยินยอม ห้ามมีแต่ปุ่มยินยอม', () => {
  const body = nodeByName('Send Consent Request').parameters.jsonBody;
  assert.ok(body.includes("data: 'consent=granted'"));
  assert.ok(body.includes("data: 'consent=denied'"));
});

test('CG-12 การถอนความยินยอมต้องลบข้อมูลทั้งสองตาราง ไม่ใช่ตารางเดียว', () => {
  const q = nodeByName('Apply Consent Command').parameters.query;
  assert.ok(/DELETE FROM conversations/.test(q), 'ต้องลบประวัติที่เก็บไว้วิเคราะห์');
  assert.ok(/DELETE FROM n8n_chat_histories/.test(q), 'ต้องลบบทสนทนาที่ระบบจำไว้ด้วย');
});

test('CG-13 คำสั่งที่ผู้ใช้พิมพ์เพื่อจัดการข้อมูลต้องถูกดักก่อนส่งเข้าแบบจำลองภาษา', () => {
  const targets = (conn['Extract LINE Data'].main[0] || []).map((x) => x.node);
  assert.deepStrictEqual(
    targets,
    ['Check Consent Command'],
    'ข้อความต้องผ่านด่านตรวจคำสั่งก่อนเสมอ ไม่งั้นสิทธิถอนความยินยอมจะใช้ไม่ได้จริง'
  );

  const kws = nodeByName('Check Consent Command').parameters.conditions.conditions.map(
    (c) => c.rightValue
  );
  assert.ok(kws.includes('ลบข้อมูลของฉัน'), 'ต้องดักคำที่ประกาศไว้ในข้อความขอความยินยอม');
});

test('CG-14 เส้นทางของข้อความปกติต้องผ่านการตรวจความยินยอมก่อนถึงตัวแทนปัญญาประดิษฐ์', () => {
  const afterContext = (conn['Build Context'].main[0] || []).map((x) => x.node);
  assert.deepStrictEqual(afterContext, ['Check Consent']);

  const branches = conn['Check Consent'].main;
  assert.strictEqual(branches[0][0].node, 'AI Agent (Tax Advisor)', 'ทางจริงต้องไปตัวที่มีความจำ');
  assert.strictEqual(branches[1][0].node, 'AI Agent (No Memory)', 'ทางเท็จต้องไปตัวที่ไม่มีความจำ');
});

test('CG-15 เส้นทางเดิมของข้อความตัวอักษรต้องไม่ถูกแก้ให้เพี้ยน', () => {
  // การเพิ่มเรื่องความยินยอมไม่ควรไปกระทบเส้นทางที่ทำงานได้ดีอยู่แล้ว
  const f = nodeByName('Filter: Text Message Only').parameters.conditions.conditions;
  assert.strictEqual(f.length, 2, 'ตัวกรองเดิมต้องยังตรวจสองเงื่อนไขเหมือนเดิม');
  assert.ok(f.some((c) => c.rightValue === 'message'));
  assert.ok(f.some((c) => c.rightValue === 'text'));
});

// ---------------------------------------------------------------------------
//  กันไม่ให้แบบจำลองตั้งสมมติฐานเข้าข้างผู้ใช้เอง
// ---------------------------------------------------------------------------
//  พบจากการใช้งานจริง โจทย์บอกแค่ว่ามีบุตร 2 คน ไม่ได้บอกปีเกิด
//  แต่แบบจำลองเลือกกรณีที่ลดหย่อนได้มากที่สุดคือถือว่าบุตรคนที่สองเกิดตั้งแต่ปี 2561
//  ทำให้ตอบภาษี 11,600 บาท แทนที่จะเป็น 14,600 บาท ต่างกัน 3,000 บาท
//
//  ทิศทางของความผิดพลาดสำคัญกว่าขนาด
//  ผิดทางที่เสียภาษีเกินแก้ได้ด้วยการขอคืน
//  แต่ผิดทางที่ขาดจะถูกประเมินเพิ่มพร้อมเบี้ยปรับและเงินเพิ่มตามมาตรา 27
//  ระบบจึงต้องเลือกทางที่ระมัดระวังเสมอเมื่อโจทย์ไม่ได้ระบุ

test('CG-16 ช่องบุตรที่เกิดตั้งแต่ปี 2561 ต้องเตือนว่าห้ามใส่ถ้าโจทย์ไม่ได้บอกปีเกิด', () => {
  const schema = JSON.parse(nodeByName('Tax Calculator Tool').parameters.inputSchema);
  const d = schema.properties.allowances.properties.childrenBorn2561Plus.description;
  assert.ok(
    d.includes('ห้ามใส่') || d.includes('เฉพาะเมื่อ'),
    `คำอธิบายยังไม่ได้ห้ามการเดา: ${d}`
  );
});

test('CG-17 คำสั่งระบบต้องห้ามตั้งสมมติฐานที่ทำให้เสียภาษีน้อยลง', () => {
  const sm = nodeByName('AI Agent (Tax Advisor)').parameters.options.systemMessage;
  assert.ok(sm.includes('ห้ามตั้งสมมติฐาน'), 'ไม่พบกฎห้ามตั้งสมมติฐานในคำสั่งระบบ');
  assert.ok(sm.includes('ระมัดระวัง'), 'ต้องบอกให้ใช้ค่าที่ระมัดระวังที่สุด');
});

test('CG-18 ตัวแทนทั้งสองต้องได้กฎนี้เหมือนกัน ไม่ใช่ตัวเดียว', () => {
  const a = nodeByName('AI Agent (Tax Advisor)').parameters.options.systemMessage;
  const b = nodeByName('AI Agent (No Memory)').parameters.options.systemMessage;
  assert.strictEqual(a, b);
  assert.ok(b.includes('ห้ามตั้งสมมติฐาน'));
});

// ---------------------------------------------------------------------------
//  คำถามที่มีสองคำถามซ้อนกันในประโยคเดียว
// ---------------------------------------------------------------------------
//  พบจากการใช้งานจริง ผู้ใช้ถามว่า
//    "เงินเดือน 50,000 บาทต่อเดือน แล้วถ้ามีบุตรสองเกิดในปี 2547
//     ยังศึกษาอยู่ในมหาลัย ต้องเสียภาษีเท่าไหร่ ลดหย่อนได้มั้ย"
//
//  มีสองคำถามคือ เสียภาษีเท่าไหร่ กับ ลดหย่อนได้มั้ย
//  ระบบจัดหมวดได้หมวดเดียว จึงตอบแต่ตัวเลขแล้วข้ามคำถามเงื่อนไขไป
//  ตัวเลขถูกต้องทุกบรรทัด แต่ผู้ใช้ไม่ได้คำตอบที่ถามจริง ๆ
//  ทั้งที่ฐานความรู้มีเงื่อนไขอายุบุตรอยู่ครบ

test('CG-19 คำสั่งกำกับคำถามคำนวณต้องสั่งให้ตอบคำถามเชิงเงื่อนไขที่ปนมาด้วย', () => {
  const rules = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'n8n', 'intent-rules.json'), 'utf8')
  );
  const d = rules.calcDirective;
  assert.ok(d.includes('เชิงเงื่อนไข'), 'ไม่พบกฎเรื่องคำถามเชิงเงื่อนไขในคำสั่งกำกับ');
  assert.ok(d.includes('ลดหย่อนได้มั้ย'), 'ควรยกตัวอย่างคำถามเงื่อนไขที่พบบ่อย');
  assert.ok(d.includes('มาตรา'), 'ต้องสั่งให้อ้างเลขมาตราประกอบคำตอบเงื่อนไข');
});

test('CG-20 คำสั่งกำกับต้องยังบังคับเรียกเครื่องคำนวณเหมือนเดิม', () => {
  // การเพิ่มกฎใหม่ต้องไม่ไปเจือจางกฎเดิมที่สำคัญที่สุด
  const rules = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'n8n', 'intent-rules.json'), 'utf8')
  );
  assert.ok(rules.calcDirective.includes('ห้ามคิดเลขเอง'));
  assert.ok(rules.calcDirective.includes('เรียกเครื่องมือคำนวณก่อนตอบเสมอ'));
});

test('CG-21 คำสั่งระบบต้องสั่งให้บอกการตีความเมื่อโจทย์กำกวม', () => {
  const sm = nodeByName('AI Agent (Tax Advisor)').parameters.options.systemMessage;
  assert.ok(sm.includes('กำกวม'), 'ไม่พบกฎเรื่องโจทย์กำกวม');
  assert.ok(sm.includes('ตีความ'), 'ต้องสั่งให้บอกว่าตีความแบบไหน');
});
