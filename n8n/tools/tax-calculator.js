'use strict';
/**
 * ============================================================================
 *  เครื่องคำนวณภาษีเงินได้บุคคลธรรมดา (Thai Personal Income Tax Calculator)
 * ----------------------------------------------------------------------------
 *  ใช้เป็น Tool ให้ AI Agent เรียกใช้ แทนการให้แบบจำลองภาษาคำนวณเลขเอง
 *  เหตุผลเชิงวิธีวิจัย: ผลลัพธ์จากแบบจำลองภาษาไม่คงที่ (non-deterministic)
 *  จึงไม่สามารถอ้างอิงความถูกต้องได้ในเชิงวิชาการ การย้ายการคำนวณมาอยู่ในโค้ด
 *  ทำให้ผลลัพธ์ตรวจสอบซ้ำได้ (reproducible) และทดสอบด้วย unit test ได้
 *
 *  ฐานอ้างอิงทางกฎหมาย:
 *    - ประมวลรัษฎากร มาตรา 40      : ประเภทเงินได้พึงประเมิน 8 ประเภท
 *    - ประมวลรัษฎากร มาตรา 42 ทวิ  : การหักค่าใช้จ่ายเงินได้ 40(1)(2) รวมกันไม่เกิน 100,000
 *    - ประมวลรัษฎากร มาตรา 47      : ค่าลดหย่อน
 *    - ประมวลรัษฎากร มาตรา 48(1)   : การคำนวณภาษีตามอัตราก้าวหน้า
 *    - ประมวลรัษฎากร มาตรา 48(2)   : การคำนวณภาษีขั้นต่ำ 0.5% ของเงินได้ 40(2)-(8)
 *    - พระราชกฤษฎีกา (ฉบับที่ 480) : ยกเว้นภาษีตามวิธี 48(2) หากคำนวณได้ไม่เกิน 5,000 บาท
 *
 *  ปีภาษีอ้างอิง: 2567
 *  หมายเหตุ: อัตราและเพดานค่าลดหย่อนเปลี่ยนแปลงได้ตามประกาศกรมสรรพากรแต่ละปี
 *           ก่อนนำไปใช้จริงควรตรวจสอบกับ https://www.rd.go.th/ ทุกครั้ง
 * ============================================================================
 */

const TAX_YEAR = 2567;

/** อัตราภาษีเงินได้บุคคลธรรมดาแบบขั้นบันได (ประมวลรัษฎากร มาตรา 48(1)) */
const TAX_BRACKETS = [
  { min: 0, max: 150000, rate: 0.0 },
  { min: 150000, max: 300000, rate: 0.05 },
  { min: 300000, max: 500000, rate: 0.1 },
  { min: 500000, max: 750000, rate: 0.15 },
  { min: 750000, max: 1000000, rate: 0.2 },
  { min: 1000000, max: 2000000, rate: 0.25 },
  { min: 2000000, max: 5000000, rate: 0.3 },
  { min: 5000000, max: Infinity, rate: 0.35 },
];

/** เพดานค่าลดหย่อนและค่าคงที่อื่นๆ ปีภาษี 2567 */
const LIMITS = {
  PERSONAL: 60000,
  SPOUSE: 60000,
  CHILD: 30000,
  CHILD_BORN_2561_PLUS: 60000,
  PARENT_EACH: 30000,
  PARENT_MAX_COUNT: 4,
  DISABLED_CARE_EACH: 60000,

  LIFE_INSURANCE: 100000,
  HEALTH_INSURANCE: 25000,
  LIFE_HEALTH_COMBINED: 100000,
  PARENT_HEALTH_INSURANCE: 15000,

  SOCIAL_SECURITY: 9000,

  RMF_RATE: 0.3,
  RMF_MAX: 500000,
  SSF_RATE: 0.3,
  SSF_MAX: 200000,
  PVD_RATE: 0.15,
  PVD_MAX: 500000,
  PENSION_INSURANCE_RATE: 0.15,
  PENSION_INSURANCE_MAX: 200000,
  NSF_MAX: 30000,
  /** กลุ่มกองทุนเพื่อการเกษียณรวมกันทั้งหมดต้องไม่เกิน 500,000 บาท */
  RETIREMENT_COMBINED_MAX: 500000,

  HOME_LOAN_INTEREST: 100000,
  DONATION_RATE: 0.1,
  EASY_E_RECEIPT: 50000,

  /** มาตรา 48(2): เงินได้ 40(2)-(8) ตั้งแต่ 120,000 บาทขึ้นไป ต้องคำนวณภาษีขั้นต่ำ 0.5% */
  MIN_TAX_THRESHOLD: 120000,
  MIN_TAX_RATE: 0.005,
  /** พ.ร.ฎ. 480: ยกเว้นหากภาษีตามวิธีนี้ไม่เกิน 5,000 บาท */
  MIN_TAX_EXEMPT: 5000,
};

