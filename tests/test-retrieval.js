'use strict';
/**
 * ============================================================================
 *  ตรวจว่าข้อมูลที่ระบบค้นเจอ "มีคำตอบอยู่จริง" ก่อนส่งให้แบบจำลอง
 * ----------------------------------------------------------------------------
 *  ทำไมต้องมีชุดทดสอบนี้
 *
 *    เวลาระบบตอบผิด สาเหตุเป็นไปได้สองอย่างซึ่งต้องแก้คนละวิธี
 *      1. ค้นข้อมูลมาผิด แบบจำลองไม่เคยเห็นคำตอบเลย  ต้องแก้ที่การค้นหรือฐานข้อมูล
 *      2. ค้นมาถูกแล้ว แต่แบบจำลองอ่านแล้วตอบไม่ครบ    ต้องแก้ที่คำสั่งระบบ
 *    การวัดผลด้วยการเรียกแบบจำลองจริงบอกได้แค่ว่า "ผิด" แต่ไม่บอกว่าผิดเพราะอะไร
 *
 *    ชุดทดสอบนี้ตรวจเฉพาะขั้นตอนค้นข้อมูล ไม่เรียกแบบจำลองเลย
 *    จึงรันได้ในไม่กี่วินาที ไม่เสียโควตา และให้ผลเหมือนเดิมทุกครั้ง
 *    ถ้าข้อไหนไม่ผ่าน แปลว่าเป็นสาเหตุแบบที่ 1 แน่นอน
 *
 *  ที่มาจากของจริง
 *    การวัดผลรอบที่ 7 หลังขยายฐานข้อมูลเป็น 97 รายการ ได้ 99.1% ตกไปหนึ่งข้อ
 *      Q18 "ซื้อกองทุน SSF ลดหย่อนได้สูงสุดเท่าไหร่"  ขาดเลข 200,000
 *
 *    ไล่ดูแล้วพบว่าการจัดอันดับไม่ได้ผิด รายการที่มีคำตอบติดอันดับ 3 อยู่แล้ว
 *      อันดับ 1  กองทุนการออมแห่งชาติ      765 ตัวอักษร   ไม่มีคำตอบ
 *      อันดับ 2  เงินสมทบประกันสังคม     2,678 ตัวอักษร   ไม่มีคำตอบ
 *      อันดับ 3  กองทุนเพื่อการเกษียณ      902 ตัวอักษร   คำตอบอยู่ตรงนี้
 *    แต่วิธีคุมขนาดบริบทแบบเดิมคือตัดรายการท้ายสุดออกทีละรายการ
 *    จึงตัดอันดับ 3 ทิ้งก่อน แล้วยังเกินงบ จึงตัดอันดับ 2 ทิ้งอีก
 *    สุดท้ายเหลือแต่อันดับ 1 ที่ไม่มีคำตอบ
 *
 *    รายการยาวรายการเดียวตรงกลางจึงเบียดรายการที่มีคำตอบตกไป
 *    แก้โดยเปลี่ยนเป็นไล่ตามอันดับแล้วหยิบเฉพาะรายการที่ยังใส่ลงในงบได้
 *
 *  วิธีรัน
 *    node --test tests/test-retrieval.js
 * ============================================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const harness = require('../evaluation/run-accuracy-test.js');
const RULES = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'n8n', 'intent-rules.json'), 'utf8')
);
const DATASET = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'evaluation', 'test-questions-official.json'), 'utf8')
);

const kb = harness.loadKnowledgeBase();
const cfg = harness.loadProductionConfig();

/** จำลองการจำแนกหมวดแบบเดียวกับโหนด Build Context เพื่อเลือกงบบริบทให้ตรงกัน */
function needsCalc(question) {
  const q = (question || '').toLowerCase();
  const hasDigit = /[0-9๐-๙]/.test(q);
  const digitsAreAgeOnly = !/[0-9๐-๙]/.test(q.replace(/[0-9๐-๙,]+\s*ปี/g, ''));
  const moneyWords = RULES.incomeWords.concat(['บาท']);
  const looksLikeAge = hasDigit && digitsAreAgeOnly && !moneyWords.some((w) => q.indexOf(w) >= 0);

  for (const rule of RULES.intentRules) {
    if (rule.requireDigit && (!hasDigit || looksLikeAge)) continue;
    if (rule.keywords.some((k) => q.indexOf(k) >= 0)) {
      return RULES.calcCategories.indexOf(rule.category) >= 0;
    }
  }
  if (hasDigit && RULES.incomeWords.some((k) => q.indexOf(k) >= 0)) return true;
  return false;
}

function contextFor(question) {
  const calc = needsCalc(question);
  return harness.retrieve(question, cfg.keywordMap, kb, calc ? 2 : 3, calc).context;
}

