'use strict';
/**
 * ============================================================================
 *  เครื่องมือเปรียบเทียบประสิทธิภาพแบบจำลองภาษา (Model Comparison Harness)
 * ----------------------------------------------------------------------------
 *  วัตถุประสงค์:
 *    เปรียบเทียบความสามารถของแบบจำลองภาษาหลายตัวบนงานเดียวกัน โดยควบคุมให้
 *    ตัวแปรอื่นคงที่ทั้งหมด (คำสั่งระบบเดียวกัน เครื่องมือเดียวกัน ชุดคำถามเดียวกัน)
 *    เพื่อให้สรุปได้ว่าความแตกต่างของผลลัพธ์เกิดจากตัวแบบจำลอง ไม่ใช่ปัจจัยอื่น
 *
 *  ตัวชี้วัดที่เก็บ:
 *    1. อัตราการเรียกใช้เครื่องมือถูกต้อง (Tool-Calling Success Rate)
 *       — คำถามที่ต้องคำนวณ แบบจำลองเรียกเครื่องมือหรือคำนวณเองมั่ว
 *    2. ความถูกต้องของคำตอบ (Answer Accuracy)
 *       — ตัวเลขภาษีตรงกับค่าที่คำนวณตามกฎหมายหรือไม่ / มีคำสำคัญครบหรือไม่
 *    3. เวลาตอบสนอง (Response Time) เป็นมิลลิวินาที
 *    4. ความยาวคำตอบ (ใช้ตรวจว่าเกินข้อจำกัด 2,000 ตัวอักษรของ LINE หรือไม่)
 *
 *  หมายเหตุด้านวิธีวิจัย:
 *    สคริปต์นี้เรียก API ของแต่ละผู้ให้บริการผ่านรูปแบบที่เข้ากันได้กับ OpenAI
 *    ทั้งหมด จึงใช้โค้ดเส้นทางเดียวกัน ลดโอกาสที่ความแตกต่างของผลลัพธ์
 *    จะเกิดจากวิธีเรียก API ที่ไม่เหมือนกัน
 *
 *  วิธีรัน:
 *    node evaluation/compare-models.js                 # รันทุกแบบจำลองที่ตั้งค่าไว้
 *    node evaluation/compare-models.js --models=gemini # เลือกเฉพาะบางตัว
 *    node evaluation/compare-models.js --runs=3        # รันซ้ำหลายรอบเพื่อดูความคงเส้นคงวา
 *
 *  ต้องใช้ Node.js เวอร์ชัน 18 ขึ้นไป (ใช้ fetch ที่มีมาในตัว)
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const { calculateThaiPIT } = require('../n8n/tools/tax-calculator');

// ---------------------------------------------------------------------------
// อ่านค่าตั้งต้นจากไฟล์ .env (ไม่ใช้ไลบรารีภายนอกเพื่อให้รันได้ทันทีไม่ต้องติดตั้ง)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  const env = { ...process.env };
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in env)) env[key] = value;
  }
  return env;
}

const ENV = loadEnv();

// ---------------------------------------------------------------------------
// รายการแบบจำลองที่นำมาเปรียบเทียบ
// ทุกตัวเรียกผ่านรูปแบบ API ที่เข้ากันได้กับ OpenAI
// ---------------------------------------------------------------------------
// rpmLimit = จำนวนคำขอสูงสุดต่อนาทีที่ผู้ให้บริการอนุญาต (0 = ไม่จำกัด)
// สคริปต์จะเว้นจังหวะระหว่างคำขอให้อัตโนมัติเพื่อไม่ให้ชนเพดาน
const PROVIDERS = {
  openai: {
    label: 'OpenAI gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: ENV.OPENAI_API_KEY,
    rpmLimit: Number(ENV.OPENAI_RPM_LIMIT) || 60,
    ประเภท: 'บริการบนคลาวด์ (มีค่าใช้จ่าย)',
  },
  gemini: {
    label: 'Google Gemini (' + (ENV.GEMINI_MODEL || 'gemini-2.5-flash-lite') + ')',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    // เลือกรุ่นที่มีโควตาฟรีเพียงพอ
    //   gemini-2.5-flash      = 20 คำขอต่อวัน    (น้อยเกินไป)
    //   gemini-2.5-flash-lite = 1,000 คำขอต่อวัน (เหมาะกับงานวิจัยนี้)
    model: ENV.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    apiKey: ENV.GEMINI_API_KEY,
    // จำกัดคำขอต่อนาทีเพื่อไม่ให้ถูกปฏิเสธด้วยรหัส 429
    rpmLimit: Number(ENV.GEMINI_RPM_LIMIT) || 12,
    ประเภท: 'บริการบนคลาวด์ (โควตาฟรี)',
  },
  typhoon: {
    label: 'Typhoon 2.5 4B (รันในเครื่อง)',
    baseUrl: (ENV.OLLAMA_BASE_URL || 'http://localhost:11434') + '/v1',
    model: ENV.TYPHOON_MODEL || 'scb10x/typhoon2.5-qwen3-4b',
    apiKey: 'ollama', // Ollama ไม่ตรวจสอบกุญแจ แต่ต้องส่งค่าอะไรสักอย่าง
    rpmLimit: 0, // รันในเครื่องตัวเอง ไม่มีเพดานคำขอ
    ประเภท: 'แบบจำลองภาษาไทยแบบเปิด รันในเครื่อง (ฟรี)',
  },
};

// ---------------------------------------------------------------------------
// คำสั่งระบบ — ต้องเหมือนกันทุกแบบจำลองเพื่อควบคุมตัวแปร
// (ย่อจากที่ใช้จริงใน workflow ให้เหลือเฉพาะส่วนที่จำเป็นต่อการทดสอบ)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `คุณคือ "คุณภาษี" ผู้ช่วยที่ปรึกษาด้านภาษีเงินได้บุคคลธรรมดาของประเทศไทย

กฎการคำนวณ (สำคัญที่สุด ห้ามละเมิด)
- เมื่อใดก็ตามที่ต้องได้ตัวเลขภาษี ต้องเรียกเครื่องมือ calculate_thai_personal_income_tax เสมอ
- ห้ามคำนวณเลขเองหรือเดาตัวเลขเด็ดขาด
- ถ้าผู้ใช้บอกรายได้เป็นรายเดือน ให้คูณ 12 เป็นยอดทั้งปีก่อนส่งให้เครื่องมือ
- เมื่อได้ผลจากเครื่องมือแล้ว ให้สรุปเป็นภาษาที่เข้าใจง่าย พร้อมระบุตัวเลขภาษีที่ต้องชำระให้ชัดเจน

ความรู้พื้นฐาน (ปีภาษี 2567)
- อัตราภาษีขั้นบันได: 0-150,000 ยกเว้น / 150,001-300,000 = 5% / 300,001-500,000 = 10% /
  500,001-750,000 = 15% / 750,001-1,000,000 = 20% / 1,000,001-2,000,000 = 25% /
  2,000,001-5,000,000 = 30% / เกิน 5,000,000 = 35%
- ค่าใช้จ่าย: เงินเดือน 40(1) และรับจ้าง 40(2) หัก 50% รวมกันไม่เกิน 100,000 บาท / ธุรกิจ 40(8) หัก 60%
- ค่าลดหย่อน: ส่วนตัว 60,000 / คู่สมรสไม่มีรายได้ 60,000 / บุตร 30,000 ต่อคน /
  บิดามารดาอายุ 60 ปีขึ้นไป 30,000 ต่อคน / ประกันสังคมไม่เกิน 9,000 /
  ประกันชีวิตไม่เกิน 100,000 / SSF ไม่เกิน 30% ของเงินได้ และไม่เกิน 200,000 /
  RMF ไม่เกิน 30% ของเงินได้ และไม่เกิน 500,000 / ดอกเบี้ยบ้านไม่เกิน 100,000
- กำหนดยื่นแบบ: ยื่นที่สำนักงานภายใน 31 มีนาคม ยื่นออนไลน์ที่ rd.go.th ขยายถึงต้นเมษายน
- ยื่นล่าช้า: ค่าปรับสูงสุด 2,000 บาท และเงินเพิ่ม 1.5% ต่อเดือนของภาษีที่ต้องชำระ

รูปแบบการตอบ
- ตอบเป็นภาษาไทยเสมอ กระชับ ไม่เกิน 2,000 ตัวอักษร
- ถ้าคำถามไม่เกี่ยวกับภาษี ให้ปฏิเสธอย่างสุภาพและแจ้งว่าให้บริการเฉพาะเรื่องภาษี`;

// ---------------------------------------------------------------------------
// นิยามเครื่องมือ — ต้องเหมือนกันทุกแบบจำลอง
// ---------------------------------------------------------------------------
const TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'calculate_thai_personal_income_tax',
    description:
      'คำนวณภาษีเงินได้บุคคลธรรมดาของประเทศไทยตามประมวลรัษฎากร ' +
      'ใช้ทุกครั้งที่ต้องได้ตัวเลขภาษี จำนวนเงินทุกช่องเป็นยอดทั้งปีหน่วยบาท',
    parameters: {
      type: 'object',
      properties: {
        income: {
          type: 'object',
          description: 'เงินได้พึงประเมินทั้งปี แยกตามมาตรา 40',
          properties: {
            salary: { type: 'number', description: '40(1) เงินเดือน ค่าจ้าง โบนัส ทั้งปี' },
            hire: { type: 'number', description: '40(2) รับจ้างทำของ ค่านายหน้า ฟรีแลนซ์' },
            royalty: { type: 'number', description: '40(3) ค่าลิขสิทธิ์' },
            interestDividend: { type: 'number', description: '40(4) ดอกเบี้ย เงินปันผล' },
            rent: { type: 'number', description: '40(5) ค่าเช่าทรัพย์สิน' },
            profession: { type: 'number', description: '40(6) วิชาชีพอิสระ' },
            contractor: { type: 'number', description: '40(7) รับเหมาก่อสร้าง' },
            business: { type: 'number', description: '40(8) ธุรกิจ การค้า เงินได้อื่น' },
          },
        },
        allowances: {
          type: 'object',
          description: 'ค่าลดหย่อน ระบุเฉพาะที่ผู้ใช้แจ้ง ค่าลดหย่อนส่วนตัวระบบใส่ให้อัตโนมัติ',
          properties: {
            spouse: { type: 'boolean', description: 'มีคู่สมรสที่ไม่มีเงินได้' },
            children: { type: 'number', description: 'จำนวนบุตร' },
            childrenBorn2561Plus: { type: 'number', description: 'บุตรคนที่ 2 ขึ้นไปที่เกิดตั้งแต่ปี 2561' },
            parents: { type: 'number', description: 'จำนวนบิดามารดาอายุ 60 ปีขึ้นไป' },
            lifeInsurance: { type: 'number', description: 'เบี้ยประกันชีวิต' },
            healthInsurance: { type: 'number', description: 'เบี้ยประกันสุขภาพตนเอง' },
            socialSecurity: { type: 'number', description: 'เงินสมทบประกันสังคม' },
            rmf: { type: 'number', description: 'กองทุน RMF' },
            ssf: { type: 'number', description: 'กองทุน SSF' },
            pvd: { type: 'number', description: 'กองทุนสำรองเลี้ยงชีพ หรือ กบข.' },
            homeLoanInterest: { type: 'number', description: 'ดอกเบี้ยเงินกู้ที่อยู่อาศัย' },
            donationEducation: { type: 'number', description: 'บริจาคการศึกษา หักได้ 2 เท่า' },
            donationGeneral: { type: 'number', description: 'บริจาคทั่วไป' },
          },
        },
        withholdingTax: { type: 'number', description: 'ภาษีหัก ณ ที่จ่ายที่ถูกหักไว้ทั้งปี' },
      },
      required: ['income'],
    },
  },
};

// ---------------------------------------------------------------------------
// การควบคุมจังหวะการเรียก API (Rate Limiting)
// ----------------------------------------------------------------------------
// ผู้ให้บริการที่มีโควตาฟรีจำกัดจำนวนคำขอต่อนาที หากยิงคำขอติดกันเร็วเกินไป
// จะถูกปฏิเสธด้วยรหัส 429 สคริปต์จึงเว้นจังหวะให้อัตโนมัติตามค่า rpmLimit
// และหากยังถูกปฏิเสธ จะรอแล้วลองใหม่แบบเพิ่มระยะเวลาขึ้นเรื่อยๆ
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastCallAt = {}; // เก็บเวลาที่เรียกครั้งล่าสุดของแต่ละผู้ให้บริการ

async function throttle(providerKey, rpmLimit, extraDelayMs) {
  const minInterval = rpmLimit > 0 ? Math.ceil(60000 / rpmLimit) : 0;
  const wait = Math.max(minInterval, extraDelayMs || 0);
  if (wait <= 0) return;
  const last = lastCallAt[providerKey] || 0;
  const elapsed = Date.now() - last;
  if (elapsed < wait) await sleep(wait - elapsed);
  lastCallAt[providerKey] = Date.now();
}

/** ดึงระยะเวลาที่ผู้ให้บริการแนะนำให้รอ (ถ้ามี) จากข้อความ error */
function parseRetryDelay(text) {
  const m = String(text).match(/"retryDelay"\s*:\s*"(\d+)s"/);
  return m ? Number(m[1]) * 1000 : null;
}