/**
 * อัตราการหักค่าใช้จ่ายแบบเหมาตามประเภทเงินได้
 * group: 'salaryHire' หมายถึงต้องนำมารวมกันก่อนคิดเพดาน (มาตรา 42 ทวิ)
 */
const EXPENSE_RULES = {
  salary: { section: '40(1)', label: 'เงินเดือน ค่าจ้าง', rate: 0.5, cap: 100000, group: 'salaryHire' },
  hire: { section: '40(2)', label: 'รับจ้างทำของ ค่านายหน้า ฟรีแลนซ์', rate: 0.5, cap: 100000, group: 'salaryHire' },
  royalty: { section: '40(3)', label: 'ค่าลิขสิทธิ์ สิทธิบัตร', rate: 0.5, cap: 100000 },
  interestDividend: { section: '40(4)', label: 'ดอกเบี้ย เงินปันผล', rate: 0, cap: 0 },
  rent: { section: '40(5)', label: 'ค่าเช่าทรัพย์สิน', rate: 0.3, cap: Infinity },
  profession: { section: '40(6)', label: 'วิชาชีพอิสระ', rate: 0.3, cap: Infinity },
  contractor: { section: '40(7)', label: 'รับเหมาก่อสร้าง', rate: 0.6, cap: Infinity },
  business: { section: '40(8)', label: 'ธุรกิจ การค้า อื่นๆ', rate: 0.6, cap: Infinity },
};