// ---------------------------------------------------------------------------
//  กรณีที่เคยพลาดจริง
// ---------------------------------------------------------------------------

test('RT-01 คำถาม SSF ต้องได้บริบทที่มีทั้งเพดาน 200,000 และเงื่อนไข 30%', () => {
  const c = contextFor('ซื้อกองทุน SSF ลดหย่อนได้สูงสุดเท่าไหร่');
  assert.ok(c.includes('200,000'), 'บริบทไม่มีเลข 200,000 นี่คือบั๊กเดิมของรอบที่ 7');
  assert.ok(/30%|ร้อยละ 30|30 ของ/.test(c), 'บริบทไม่มีเงื่อนไขร้อยละ 30');
});

test('RT-02 คำถามอายุ 65 ปีต้องไม่ถูกจัดเป็นคำถามคำนวณ', () => {
  // เลข 65 คืออายุ ไม่ใช่จำนวนเงิน ถ้าถูกจัดเป็นคำนวณจะได้งบบริบทที่เล็กกว่า
  // แล้วรายการที่มีคำตอบจะถูกตัดทิ้ง
  assert.strictEqual(needsCalc('อายุ 65 ปีขึ้นไปได้รับยกเว้นเงินได้เท่าไหร่'), false);
  const c = contextFor('อายุ 65 ปีขึ้นไปได้รับยกเว้นเงินได้เท่าไหร่');
  assert.ok(c.includes('190,000'), 'บริบทไม่มีเลข 190,000');
});

test('RT-03 คำถามที่มีจำนวนเงินจริงต้องยังถูกจัดเป็นคำถามคำนวณเหมือนเดิม', () => {
  // กันไม่ให้กฎเรื่องอายุไปดักกว้างจนคำถามคำนวณหลุด
  const ต้องเป็นคำนวณ = [
    'เงินเดือน 50,000 บาทต่อเดือน ต้องเสียภาษีเท่าไหร่',
    'เงินเดือน 30,000 ทำงานมา 10 ปี ต้องเสียภาษีเท่าไหร่',
    'บุตรเกิดปี 2547 เงินเดือน 50,000 ต้องเสียภาษีเท่าไหร่',
    'ยื่นภาษีช้า 12 เดือน ต้องเสียค่าปรับเท่าไหร่',
  ];
  for (const q of ต้องเป็นคำนวณ) {
    assert.strictEqual(needsCalc(q), true, `"${q}" ควรเป็นคำถามคำนวณ`);
  }
});

// ---------------------------------------------------------------------------
//  ตรวจทั้งชุดคำถาม
// ---------------------------------------------------------------------------

test('RT-04 ทุกคำถามที่ตรวจด้วยคำสำคัญ ต้องมีคำตอบอยู่ในบริบทที่ค้นเจอ', () => {
  const ขาด = [];
  for (const q of DATASET.questions) {
    if (q.check !== 'keywords' || q.requiresTool) continue;
    const c = contextFor(q.question);
    const miss = q.expected.filter((e) => {
      const any = Array.isArray(e) ? e : [e];
      return !any.some((x) => c.includes(String(x)));
    });
    if (miss.length) ขาด.push(`${q.id} ขาด ${JSON.stringify(miss)}  "${q.question.slice(0, 45)}"`);
  }
  assert.deepStrictEqual(
    ขาด,
    [],
    'มีคำถามที่บริบทไม่มีคำตอบอยู่เลย แบบจำลองจึงต้องเดาเอง\n  ' + ขาด.join('\n  ')
  );
});

test('RT-05 บริบทต้องไม่เกินงบที่ตั้งไว้ ไม่งั้นข้อมูลนำเข้าจะล้นหน้าต่างบริบท', () => {
  const เกิน = [];
  for (const q of DATASET.questions) {
    const c = contextFor(q.question);
    const งบ = needsCalc(q.question) ? 1200 : 3000;
    // ยอมให้เกินได้เฉพาะกรณีที่เหลือรายการเดียวแล้วยังยาวเกิน ซึ่งตัดต่อไม่ได้
    const รายการเดียว = c.indexOf('[2]') < 0;
    if (c.length > งบ && !รายการเดียว) เกิน.push(`${q.id} ยาว ${c.length} เกินงบ ${งบ}`);
  }
  assert.deepStrictEqual(เกิน, [], เกิน.join('\n  '));
});

test('RT-06 ต้องไม่มีคำถามไหนค้นแล้วไม่เจออะไรเลย', () => {
  const ไม่เจอ = DATASET.questions
    .filter((q) => contextFor(q.question).startsWith('ไม่พบข้อมูล'))
    .map((q) => `${q.id} "${q.question.slice(0, 45)}"`);
  assert.deepStrictEqual(ไม่เจอ, [], ไม่เจอ.join('\n  '));
});
