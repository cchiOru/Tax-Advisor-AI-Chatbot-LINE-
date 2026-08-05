/**
 * ตรวจความครบถ้วนของฐานความรู้ — ไม่เรียก API ไม่มีค่าใช้จ่าย รันได้ทันทีทุกเมื่อ
 *
 * ตอบคำถามว่า "ฐานความรู้ครบมั้ย" ด้วยหลักฐาน 4 ชุด
 *   1. คำถามทดสอบข้อไหนค้นข้อมูลไม่เจอ หรือเจอน้อยเกินไป
 *   2. ข้อมูลรายการไหนในฐานที่ไม่เคยถูกค้นเจอเลย (ใส่ไว้แต่ไม่มีใครได้ใช้)
 *   3. คำสำคัญคู่ไหนที่ไม่เคยทำงาน (ตั้งไว้แต่ไม่มีคำถามไหนกระตุ้น)
 *   4. หัวข้อภาษีที่คนถามบ่อยแต่ยังไม่มีในฐานความรู้
 *
 * ใช้ตรรกะการสืบค้นชุดเดียวกับที่รันจริง โดย require มาจาก run-accuracy-test.js
 * ผลที่ได้จึงสะท้อนระบบจริง ไม่ใช่การจำลองแยกต่างหาก
 *
 * รันด้วย: node evaluation/check-knowledge-coverage.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadProductionConfig, loadKnowledgeBase, retrieve } = require('./run-accuracy-test');

const line = (c = '=') => c.repeat(78);

// ---------------------------------------------------------------------------
// หัวข้อที่ผู้เสียภาษีถามบ่อย ใช้ตรวจว่าฐานความรู้มีครอบคลุมหรือยัง
// อ้างอิงจากหมวดคำถามที่พบในหน้าคำถามพบบ่อยของกรมสรรพากรและขอบเขตของระบบ
// ---------------------------------------------------------------------------
const COMMON_TOPICS = [
  { topic: 'อัตราภาษีขั้นบันได', probe: 'อัตราภาษีเงินได้บุคคลธรรมดาเท่าไหร่' },
  { topic: 'ค่าลดหย่อนส่วนตัว', probe: 'ค่าลดหย่อนส่วนตัวเท่าไหร่' },
  { topic: 'ค่าลดหย่อนคู่สมรส', probe: 'มีคู่สมรสลดหย่อนได้เท่าไหร่' },
  { topic: 'ค่าลดหย่อนบุตร', probe: 'มีบุตรลดหย่อนได้เท่าไหร่' },
  { topic: 'ค่าลดหย่อนบิดามารดา', probe: 'เลี้ยงดูบิดามารดาลดหย่อนเท่าไหร่' },
  { topic: 'ประกันชีวิต', probe: 'ประกันชีวิตลดหย่อนได้เท่าไหร่' },
  { topic: 'ประกันสุขภาพ', probe: 'ประกันสุขภาพลดหย่อนได้เท่าไหร่' },
  { topic: 'ประกันสังคม', probe: 'ประกันสังคมลดหย่อนได้เท่าไหร่' },
  { topic: 'กองทุน RMF', probe: 'RMF ลดหย่อนได้เท่าไหร่' },
  { topic: 'กองทุน SSF', probe: 'SSF ลดหย่อนได้เท่าไหร่' },
  { topic: 'กองทุนสำรองเลี้ยงชีพ', probe: 'กองทุนสำรองเลี้ยงชีพลดหย่อนเท่าไหร่' },
  { topic: 'ดอกเบี้ยเงินกู้ซื้อบ้าน', probe: 'ดอกเบี้ยบ้านลดหย่อนได้เท่าไหร่' },
  { topic: 'เงินบริจาค', probe: 'บริจาคลดหย่อนได้เท่าไหร่' },
  { topic: 'บริจาคเพื่อการศึกษา', probe: 'บริจาคเพื่อการศึกษาลดหย่อนเท่าไหร่' },
  { topic: 'ค่าใช้จ่ายเงินเดือน 50% ไม่เกิน 100,000', probe: 'หักค่าใช้จ่ายเงินเดือนได้เท่าไหร่' },
  { topic: 'เงินได้ 40(2) รับจ้างทำของ', probe: 'รับจ้างทำของหักค่าใช้จ่ายเท่าไหร่' },
  { topic: 'เงินได้ค่าเช่า', probe: 'ค่าเช่าบ้านหักค่าใช้จ่ายเท่าไหร่' },
  { topic: 'เงินได้จากธุรกิจ', probe: 'ทำธุรกิจส่วนตัวเสียภาษียังไง' },
  { topic: 'กำหนดเวลายื่น ภ.ง.ด.90/91', probe: 'ต้องยื่นภาษีภายในเมื่อไหร่' },
  { topic: 'ยื่นครึ่งปี ภ.ง.ด.94', probe: 'ภ.ง.ด.94 ยื่นเมื่อไหร่' },
  { topic: 'ยื่นออนไลน์', probe: 'ยื่นภาษีออนไลน์ได้ถึงเมื่อไหร่' },
  { topic: 'เกณฑ์รายได้ที่ต้องยื่น', probe: 'รายได้เท่าไหร่ต้องยื่นภาษี' },
  { topic: 'เงินเพิ่มและค่าปรับ', probe: 'ยื่นภาษีช้าเสียค่าปรับเท่าไหร่' },
  { topic: 'เพดานเงินเพิ่มตาม ม.27', probe: 'เงินเพิ่มคิดสูงสุดเท่าไหร่' },
  { topic: 'ภาษีหัก ณ ที่จ่ายและการขอคืน', probe: 'ขอคืนภาษีหัก ณ ที่จ่ายยังไง' },
  { topic: 'เงินได้จากต่างประเทศ', probe: 'มีรายได้จากต่างประเทศต้องเสียภาษีมั้ย' },
  { topic: 'เงินได้ที่ได้รับยกเว้น', probe: 'เงินได้อะไรบ้างที่ได้รับยกเว้นภาษี' },
  { topic: 'ภาษีขั้นต่ำ 0.5% ตาม ม.48(2)', probe: 'ภาษีขั้นต่ำร้อยละ 0.5 คืออะไร' },
  { topic: 'ผู้สูงอายุ 65 ปีขึ้นไป', probe: 'อายุ 65 ปีได้รับยกเว้นภาษีเท่าไหร่' },
  { topic: 'ค่าลดหย่อนผู้พิการ', probe: 'ผู้พิการลดหย่อนได้เท่าไหร่' },
  // หัวข้อที่เพิ่มพร้อมฐานความรู้ชุดที่ 3
  { topic: 'ประเภทเงินได้ 8 ประเภท', probe: 'เงินได้พึงประเมินมีกี่ประเภท' },
  { topic: 'ค่าลิขสิทธิ์ 40(3)', probe: 'ค่าลิขสิทธิ์หักค่าใช้จ่ายได้เท่าไหร่' },
  { topic: 'ดอกเบี้ยเงินฝากและเงินปันผล', probe: 'ดอกเบี้ยเงินฝากต้องเสียภาษีไหม' },
  { topic: 'สิทธิผู้สูงอายุ 65 ปี', probe: 'อายุ 65 ปีได้รับยกเว้นภาษีเท่าไหร่' },
  { topic: 'การผ่อนชำระภาษี', probe: 'จ่ายภาษีไม่ไหวขอผ่อนชำระได้ไหม' },
  { topic: 'สามีภริยายื่นรวมหรือแยก', probe: 'สามีภริยาควรยื่นภาษีรวมหรือแยก' },
  { topic: 'ลำดับการหักลดหย่อน', probe: 'ลำดับการหักค่าลดหย่อนเป็นอย่างไร' },
  { topic: 'ภาษีมูลค่าเพิ่ม', probe: 'ต้องจดทะเบียนภาษีมูลค่าเพิ่มเมื่อไหร่' },
  { topic: 'ภาษีธุรกิจเฉพาะ', probe: 'ขายอสังหาริมทรัพย์เสียภาษีธุรกิจเฉพาะเท่าไหร่' },
  { topic: 'ภาษีเงินได้นิติบุคคล', probe: 'บริษัทเสียภาษีเงินได้นิติบุคคลอัตราเท่าไหร่' },
  { topic: 'ภาษีที่ดินและสิ่งปลูกสร้าง', probe: 'ภาษีที่ดินและสิ่งปลูกสร้างคิดอย่างไร' },
  { topic: 'ภาษีป้าย', probe: 'ป้ายร้านต้องเสียภาษีป้ายไหม' },
  { topic: 'อากรแสตมป์', probe: 'สัญญาเช่าต้องติดอากรแสตมป์ไหม' },
  { topic: 'ภาษีมรดก', probe: 'รับมรดกต้องเสียภาษีมรดกเท่าไหร่' },
  { topic: 'ภาษีสรรพสามิตและศุลกากร', probe: 'ภาษีสรรพสามิตเก็บจากอะไรบ้าง' },
  { topic: 'ภาพรวมระบบภาษีไทย', probe: 'ประเทศไทยมีภาษีอะไรบ้าง' },
];

function main() {
  const cfg = loadProductionConfig();
  const kb = loadKnowledgeBase();
  const dataset = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'test-questions-official.json'), 'utf8')
  );
  const questions = dataset.questions;

  console.log(line());
  console.log('  ตรวจความครบถ้วนของฐานความรู้ (ไม่เรียก API)');
  console.log(line());
  console.log(`ข้อมูลในฐานความรู้ : ${kb.length} รายการ`);
  console.log(`คำสำคัญที่ตั้งไว้   : ${cfg.keywordMap.length} คู่`);
  console.log(`คำถามที่ใช้ตรวจ    : ${questions.length} ข้อ\n`);

  // -------------------------------------------------------------------------
  // 1. คำถามทดสอบข้อไหนค้นไม่เจอ
  // -------------------------------------------------------------------------
  const usedTitles = new Set();
  const perQuestion = questions.map((q) => {
    const r = retrieve(q.question, cfg.keywordMap, kb);
    r.titles.forEach((t) => usedTitles.add(t));
    return { id: q.id, category: q.category, question: q.question, hits: r.hits, titles: r.titles };
  });

  const zero = perQuestion.filter((r) => r.hits === 0);
  const thin = perQuestion.filter((r) => r.hits === 1);
  const full = perQuestion.filter((r) => r.hits >= 2);

  console.log(line('-'));
  console.log('  1. ผลการค้นของคำถามทดสอบ');
  console.log(line('-'));
  console.log(`  ค้นเจอ 3 แหล่ง (ดี)        : ${perQuestion.filter((r) => r.hits >= 3).length} ข้อ`);
  console.log(`  ค้นเจอ 2 แหล่ง             : ${full.length - perQuestion.filter((r) => r.hits >= 3).length} ข้อ`);
  console.log(`  ค้นเจอ 1 แหล่ง (บาง)       : ${thin.length} ข้อ`);
  console.log(`  ค้นไม่เจอเลย (ช่องโหว่)     : ${zero.length} ข้อ`);

  if (zero.length) {
    console.log('\n  คำถามที่ค้นไม่เจอเลย — ระบบจะตอบจากความรู้ทั่วไป ตรวจสอบย้อนกลับไม่ได้');
    for (const r of zero) console.log(`    ${r.id} [${r.category}] ${r.question.slice(0, 55)}`);
  }
  if (thin.length) {
    console.log('\n  คำถามที่ค้นเจอแหล่งเดียว — เสี่ยงตอบไม่ครบถ้วน');
    for (const r of thin) console.log(`    ${r.id} [${r.category}] ${r.titles[0]}`);
  }

  // -------------------------------------------------------------------------
  // 1ข. ตรวจว่าข้อมูลที่ค้นมา "มีคำตอบอยู่จริง" หรือแค่เกี่ยวข้องกว้าง ๆ
  // -------------------------------------------------------------------------
  // การค้นเจอไม่เท่ากับค้นเจอของที่ใช้ได้ เพราะการให้คะแนนใช้การจับคู่คำ
  // จึงอาจคืนรายการที่เกี่ยวข้องห่าง ๆ มาได้ ส่วนนี้ตรวจเข้มกว่า
  // โดยดูว่าคำตอบที่ถูกต้อง (เช่น "60,000") ปรากฏอยู่ในข้อมูลที่ค้นมาหรือไม่
  // ถ้าไม่ปรากฏ แปลว่าแบบจำลองต้องตอบจากความรู้ในตัวเอง ไม่ใช่จากฐานความรู้ของเรา
  const kwQuestions = questions.filter((q) => q.check === 'keywords' && Array.isArray(q.expected));
  const answered = [];
  const notAnswered = [];
  for (const q of kwQuestions) {
    const r = retrieve(q.question, cfg.keywordMap, kb);
    const missingTerms = q.expected.filter((t) => r.context.indexOf(t) < 0);
    if (missingTerms.length === 0) answered.push(q);
    else notAnswered.push({ q, missingTerms, titles: r.titles });
  }

  console.log('\n' + line('-'));
  console.log('  1ข. ข้อมูลที่ค้นมา "มีคำตอบอยู่จริง" หรือไม่');
  console.log(line('-'));
  const answerRate = kwQuestions.length ? (answered.length / kwQuestions.length) * 100 : 0;
  console.log(`  ตรวจจากคำถามเชิงความรู้ ${kwQuestions.length} ข้อ (ไม่รวมข้อที่ต้องคำนวณ)`);
  console.log(`  ฐานความรู้มีคำตอบให้ : ${answerRate.toFixed(1)}%  (${answered.length}/${kwQuestions.length})`);
  if (notAnswered.length) {
    console.log('\n  ข้อที่ค้นเจอข้อมูล แต่ข้อมูลนั้นไม่มีคำตอบอยู่');
    console.log('  (แบบจำลองต้องเดาเอง ตรวจสอบย้อนกลับไปยังตัวบทไม่ได้ — นี่คือช่องโหว่จริง)');
    for (const n of notAnswered) {
      console.log(`    ${n.q.id} [${n.q.category}] ขาดข้อมูล: ${n.missingTerms.join(', ')}`);
      console.log(`         ค้นเจอแต่: ${n.titles.join(' | ') || '(ไม่เจอเลย)'}`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. ข้อมูลที่ไม่เคยถูกค้นเจอ
  // -------------------------------------------------------------------------
  const dead = kb.filter((r) => !usedTitles.has(r.title));
  console.log('\n' + line('-'));
  console.log('  2. ข้อมูลที่ไม่เคยถูกค้นเจอจากคำถามทดสอบ');
  console.log(line('-'));
  if (dead.length === 0) {
    console.log('  ไม่มี ทุกรายการถูกใช้งานอย่างน้อยหนึ่งครั้ง');
  } else {
    console.log(`  ${dead.length} จาก ${kb.length} รายการ`);
    console.log('  (ไม่ได้แปลว่าข้อมูลไม่ดี อาจเป็นเพราะชุดคำถามยังไม่ครอบคลุมเรื่องนั้น)');
    for (const r of dead) console.log(`    [${r.category}] ${r.title}`);
  }

  // -------------------------------------------------------------------------
  // 3. คำสำคัญที่ไม่เคยทำงาน
  // -------------------------------------------------------------------------
  const allText = questions.map((q) => q.question.toLowerCase()).join(' ');
  const unusedKw = cfg.keywordMap.filter(([trigger]) => allText.indexOf(trigger) < 0);
  console.log('\n' + line('-'));
  console.log('  3. คำสำคัญที่ไม่มีคำถามทดสอบข้อไหนกระตุ้น');
  console.log(line('-'));
  console.log(`  ${unusedKw.length} จาก ${cfg.keywordMap.length} คู่`);
  console.log('  หมายถึงคำเหล่านี้ยังไม่เคยถูกทดสอบว่าทำงานถูกต้องหรือไม่');
  const preview = unusedKw.slice(0, 30).map(([t]) => t).join(', ');
  if (preview) console.log(`  ตัวอย่าง: ${preview}${unusedKw.length > 30 ? ' ...' : ''}`);

  // -------------------------------------------------------------------------
  // 4. หัวข้อที่คนถามบ่อย ยังขาดอะไรบ้าง
  // -------------------------------------------------------------------------
  console.log('\n' + line('-'));
  console.log('  4. หัวข้อที่ผู้เสียภาษีถามบ่อย — มีข้อมูลรองรับหรือยัง');
  console.log(line('-'));
  const missing = [];
  const weak = [];
  for (const t of COMMON_TOPICS) {
    const r = retrieve(t.probe, cfg.keywordMap, kb);
    if (r.hits === 0) missing.push(t);
    else if (r.hits === 1) weak.push({ ...t, title: r.titles[0] });
  }
  console.log(`  มีข้อมูลรองรับดี : ${COMMON_TOPICS.length - missing.length - weak.length} จาก ${COMMON_TOPICS.length} หัวข้อ`);
  console.log(`  รองรับแบบบาง     : ${weak.length} หัวข้อ`);
  console.log(`  ยังไม่มีเลย       : ${missing.length} หัวข้อ`);

  if (missing.length) {
    console.log('\n  หัวข้อที่ยังไม่มีข้อมูลรองรับ (ควรเพิ่มก่อนเปิดใช้จริง)');
    for (const t of missing) console.log(`    - ${t.topic}`);
  }
  if (weak.length) {
    console.log('\n  หัวข้อที่มีข้อมูลแต่บาง (เจอแหล่งเดียว)');
    for (const t of weak) console.log(`    - ${t.topic}  →  ${t.title}`);
  }

  // -------------------------------------------------------------------------
  // สรุป
  // -------------------------------------------------------------------------
  const coverage = ((COMMON_TOPICS.length - missing.length) / COMMON_TOPICS.length) * 100;
  const testCoverage = ((questions.length - zero.length) / questions.length) * 100;
  console.log('\n' + line());
  console.log('  สรุป');
  console.log(line());
  console.log(`  ค้นเจอข้อมูล (เกณฑ์หลวม)   : ${testCoverage.toFixed(1)}%`);
  console.log(`  ข้อมูลมีคำตอบจริง (เกณฑ์เข้ม) : ${answerRate.toFixed(1)}%   ← ตัวเลขที่ควรใช้ตัดสิน`);
  console.log(`  ครอบคลุมหัวข้อที่ถามบ่อย   : ${coverage.toFixed(1)}%`);
  console.log('');
  if (missing.length === 0 && zero.length === 0 && notAnswered.length === 0) {
    console.log('  ฐานความรู้ครอบคลุมพอสำหรับขอบเขตที่กำหนดไว้');
  } else {
    console.log(`  ยังมีช่องโหว่ ${missing.length + zero.length + notAnswered.length} จุด`);
    console.log('  วิธีอุด: เพิ่มข้อมูลใน postgres/seed-tax-law-extra.sql');
    console.log('           แล้วนำเข้าฐานข้อมูล และเพิ่มคำสำคัญใน n8n/build-workflow.py ถ้าจำเป็น');
  }
}

main();