/** อัตราหักค่าใช้จ่ายค่าเช่าตามชนิดทรัพย์สิน (มาตรา 40(5)) */
const RENT_RATES = {
  building: 0.3,
  agriculturalLand: 0.2,
  otherLand: 0.15,
  vehicle: 0.3,
  other: 0.1,
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const round2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

/**
 * คำนวณภาษีตามอัตราก้าวหน้า พร้อมรายละเอียดแต่ละขั้น
 * @param {number} netIncome เงินได้สุทธิ
 */
function calcProgressiveTax(netIncome) {
  let tax = 0;
  const breakdown = [];

  for (const b of TAX_BRACKETS) {
    if (netIncome <= b.min) break;
    const taxableInBracket = Math.min(netIncome, b.max) - b.min;
    if (taxableInBracket <= 0) continue;
    const taxInBracket = taxableInBracket * b.rate;
    tax += taxInBracket;
    breakdown.push({
      ช่วงเงินได้: b.max === Infinity
        ? `${(b.min + 1).toLocaleString('en-US')} บาทขึ้นไป`
        : `${(b.min + 1).toLocaleString('en-US')} - ${b.max.toLocaleString('en-US')} บาท`,
      อัตรา: `${(b.rate * 100).toFixed(0)}%`,
      เงินได้ในขั้นนี้: round2(taxableInBracket),
      ภาษีในขั้นนี้: round2(taxInBracket),
    });
  }

  return { tax: round2(tax), breakdown };
}

/** คำนวณค่าใช้จ่ายที่หักได้ตามประเภทเงินได้ (มาตรา 42 ทวิ) */
function calcExpenses(income, options) {
  const details = [];
  let total = 0;

  // 40(1) + 40(2) ต้องรวมกันก่อน แล้วจึงคิดเพดาน 100,000 บาท (มาตรา 42 ทวิ)
  const salaryHireIncome = num(income.salary) + num(income.hire);
  if (salaryHireIncome > 0) {
    const deduction = Math.min(salaryHireIncome * 0.5, 100000);
    total += deduction;
    details.push({
      ประเภทเงินได้: '40(1)+40(2) เงินเดือน/รับจ้าง',
      เงินได้: round2(salaryHireIncome),
      อัตราหัก: '50% (เพดานรวม 100,000 บาท)',
      หักได้: round2(deduction),
    });
  }

  const simple = ['royalty', 'interestDividend', 'contractor', 'business'];
  for (const key of simple) {
    const amount = num(income[key]);
    if (amount <= 0) continue;
    const rule = EXPENSE_RULES[key];
    const deduction = Math.min(amount * rule.rate, rule.cap);
    total += deduction;
    details.push({
      ประเภทเงินได้: `${rule.section} ${rule.label}`,
      เงินได้: round2(amount),
      อัตราหัก: rule.cap === Infinity
        ? `${rule.rate * 100}%`
        : `${rule.rate * 100}% (เพดาน ${rule.cap.toLocaleString('en-US')} บาท)`,
      หักได้: round2(deduction),
    });
  }

  // 40(5) ค่าเช่า — อัตราขึ้นกับชนิดทรัพย์สิน
  const rentIncome = num(income.rent);
  if (rentIncome > 0) {
    const rentType = options.rentType && RENT_RATES[options.rentType] !== undefined
      ? options.rentType
      : 'building';
    const rate = RENT_RATES[rentType];
    const deduction = rentIncome * rate;
    total += deduction;
    details.push({
      ประเภทเงินได้: `40(5) ค่าเช่า (${rentType})`,
      เงินได้: round2(rentIncome),
      อัตราหัก: `${rate * 100}%`,
      หักได้: round2(deduction),
    });
  }

  // 40(6) วิชาชีพอิสระ — แพทย์หักได้ 60% วิชาชีพอื่นหักได้ 30%
  const professionIncome = num(income.profession);
  if (professionIncome > 0) {
    const rate = options.professionType === 'medical' ? 0.6 : 0.3;
    const deduction = professionIncome * rate;
    total += deduction;
    details.push({
      ประเภทเงินได้: `40(6) วิชาชีพอิสระ${options.professionType === 'medical' ? ' (ประกอบโรคศิลปะ)' : ''}`,
      เงินได้: round2(professionIncome),
      อัตราหัก: `${rate * 100}%`,
      หักได้: round2(deduction),
    });
  }

  return { total: round2(total), details };
}

/** คำนวณค่าลดหย่อน (ยังไม่รวมเงินบริจาค ซึ่งต้องคำนวณทีหลังเพราะอิงฐาน 10%) */
function calcAllowances(a, grossIncome) {
  const details = [];
  let total = 0;
  const add = (label, amount, note) => {
    if (amount <= 0) return;
    total += amount;
    details.push({ รายการ: label, จำนวน: round2(amount), หมายเหตุ: note || '' });
  };

  add('ค่าลดหย่อนส่วนตัว', LIMITS.PERSONAL);

  if (a.spouse === true || a.spouse === 'true') {
    add('ค่าลดหย่อนคู่สมรส (ไม่มีเงินได้)', LIMITS.SPOUSE);
  }

  const children = num(a.children);
  if (children > 0) add(`ค่าลดหย่อนบุตร ${children} คน`, children * LIMITS.CHILD, '30,000 บาท/คน');

  const children2561 = num(a.childrenBorn2561Plus);
  if (children2561 > 0) {
    add(
      `ค่าลดหย่อนบุตรคนที่ 2 ขึ้นไป (เกิดตั้งแต่ปี 2561) ${children2561} คน`,
      children2561 * LIMITS.CHILD_BORN_2561_PLUS,
      '60,000 บาท/คน'
    );
  }

  const parents = Math.min(num(a.parents), LIMITS.PARENT_MAX_COUNT);
  if (parents > 0) {
    add(`ค่าลดหย่อนบิดามารดา ${parents} คน`, parents * LIMITS.PARENT_EACH, 'อายุ 60 ปีขึ้นไป สูงสุด 4 คน');
  }

  const disabled = num(a.disabledCare);
  if (disabled > 0) {
    add(`ค่าลดหย่อนอุปการะผู้พิการ/ทุพพลภาพ ${disabled} คน`, disabled * LIMITS.DISABLED_CARE_EACH, '60,000 บาท/คน');
  }

  // ประกันชีวิต + ประกันสุขภาพตนเอง รวมกันไม่เกิน 100,000 บาท
  const life = Math.min(num(a.lifeInsurance), LIMITS.LIFE_INSURANCE);
  const health = Math.min(num(a.healthInsurance), LIMITS.HEALTH_INSURANCE);
  const lifeHealth = Math.min(life + health, LIMITS.LIFE_HEALTH_COMBINED);
  if (lifeHealth > 0) {
    add('เบี้ยประกันชีวิตและประกันสุขภาพตนเอง', lifeHealth, 'ประกันสุขภาพไม่เกิน 25,000 รวมกันไม่เกิน 100,000 บาท');
  }

  const parentHealth = Math.min(num(a.parentHealthInsurance), LIMITS.PARENT_HEALTH_INSURANCE);
  if (parentHealth > 0) add('เบี้ยประกันสุขภาพบิดามารดา', parentHealth, 'ไม่เกิน 15,000 บาท');

  const sso = Math.min(num(a.socialSecurity), LIMITS.SOCIAL_SECURITY);
  if (sso > 0) add('เงินสมทบกองทุนประกันสังคม', sso, 'ไม่เกิน 9,000 บาท');

  // ---- กลุ่มกองทุนเพื่อการเกษียณ: จำกัดรายกอง แล้วจำกัดรวมกันอีกชั้นที่ 500,000 ----
  const retirementItems = [];
  const pushRetirement = (label, raw, cap, note) => {
    const capped = Math.min(num(raw), cap);
    if (capped > 0) retirementItems.push({ label, amount: capped, note });
  };

  pushRetirement('กองทุน RMF', a.rmf, Math.min(grossIncome * LIMITS.RMF_RATE, LIMITS.RMF_MAX), 'ไม่เกิน 30% ของเงินได้ และไม่เกิน 500,000 บาท');
  pushRetirement('กองทุน SSF', a.ssf, Math.min(grossIncome * LIMITS.SSF_RATE, LIMITS.SSF_MAX), 'ไม่เกิน 30% ของเงินได้ และไม่เกิน 200,000 บาท');
  pushRetirement('กองทุนสำรองเลี้ยงชีพ/กบข.', a.pvd, Math.min(grossIncome * LIMITS.PVD_RATE, LIMITS.PVD_MAX), 'ไม่เกิน 15% ของเงินได้ และไม่เกิน 500,000 บาท');
  pushRetirement('เบี้ยประกันชีวิตแบบบำนาญ', a.pensionInsurance, Math.min(grossIncome * LIMITS.PENSION_INSURANCE_RATE, LIMITS.PENSION_INSURANCE_MAX), 'ไม่เกิน 15% ของเงินได้ และไม่เกิน 200,000 บาท');
  pushRetirement('กองทุนการออมแห่งชาติ (กอช.)', a.nsf, LIMITS.NSF_MAX, 'ไม่เกิน 30,000 บาท');

  const retirementRaw = retirementItems.reduce((s, i) => s + i.amount, 0);
  const retirementAllowed = Math.min(retirementRaw, LIMITS.RETIREMENT_COMBINED_MAX);
  const retirementScale = retirementRaw > 0 ? retirementAllowed / retirementRaw : 0;

  for (const item of retirementItems) {
    add(item.label, round2(item.amount * retirementScale), item.note);
  }
  const retirementCapApplied = retirementRaw > LIMITS.RETIREMENT_COMBINED_MAX;

  const homeLoan = Math.min(num(a.homeLoanInterest), LIMITS.HOME_LOAN_INTEREST);
  if (homeLoan > 0) add('ดอกเบี้ยเงินกู้ยืมเพื่อที่อยู่อาศัย', homeLoan, 'ไม่เกิน 100,000 บาท');

  const easyReceipt = Math.min(num(a.easyEReceipt), LIMITS.EASY_E_RECEIPT);
  if (easyReceipt > 0) add('Easy E-Receipt', easyReceipt, 'ไม่เกิน 50,000 บาท');

  return {
    total: round2(total),
    details,
    notes: retirementCapApplied
      ? ['กองทุนเพื่อการเกษียณรวมกันเกิน 500,000 บาท ระบบปรับลดตามสัดส่วนให้อยู่ในเพดานแล้ว']
      : [],
  };
}

/**
 * คำนวณเงินบริจาค
 * ลำดับตามกฎหมาย: บริจาคการศึกษา/กีฬา/โรงพยาบาลรัฐ หักได้ 2 เท่า (ไม่เกิน 10% ของฐาน)
 * จากนั้นบริจาคทั่วไป หักได้ตามจ่ายจริง (รวมกับข้างต้นไม่เกิน 10% ของฐาน)
 */
function calcDonations(a, baseIncome) {
  const cap = baseIncome * LIMITS.DONATION_RATE;
  const details = [];

  const eduRaw = num(a.donationEducation) * 2;
  const edu = Math.min(eduRaw, cap);
  if (edu > 0) {
    details.push({
      รายการ: 'เงินบริจาคเพื่อการศึกษา/กีฬา/โรงพยาบาลรัฐ (หัก 2 เท่า)',
      จำนวน: round2(edu),
      หมายเหตุ: `เพดาน 10% ของเงินได้หลังหักค่าใช้จ่ายและค่าลดหย่อน (${round2(cap).toLocaleString('en-US')} บาท)`,
    });
  }

  const generalCapRemaining = Math.max(cap - edu, 0);
  const general = Math.min(num(a.donationGeneral), generalCapRemaining);
  if (general > 0) {
    details.push({
      รายการ: 'เงินบริจาคทั่วไป',
      จำนวน: round2(general),
      หมายเหตุ: 'รวมกับบริจาค 2 เท่าแล้วไม่เกิน 10% ของฐาน',
    });
  }

  return { total: round2(edu + general), details };
}

/**
 * คำนวณภาษีเงินได้บุคคลธรรมดา
 *
 * @param {object} input
 * @param {object} input.income      เงินได้พึงประเมินแยกตามมาตรา 40(1)-(8)
 * @param {object} [input.allowances] ค่าลดหย่อน
 * @param {object} [input.options]    ตัวเลือกเพิ่มเติม (rentType, professionType)
 * @param {number} [input.withholdingTax] ภาษีหัก ณ ที่จ่ายที่ถูกหักไว้แล้วทั้งปี
 * @returns {object} ผลการคำนวณพร้อมขั้นตอนโดยละเอียด
 */
function calculateThaiPIT(input) {
  const data = input && typeof input === 'object' ? input : {};
  const income = data.income && typeof data.income === 'object' ? data.income : {};
  const allowances = data.allowances && typeof data.allowances === 'object' ? data.allowances : {};
  const options = data.options && typeof data.options === 'object' ? data.options : {};

  // ---- ขั้นที่ 1: เงินได้พึงประเมินรวม ----
  const incomeKeys = Object.keys(EXPENSE_RULES);
  const grossIncome = incomeKeys.reduce((sum, k) => sum + num(income[k]), 0);

  if (grossIncome <= 0) {
    return {
      สำเร็จ: false,
      ข้อผิดพลาด: 'ไม่พบข้อมูลเงินได้ กรุณาระบุเงินได้อย่างน้อย 1 ประเภท เช่น salary (เงินเดือนทั้งปี)',
      ปีภาษี: TAX_YEAR,
    };
  }

  // ---- ขั้นที่ 2: หักค่าใช้จ่าย ----
  const expenses = calcExpenses(income, options);
  const incomeAfterExpense = round2(grossIncome - expenses.total);

  // ---- ขั้นที่ 3: หักค่าลดหย่อน (ยังไม่รวมบริจาค) ----
  const allowanceResult = calcAllowances(allowances, grossIncome);
  const baseForDonation = Math.max(round2(incomeAfterExpense - allowanceResult.total), 0);

  // ---- ขั้นที่ 4: หักเงินบริจาค (ฐาน 10% คำนวณจากยอดหลังหักค่าใช้จ่ายและค่าลดหย่อน) ----
  const donations = calcDonations(allowances, baseForDonation);

  // ---- ขั้นที่ 5: เงินได้สุทธิ ----
  const netIncome = Math.max(round2(baseForDonation - donations.total), 0);

  // ---- ขั้นที่ 6: คำนวณภาษีตามอัตราก้าวหน้า (มาตรา 48(1)) ----
  const progressive = calcProgressiveTax(netIncome);

  // ---- ขั้นที่ 7: ตรวจสอบภาษีขั้นต่ำตามมาตรา 48(2) ----
  // ใช้เฉพาะเงินได้ประเภท 40(2)-(8) เท่านั้น (ไม่รวมเงินเดือน 40(1))
  const incomeForMinTax = grossIncome - num(income.salary);
  let minTax = 0;
  let minTaxApplied = false;
  let minTaxNote = '';

  if (incomeForMinTax >= LIMITS.MIN_TAX_THRESHOLD) {
    const computed = round2(incomeForMinTax * LIMITS.MIN_TAX_RATE);
    if (computed <= LIMITS.MIN_TAX_EXEMPT) {
      minTaxNote = `ภาษีขั้นต่ำตามมาตรา 48(2) คำนวณได้ ${computed.toLocaleString('en-US')} บาท ซึ่งไม่เกิน 5,000 บาท จึงได้รับยกเว้น`;
    } else {
      minTax = computed;
      if (minTax > progressive.tax) {
        minTaxApplied = true;
        minTaxNote = `เงินได้ประเภท 40(2)-(8) รวม ${incomeForMinTax.toLocaleString('en-US')} บาท ต้องคำนวณภาษีขั้นต่ำ 0.5% = ${minTax.toLocaleString('en-US')} บาท ซึ่งสูงกว่าวิธีอัตราก้าวหน้า จึงต้องเสียตามวิธีนี้`;
      } else {
        minTaxNote = `ภาษีขั้นต่ำตามมาตรา 48(2) = ${minTax.toLocaleString('en-US')} บาท ไม่สูงกว่าวิธีอัตราก้าวหน้า จึงใช้วิธีอัตราก้าวหน้า`;
      }
    }
  }

  const taxPayable = round2(Math.max(progressive.tax, minTaxApplied ? minTax : 0));

  // ---- ขั้นที่ 8: หักภาษีหัก ณ ที่จ่าย ----
  const withholding = num(data.withholdingTax);
  const balance = round2(taxPayable - withholding);

  return {
    สำเร็จ: true,
    ปีภาษี: TAX_YEAR,
    สรุป: {
      เงินได้พึงประเมินรวม: round2(grossIncome),
      หักค่าใช้จ่าย: expenses.total,
      เงินได้หลังหักค่าใช้จ่าย: incomeAfterExpense,
      หักค่าลดหย่อน: allowanceResult.total,
      หักเงินบริจาค: donations.total,
      เงินได้สุทธิ: netIncome,
      ภาษีที่ต้องชำระ: taxPayable,
      ภาษีหักณที่จ่าย: round2(withholding),
      ...(balance >= 0
        ? { ต้องชำระเพิ่ม: balance }
        : { ขอคืนภาษีได้: round2(Math.abs(balance)) }),
    },
    รายละเอียดค่าใช้จ่าย: expenses.details,
    รายละเอียดค่าลดหย่อน: allowanceResult.details,
    รายละเอียดเงินบริจาค: donations.details,
    ขั้นบันไดภาษี: progressive.breakdown,
    ภาษีตามอัตราก้าวหน้า: progressive.tax,
    ...(minTaxNote ? { หมายเหตุมาตรา48_2: minTaxNote } : {}),
    ...(allowanceResult.notes.length ? { หมายเหตุเพิ่มเติม: allowanceResult.notes } : {}),
    คำเตือน:
      'ผลการคำนวณนี้เป็นการประมาณการเบื้องต้นตามข้อมูลที่ผู้ใช้ให้มา ' +
      'อ้างอิงอัตราและค่าลดหย่อนปีภาษี 2567 ' +
      'กรณีมีเงินได้หลายประเภทหรือใช้สิทธิพิเศษอื่น ควรตรวจสอบกับกรมสรรพากร (www.rd.go.th) หรือผู้เชี่ยวชาญด้านภาษี',
  };
}

/**
 * ============================================================================
 *  คำนวณเงินเพิ่มและค่าปรับกรณียื่นแบบแสดงรายการภาษีล่าช้า
 * ----------------------------------------------------------------------------
 *  ฐานอ้างอิงทางกฎหมาย:
 *    - ประมวลรัษฎากร มาตรา 27 : เงินเพิ่มร้อยละ 1.5 ต่อเดือนหรือเศษของเดือน
 *                               ของเงินภาษีที่ต้องเสีย
 *                               "แต่ต้องไม่เกินจำนวนภาษีที่ต้องเสีย"
 *    - ประมวลรัษฎากร มาตรา 35 : ไม่ยื่นรายการภายในกำหนด ระวางโทษปรับไม่เกิน 2,000 บาท
 *
 *  ข้อควรทราบ:
 *    จำนวนค่าปรับตามมาตรา 35 เป็นอำนาจเปรียบเทียบปรับของเจ้าพนักงาน
 *    แนวปฏิบัติที่ใช้กันทั่วไปคือ ยื่นเกินกำหนดไม่เกิน 7 วัน ปรับ 1,000 บาท
 *    เกิน 7 วัน ปรับ 2,000 บาท ระบบใช้ค่านี้เป็นค่าตั้งต้น
 *    ผลลัพธ์จึงเป็นการประมาณการ ต้องตรวจสอบกับสำนักงานสรรพากรพื้นที่อีกครั้ง
 *
 *  จุดที่มักคำนวณผิด: เศษของเดือนนับเป็นหนึ่งเดือนเต็ม และเงินเพิ่มมีเพดาน
 *  เท่ากับจำนวนภาษีที่ต้องเสีย ซึ่งหลายแหล่งข้อมูลไม่ได้ระบุไว้
 * ============================================================================
 */

const PENALTY = {
  SURCHARGE_RATE_PER_MONTH: 0.015, // มาตรา 27 ร้อยละ 1.5 ต่อเดือน
  FINE_WITHIN_7_DAYS: 1000,
  FINE_OVER_7_DAYS: 2000,
  FINE_MAX: 2000, // มาตรา 35 ปรับไม่เกิน 2,000 บาท
};

/**
 * @param {object} input
 * @param {number} input.taxDue      ภาษีที่ต้องชำระ (บาท)
 * @param {number} [input.monthsLate] จำนวนเดือนที่ล่าช้า เศษของเดือนนับเป็น 1 เดือนเต็ม
 * @param {number} [input.daysLate]   จำนวนวันที่ล่าช้า ใช้แทน monthsLate ได้
 */
function calculateLatePenalty(input) {
  const data = input && typeof input === 'object' ? input : {};
  const taxDue = num(data.taxDue);

  // รับได้ทั้งจำนวนเดือนและจำนวนวัน ถ้าให้มาเป็นวันจะแปลงเป็นเดือนโดยปัดขึ้น
  let monthsLate = 0;
  let daysLate = num(data.daysLate);
  if (data.monthsLate !== undefined && num(data.monthsLate) > 0) {
    monthsLate = Math.ceil(num(data.monthsLate));
    if (!daysLate) daysLate = monthsLate * 30;
  } else if (daysLate > 0) {
    monthsLate = Math.ceil(daysLate / 30);
  }

  if (monthsLate <= 0 && daysLate <= 0) {
    return {
      สำเร็จ: false,
      ข้อผิดพลาด: 'กรุณาระบุระยะเวลาที่ยื่นล่าช้า เป็นจำนวนเดือน (monthsLate) หรือจำนวนวัน (daysLate)',
    };
  }

  // ---- เงินเพิ่มตามมาตรา 27 ----
  const surchargeRaw = round2(taxDue * PENALTY.SURCHARGE_RATE_PER_MONTH * monthsLate);
  const surcharge = Math.min(surchargeRaw, taxDue); // เพดาน: ไม่เกินจำนวนภาษีที่ต้องเสีย
  const surchargeCapped = surchargeRaw > taxDue;

  // ---- ค่าปรับตามมาตรา 35 ----
  const fine = daysLate > 0 && daysLate <= 7
    ? PENALTY.FINE_WITHIN_7_DAYS
    : PENALTY.FINE_OVER_7_DAYS;

  const total = round2(surcharge + fine);

  return {
    สำเร็จ: true,
    สรุป: {
      ภาษีที่ต้องชำระ: round2(taxDue),
      ระยะเวลาที่ล่าช้า: `${monthsLate} เดือน` + (daysLate ? ` (ประมาณ ${daysLate} วัน)` : ''),
      เงินเพิ่ม: round2(surcharge),
      ค่าปรับ: fine,
      รวมที่ต้องชำระเพิ่ม: total,
      รวมทั้งสิ้นพร้อมภาษี: round2(taxDue + total),
    },
    // ประโยคสำเร็จรูปที่ให้แบบจำลองภาษานำไปใช้ตอบผู้ใช้โดยตรง
    //
    // เหตุผลที่ต้องมีช่องนี้ วัดจากข้อมูลจริง
    //   คำถามอย่าง "ภาษีค้าง 8,000 บาท ยื่นช้า 80 เดือน ต้องเสียเท่าไหร่"
    //   ตีความได้สองแบบ คือเสียเพิ่มเท่าไหร่ กับเสียทั้งสิ้นเท่าไหร่
    //   ผลคือแบบจำลองภาษาเลือกตอบเลขใดเลขหนึ่ง แล้วผู้ใช้ได้ข้อมูลไม่ครบ
    //   บางครั้งตอบ 10,000 บางครั้งตอบ 18,000 ทั้งที่คำถามเหมือนกัน
    //
    // แทนที่จะไปสั่งด้วยคำสั่งระบบซึ่งพิสูจน์แล้วว่าไม่แน่นอน
    // จึงให้เครื่องคำนวณส่งประโยคที่มีครบทั้งสองจำนวนกลับไปเลย
    // ผู้ใช้จึงได้คำตอบที่ครบถ้วนไม่ว่าเจตนาของคำถามจะเป็นแบบไหน
    คำตอบที่ควรใช้ตอบผู้ใช้:
      `ต้องเสียเงินเพิ่มและค่าปรับรวม ${total.toLocaleString('en-US')} บาท ` +
      `(เงินเพิ่ม ${surcharge.toLocaleString('en-US')} บาท และค่าปรับ ${fine.toLocaleString('en-US')} บาท) ` +
      `เมื่อรวมกับภาษีค้างชำระ ${taxDue.toLocaleString('en-US')} บาท ` +
      `จะต้องชำระทั้งสิ้น ${round2(taxDue + total).toLocaleString('en-US')} บาท`,
    วิธีคำนวณ: [
      `เงินเพิ่ม = ${taxDue.toLocaleString('en-US')} x 1.5% x ${monthsLate} เดือน = ${surchargeRaw.toLocaleString('en-US')} บาท` +
        (surchargeCapped
          ? ` แต่กฎหมายกำหนดเพดานไว้ไม่เกินจำนวนภาษีที่ต้องเสีย จึงคิดเพียง ${surcharge.toLocaleString('en-US')} บาท`
          : ''),
      `ค่าปรับ = ${fine.toLocaleString('en-US')} บาท (${daysLate > 0 && daysLate <= 7 ? 'ยื่นเกินกำหนดไม่เกิน 7 วัน' : 'ยื่นเกินกำหนดเกิน 7 วัน'})`,
      `รวมต้องชำระเพิ่ม = ${surcharge.toLocaleString('en-US')} + ${fine.toLocaleString('en-US')} = ${total.toLocaleString('en-US')} บาท`,
    ],
    ...(surchargeCapped
      ? { หมายเหตุ: 'เงินเพิ่มถูกจำกัดตามมาตรา 27 ซึ่งกำหนดว่าเงินเพิ่มต้องไม่เกินจำนวนภาษีที่ต้องเสีย' }
      : {}),
    ฐานอ้างอิง: 'ประมวลรัษฎากร มาตรา 27 (เงินเพิ่ม) และมาตรา 35 (ค่าปรับ)',
    คำเตือน:
      'จำนวนค่าปรับเป็นอำนาจเปรียบเทียบปรับของเจ้าพนักงานประเมิน ' +
      'ตัวเลขนี้เป็นการประมาณการตามแนวปฏิบัติทั่วไป ' +
      'กรุณาตรวจสอบกับสำนักงานสรรพากรพื้นที่ หรือสายด่วน 1161',
  };
}

module.exports = {
  calculateThaiPIT,
  calculateLatePenalty,
  calcProgressiveTax,
  calcExpenses,
  calcAllowances,
  calcDonations,
  TAX_BRACKETS,
  LIMITS,
  PENALTY,
  TAX_YEAR,
};