const MAX_RETRIES = 4;

// ตัวสะสมเวลาที่ใช้เรียก API จริง (ไม่รวมเวลาที่รอเว้นจังหวะและเวลาที่รอลองใหม่)
// จำเป็นต่อความถูกต้องของการวัด เพราะเวลาที่สคริปต์หน่วงเองไม่ใช่ความเร็วของแบบจำลอง
let apiTimeMs = 0;
const resetApiTimer = () => {
  apiTimeMs = 0;
};

async function rawChatCompletion(provider, messages, useTools) {
  const body = {
    model: provider.model,
    messages,
    temperature: 0.3,
  };
  if (useTools) {
    body.tools = [TOOL_DEFINITION];
    body.tool_choice = 'auto';
  }

  const t0 = Date.now();
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.bodyText = text;
    throw err; // คำขอที่ล้มเหลวไม่นับเข้าเวลาตอบสนอง
  }
  apiTimeMs += Date.now() - t0;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`ตอบกลับไม่ใช่ JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * เรียก API แบบเข้ากันได้กับ OpenAI พร้อมควบคุมจังหวะและลองใหม่อัตโนมัติ
 */
async function chatCompletion(provider, messages, useTools) {
  let attempt = 0;

  for (;;) {
    await throttle(provider.key, provider.rpmLimit, provider.extraDelayMs);
    try {
      return await rawChatCompletion(provider, messages, useTools);
    } catch (e) {
      const isRateLimit = e.status === 429;
      const isServerBusy = e.status === 503 || e.status === 500;

      if ((isRateLimit || isServerBusy) && attempt < MAX_RETRIES) {
        attempt += 1;
        // ใช้ระยะเวลาที่ผู้ให้บริการแนะนำถ้ามี ไม่งั้นเพิ่มระยะเวลาเป็นเท่าตัว
        const suggested = parseRetryDelay(e.bodyText);
        const backoff = suggested || Math.min(10000 * 2 ** (attempt - 1), 90000);
        process.stdout.write(
          `\r    ถูกจำกัดอัตราการเรียก (${e.status}) รอ ${Math.round(backoff / 1000)} วินาที แล้วลองใหม่ครั้งที่ ${attempt}/${MAX_RETRIES}...`
        );
        await sleep(backoff);
        process.stdout.write('\r' + ' '.repeat(100) + '\r');
        continue;
      }

      if (e.status) {
        // ย่อข้อความ error ให้อ่านง่าย ไม่พ่น JSON ยาวเต็มหน้าจอ
        let detail = '';
        try {
          const parsed = JSON.parse(e.bodyText);
          const obj = Array.isArray(parsed) ? parsed[0] : parsed;
          detail = (obj && obj.error && obj.error.message) || '';
        } catch (_) {
          detail = String(e.bodyText || '').replace(/\s+/g, ' ').slice(0, 160);
        }
        throw new Error(`HTTP ${e.status}: ${detail.slice(0, 160)}`);
      }
      throw e;
    }
  }
}

/**
 * ถามคำถามหนึ่งข้อกับแบบจำลองหนึ่งตัว พร้อมรองรับการเรียกเครื่องมือ
 * คืนค่า: คำตอบสุดท้าย, เรียกเครื่องมือหรือไม่, ค่าที่ส่งให้เครื่องมือ, เวลาที่ใช้
 */
async function askModel(provider, question) {
  resetApiTimer();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ];

  let toolCalled = false;
  let toolArguments = null;
  let toolResultSummary = null;

  // รอบแรก: ให้แบบจำลองตัดสินใจว่าจะเรียกเครื่องมือหรือไม่
  let response = await chatCompletion(provider, messages, true);
  let choice = response.choices && response.choices[0];
  if (!choice) throw new Error('ไม่มีคำตอบกลับมาจากแบบจำลอง');

  const calls = choice.message && choice.message.tool_calls;
  if (calls && calls.length > 0) {
    toolCalled = true;
    messages.push(choice.message);

    for (const call of calls) {
      let args = {};
      let toolOutput;
      try {
        args = JSON.parse(call.function.arguments || '{}');
        toolOutput = calculateThaiPIT(args);
      } catch (e) {
        toolOutput = { สำเร็จ: false, ข้อผิดพลาด: 'ข้อมูลนำเข้าไม่ถูกต้อง: ' + e.message };
      }
      toolArguments = args;
      if (toolOutput && toolOutput['สรุป']) {
        toolResultSummary = toolOutput['สรุป']['ภาษีที่ต้องชำระ'];
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(toolOutput),
      });
    }

    // รอบสอง: ให้แบบจำลองสรุปคำตอบจากผลของเครื่องมือ
    response = await chatCompletion(provider, messages, false);
    choice = response.choices && response.choices[0];
  }

  const answer = (choice && choice.message && choice.message.content) || '';

  return {
    answer: String(answer).trim(),
    toolCalled,
    toolArguments,
    toolResultSummary,
    // นับเฉพาะเวลาที่ใช้เรียก API จริง ไม่รวมเวลาที่สคริปต์หน่วงเพื่อไม่ให้ชนโควตา
    responseTimeMs: apiTimeMs,
    usage: response.usage || null,
  };
}

// ---------------------------------------------------------------------------
// ตรวจคำตอบตามเกณฑ์ที่กำหนดไว้ในชุดคำถาม
// ---------------------------------------------------------------------------
function normalizeNumbers(text) {
  // ดึงตัวเลขทุกตัวในข้อความ โดยตัดเครื่องหมายคั่นหลักพันออก
  const matches = String(text).match(/[\d,]+(?:\.\d+)?/g) || [];
  return matches
    .map((m) => Number(m.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
}

function evaluateAnswer(q, result) {
  const answer = result.answer || '';

  if (q.check === 'exactNumber') {
    const numbers = normalizeNumbers(answer);
    // ยอมรับความคลาดเคลื่อนจากการปัดเศษเล็กน้อย
    const found = numbers.some((n) => Math.abs(n - q.expected) < 1);
    return {
      ผ่าน: found,
      เหตุผล: found
        ? `พบตัวเลข ${q.expected.toLocaleString('en-US')} ในคำตอบ`
        : `ไม่พบตัวเลข ${q.expected.toLocaleString('en-US')} (ตัวเลขที่พบ: ${numbers.slice(0, 8).join(', ') || 'ไม่มี'})`,
    };
  }

  if (q.check === 'keywords') {
    const missing = q.expected.filter((kw) => !answer.includes(kw));
    return {
      ผ่าน: missing.length === 0,
      เหตุผล: missing.length === 0 ? 'พบคำสำคัญครบ' : `ขาดคำสำคัญ: ${missing.join(', ')}`,
    };
  }

  if (q.check === 'scope') {
    // ต้องปฏิเสธและอ้างถึงขอบเขตเรื่องภาษี และต้องไม่แนะนำร้านอาหารจริงๆ
    const mentionsScope = q.expected.some((kw) => answer.includes(kw));
    return {
      ผ่าน: mentionsScope,
      เหตุผล: mentionsScope ? 'ปฏิเสธและอ้างถึงขอบเขตการให้บริการ' : 'ไม่ได้แจ้งขอบเขตการให้บริการ',
    };
  }

  return { ผ่าน: false, เหตุผล: 'ไม่รู้จักเกณฑ์การตรวจ' };
}

// ---------------------------------------------------------------------------
// ส่วนหลัก
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = { models: null, runs: 1, delay: 0 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--models=')) args.models = a.slice(9).split(',').map((s) => s.trim());
    else if (a.startsWith('--runs=')) args.runs = Math.max(1, parseInt(a.slice(7), 10) || 1);
    else if (a.startsWith('--delay=')) args.delay = Math.max(0, parseInt(a.slice(8), 10) || 0);
  }
  return args;
}

function mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

async function main() {
  const args = parseArgs();
  const dataset = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'test-questions.json'), 'utf8')
  );
  const questions = dataset.questions;

  const selected = Object.entries(PROVIDERS)
    .filter(([key, p]) => {
      if (args.models && !args.models.includes(key)) return false;
      if (!p.apiKey) {
        console.log(`ข้าม ${p.label}: ไม่พบกุญแจ API ในไฟล์ .env`);
        return false;
      }
      return true;
    })
    .map(([key, p]) => {
      p.key = key;
      p.extraDelayMs = args.delay;
      return [key, p];
    });

  if (selected.length === 0) {
    console.error('\nไม่มีแบบจำลองที่พร้อมทดสอบ');
    console.error('ตรวจสอบว่าไฟล์ .env มีค่าเหล่านี้: OPENAI_API_KEY, GEMINI_API_KEY');
    console.error('สำหรับ Typhoon ต้องเปิดโปรแกรม Ollama ไว้ และตั้ง OLLAMA_BASE_URL (ถ้าไม่ใช่ค่าเริ่มต้น)');
    process.exit(1);
  }

  console.log('='.repeat(78));
  console.log('  การเปรียบเทียบประสิทธิภาพแบบจำลองภาษาสำหรับระบบที่ปรึกษาด้านภาษี');
  console.log('='.repeat(78));
  console.log(`จำนวนคำถาม: ${questions.length} ข้อ | จำนวนรอบต่อคำถาม: ${args.runs}`);
  console.log(`แบบจำลองที่ทดสอบ: ${selected.map(([, p]) => p.label).join(', ')}\n`);

  const rows = [];

  for (const [key, provider] of selected) {
    const paceNote =
      provider.rpmLimit > 0
        ? `เว้นจังหวะ ${(60 / provider.rpmLimit).toFixed(1)} วินาทีต่อคำขอ (เพดาน ${provider.rpmLimit} คำขอ/นาที)`
        : 'ไม่จำกัดอัตราการเรียก';
    console.log('-'.repeat(78));
    console.log(`กำลังทดสอบ: ${provider.label}  (${provider.model})`);
    console.log(`  ${paceNote}`);
    console.log('-'.repeat(78));

    for (const q of questions) {
      for (let run = 1; run <= args.runs; run++) {
        let record = {
          แบบจำลอง: provider.label,
          รหัสคำถาม: q.id,
          หมวด: q.category,
          รอบที่: run,
          ต้องเรียกเครื่องมือ: q.requiresTool ? 'ใช่' : 'ไม่',
          เรียกเครื่องมือจริง: '',
          ผลการตรวจ: '',
          เหตุผล: '',
          เวลาตอบสนอง_ms: '',
          ความยาวคำตอบ: '',
          คำตอบ: '',
        };

        try {
          const result = await askModel(provider, q.question);
          const verdict = evaluateAnswer(q, result);
          const toolOk = !q.requiresTool || result.toolCalled;

          record.เรียกเครื่องมือจริง = result.toolCalled ? 'ใช่' : 'ไม่';
          record.ผลการตรวจ = verdict.ผ่าน && toolOk ? 'ผ่าน' : 'ไม่ผ่าน';
          record.เหตุผล = toolOk ? verdict.เหตุผล : 'ไม่ได้เรียกเครื่องมือคำนวณ (' + verdict.เหตุผล + ')';
          record.เวลาตอบสนอง_ms = result.responseTimeMs;
          record.ความยาวคำตอบ = result.answer.length;
          record.คำตอบ = result.answer.replace(/\s+/g, ' ').slice(0, 500);

          const mark = record.ผลการตรวจ === 'ผ่าน' ? 'ผ่าน  ' : 'ไม่ผ่าน';
          const toolMark = q.requiresTool ? (result.toolCalled ? '[ใช้เครื่องมือ]' : '[ไม่ใช้เครื่องมือ]') : '';
          console.log(
            `  ${q.id} ${mark} ${String(result.responseTimeMs).padStart(6)} ms ${toolMark} ${record.เหตุผล}`
          );
        } catch (e) {
          record.ผลการตรวจ = 'ผิดพลาด';
          record.เหตุผล = String(e.message).slice(0, 200);
          console.log(`  ${q.id} ผิดพลาด  ${record.เหตุผล}`);
        }

        rows.push(record);
      }
    }
    console.log('');
  }

  // -------------------------------------------------------------------------
  // สรุปผลรวมต่อแบบจำลอง
  // -------------------------------------------------------------------------
  console.log('='.repeat(78));
  console.log('  ตารางสรุปผล (นำไปใส่บทที่ 4 ได้โดยตรง)');
  console.log('='.repeat(78));

  const summary = [];
  for (const [, provider] of selected) {
    const mine = rows.filter((r) => r.แบบจำลอง === provider.label);
    const ok = mine.filter((r) => r.ผลการตรวจ === 'ผ่าน').length;
    const errored = mine.filter((r) => r.ผลการตรวจ === 'ผิดพลาด').length;
    const times = mine.filter((r) => typeof r.เวลาตอบสนอง_ms === 'number').map((r) => r.เวลาตอบสนอง_ms);

    const toolNeeded = mine.filter((r) => r.ต้องเรียกเครื่องมือ === 'ใช่');
    const toolUsed = toolNeeded.filter((r) => r.เรียกเครื่องมือจริง === 'ใช่').length;

    const s = {
      แบบจำลอง: provider.label,
      ความถูกต้องร้อยละ: mine.length ? ((ok / mine.length) * 100).toFixed(1) : '0.0',
      เรียกเครื่องมือสำเร็จร้อยละ: toolNeeded.length
        ? ((toolUsed / toolNeeded.length) * 100).toFixed(1)
        : '-',
      เวลาเฉลี่ย_ms: times.length ? mean(times).toFixed(0) : '-',
      ส่วนเบี่ยงเบน_ms: times.length ? stddev(times).toFixed(0) : '-',
      ข้อผิดพลาด: errored,
    };
    summary.push(s);

    console.log(`\n${provider.label}`);
    console.log(`  ความถูกต้องโดยรวม        : ${s.ความถูกต้องร้อยละ}%  (${ok}/${mine.length} ข้อ)`);
    console.log(`  เรียกเครื่องมือคำนวณสำเร็จ : ${s.เรียกเครื่องมือสำเร็จร้อยละ}%  (${toolUsed}/${toolNeeded.length} ข้อ)`);
    console.log(`  เวลาตอบสนองเฉลี่ย        : ${s.เวลาเฉลี่ย_ms} ms  (SD ${s.ส่วนเบี่ยงเบน_ms})`);
    if (errored > 0) console.log(`  เรียก API ไม่สำเร็จ       : ${errored} ครั้ง`);
  }

  // -------------------------------------------------------------------------
  // บันทึกผลเป็นไฟล์
  // -------------------------------------------------------------------------
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const toCsv = (records) => {
    if (records.length === 0) return '';
    const headers = Object.keys(records[0]);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [
      headers.join(','),
      ...records.map((r) => headers.map((h) => esc(r[h])).join(',')),
    ].join('\n');
  };

  const detailPath = path.join(outDir, `comparison-detail-${stamp}.csv`);
  const summaryPath = path.join(outDir, `comparison-summary-${stamp}.csv`);
  // ใส่ BOM เพื่อให้ Excel เปิดไฟล์ภาษาไทยได้ถูกต้อง
  fs.writeFileSync(detailPath, '﻿' + toCsv(rows), 'utf8');
  fs.writeFileSync(summaryPath, '﻿' + toCsv(summary), 'utf8');

  console.log(`\n${'='.repeat(78)}`);
  console.log('บันทึกผลเรียบร้อย:');
  console.log(`  รายละเอียดรายข้อ : ${detailPath}`);
  console.log(`  ตารางสรุป        : ${summaryPath}`);
  console.log('เปิดไฟล์ด้วย Excel ได้ทันที (บันทึกเป็น UTF-8 พร้อม BOM แล้ว)');
}

main().catch((e) => {
  console.error('\nเกิดข้อผิดพลาดร้ายแรง:', e.message);
  process.exit(1);
});
