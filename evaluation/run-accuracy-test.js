'use strict';
/**
 * ============================================================================
 *  เครื่องมือวัดความแม่นยำของระบบแบบครบวงจร (End-to-End Accuracy Test)
 * ----------------------------------------------------------------------------
 *  ต่างจาก compare-models.js อย่างไร
 *    compare-models.js  เปรียบเทียบ "แบบจำลองภาษา" โดยใช้คำสั่งระบบแบบย่อ
 *                       เพื่อควบคุมตัวแปรให้เปรียบเทียบกันได้อย่างเป็นธรรม
 *    ไฟล์นี้           วัด "ระบบทั้งระบบ" ตามการตั้งค่าที่ใช้งานจริง
 *                       จึงตอบคำถามว่าระบบพร้อมนำไปใช้จริงหรือยัง
 *
 *  สิ่งที่ทำให้ผลการวัดน่าเชื่อถือ
 *    1. อ่านคำสั่งระบบ (system prompt) จากไฟล์ workflow โดยตรง
 *       ไม่ได้เขียนซ้ำในไฟล์นี้ จึงมั่นใจได้ว่าทดสอบสิ่งเดียวกับที่รันจริง
 *    2. อ่านโครงสร้างข้อมูลนำเข้าของเครื่องมือจากไฟล์ workflow เช่นกัน
 *    3. จำลองการสืบค้นฐานความรู้ด้วยตรรกะเดียวกับที่ใช้ในระบบ
 *       (คำสำคัญชุดเดียวกัน และการให้น้ำหนักชื่อเรื่องแบบเดียวกัน)
 *    4. ใช้เครื่องคำนวณตัวจริงจาก n8n/tools/tax-calculator.js
 *
 *  วิธีรัน
 *    node evaluation/run-accuracy-test.js
 *    node evaluation/run-accuracy-test.js --runs=3       รันซ้ำเพื่อดูความคงเส้นคงวา
 *    node evaluation/run-accuracy-test.js --model=gemini ระบุผู้ให้บริการ
 *
 *  ต้องใช้ Node.js เวอร์ชัน 18 ขึ้นไป
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  calculateThaiPIT,
  calculateLatePenalty,
} = require('../n8n/tools/tax-calculator');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// อ่านค่าตั้งต้นจากไฟล์ .env
// ---------------------------------------------------------------------------
function loadEnv() {
  const p = path.join(ROOT, '.env');
  const env = { ...process.env };
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in env)) env[k] = v;
  }
  return env;
}
const ENV = loadEnv();

const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: ENV.GEMINI_MODEL || 'gemini-3-flash-preview',
    apiKey: ENV.GEMINI_API_KEY,
    // โควตาฟรีของ gemini-3-flash-preview จำกัดที่ 5 คำขอต่อนาที
    // (ตรวจสอบได้ที่ https://aistudio.google.com/rate-limit)
    // คำถามหนึ่งข้อใช้อย่างน้อย 2 คำขอ จึงต้องเว้นจังหวะให้พอ ไม่งั้นเจอ 429 ตั้งแต่ข้อแรก ๆ
    rpmLimit: Number(ENV.GEMINI_RPM_LIMIT) || 5,
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: ENV.OPENAI_API_KEY,
    rpmLimit: 60,
  },
  typhoon: {
    label: 'Typhoon (รันในเครื่อง)',
    baseUrl: (ENV.OLLAMA_BASE_URL || 'http://localhost:11434') + '/v1',
    model: ENV.TYPHOON_MODEL || 'scb10x/typhoon2.5-qwen3-4b',
    apiKey: 'ollama',
    rpmLimit: 0,
  },
};

// ---------------------------------------------------------------------------
// อ่านการตั้งค่าจริงจากไฟล์ workflow
// ---------------------------------------------------------------------------
function loadProductionConfig() {
  const wf = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'n8n/workflows/tax-advisor-workflow.json'), 'utf8')
  );
  const byName = (n) => wf.nodes.find((x) => x.name === n);

  const agent = byName('AI Agent (Tax Advisor)');
  if (!agent) throw new Error('ไม่พบ node AI Agent ในไฟล์ workflow');

  // คำสั่งระบบขึ้นต้นด้วย = เพราะเป็นนิพจน์ของ n8n ต้องตัดออก
  let systemMessage = agent.parameters.options.systemMessage.replace(/^=/, '');

  const tools = wf.nodes
    .filter((n) => n.type.endsWith('toolCode'))
    .map((n) => ({
      name: n.parameters.name,
      description: n.parameters.description,
      schema: JSON.parse(n.parameters.inputSchema),
    }));

  const searchNode = byName('Search Tax Knowledge');
  const keywordMap = JSON.parse(
    /var map = (\[[\s\S]*?\]); var found/.exec(
      searchNode.parameters.options.queryReplacement
    )[1]
  );

  // ลายนิ้วมือของการตั้งค่า ใช้ตรวจว่าผลที่บันทึกไว้เดิมยังใช้ต่อได้หรือไม่
  // ถ้าคำสั่งระบบ เครื่องมือ คำสำคัญ หรือฐานความรู้เปลี่ยน ผลเดิมใช้ร่วมกับผลใหม่ไม่ได้
  //
  // ฐานความรู้ต้องรวมอยู่ในลายนิ้วมือด้วย เพราะเป็นข้อมูลที่ส่งเข้าแบบจำลองภาษาโดยตรง
  // ถ้าไม่รวม การเพิ่มฐานความรู้ชุดใหม่แล้วรันซ้ำจะหยิบผลเดิมจากจุดบันทึกมาใช้
  // แล้วรายงานว่าคะแนนไม่ขยับ ทั้งที่ยังไม่ได้ถามใหม่เลยสักข้อ
  const intentRules = loadIntentRules();
  const kbFingerprint = loadKnowledgeBase()
    .map((r) => r.title)
    .sort()
    .join('|');

  const hash = require('node:crypto')
    .createHash('sha256')
    .update(
      systemMessage +
        JSON.stringify(tools) +
        JSON.stringify(keywordMap) +
        JSON.stringify(intentRules) +
        kbFingerprint
    )
    .digest('hex')
    .slice(0, 16);

  return { systemMessage, tools, keywordMap, intentRules, hash };
}

// ---------------------------------------------------------------------------
// จำลองการสืบค้นฐานความรู้ด้วยตรรกะเดียวกับระบบจริง
// ---------------------------------------------------------------------------
function loadKnowledgeBase() {
  // ค้นไฟล์ seed อัตโนมัติ ไม่เขียนรายชื่อไว้ตายตัว
  //
  // เหตุผล เคยเขียนรายชื่อไฟล์ไว้ในโค้ดแล้วลืมเติมเมื่อเพิ่มฐานความรู้ชุดใหม่
  // ผลคือการวัดใช้ฐานความรู้เก่ากว่าที่อยู่ในฐานข้อมูลจริง
  // ตัวเลขที่ได้จึงไม่ใช่ความสามารถของระบบที่ผู้ใช้เจอ ซึ่งเป็นความผิดพลาดที่มองไม่เห็น
  // เพราะสคริปต์ยังรันผ่านตามปกติ ไม่มีข้อความแจ้งเตือนใด ๆ
  const dir = path.join(ROOT, 'postgres');
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^seed-tax-(law|forms).*\.sql$/.test(f))
    .sort()
    .map((f) => path.join('postgres', f));

  if (files.length === 0) {
    throw new Error('ไม่พบไฟล์ฐานความรู้ใน postgres/ เลย');
  }

  const recs = [];
  const re = /\(\s*'([^']+)',\s*'([^']+)',\s*'((?:[^']|'')*)',\s*'([^']*)',\s*(\d+)\s*\)/g;
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const sql = fs.readFileSync(p, 'utf8');
    let m;
    while ((m = re.exec(sql)) !== null) {
      recs.push({
        category: m[1],
        title: m[2],
        content: m[3].replace(/''/g, "'"),
        source: m[4],
      });
    }
  }

  // ไฟล์ seed มีคำสั่งลบรายการที่ถูกแทนที่แล้วอยู่ท้ายไฟล์
  // ถ้าไม่จำลองการลบด้วย ผลที่วัดแบบออฟไลน์จะไม่ตรงกับฐานข้อมูลจริง
  const fullPath = path.join(ROOT, 'postgres/seed-tax-law-full.sql');
  if (fs.existsSync(fullPath)) {
    const sql = fs.readFileSync(fullPath, 'utf8');
    const block = /AND title IN \(([\s\S]*?)\);/.exec(sql);
    if (block) {
      const titles = new Set((block[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)));
      return recs.filter((r) => !(titles.has(r.title) && !r.source.includes('[ชุดที่ 3]')));
    }
  }
  return recs;
}

// ---------------------------------------------------------------------------
// จำแนกเจตนาด้วยกฎชุดเดียวกับโหนด Build Context ในระบบจริง
// ---------------------------------------------------------------------------
// อ่านจากไฟล์ n8n/intent-rules.json ซึ่ง build-workflow.py เขียนไว้
// และเป็นไฟล์เดียวกับที่ฝังลงในเวิร์กโฟลว์ จึงไม่มีทางเพี้ยนจากกัน
function loadIntentRules() {
  const p = path.join(ROOT, 'n8n/intent-rules.json');
  if (!fs.existsSync(p)) {
    throw new Error('ไม่พบ n8n/intent-rules.json ให้รัน python n8n/build-workflow.py ก่อน');
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function classifyIntent(question, rules) {
  const q = (question || '').toLowerCase();
  const hasDigit = /[0-9\u0e50-\u0e59]/.test(q);
  let category = 'อื่นๆ';
  for (const rule of rules.intentRules) {
    const matched = rule.keywords.some((k) => q.indexOf(k) >= 0);
    if (matched && (!rule.requireDigit || hasDigit)) {
      category = rule.category;
      break;
    }
  }
  if (category === 'อื่นๆ' && hasDigit && rules.incomeWords.some((k) => q.indexOf(k) >= 0)) {
    category = 'คำนวณภาษี';
  }
  if (category === 'อื่นๆ' && q.indexOf('ภาษี') >= 0) category = 'กฎหมายภาษี';
  return category;
}

function retrieve(question, keywordMap, kb, limit = 3) {
  const q = (question || '').toLowerCase();
  const found = [];
  for (const [trigger, term] of keywordMap) {
    if (q.indexOf(trigger) >= 0 && found.indexOf(term) < 0) found.push(term);
  }
  const keys = found.length ? found : ['ภาษี'];

  const scored = kb
    .map((r) => {
      const t = r.title.toLowerCase();
      const c = r.category.toLowerCase();
      const b = r.content.toLowerCase();
      // น้ำหนักเดียวกับคำสั่ง SQL ในระบบจริง: ชื่อเรื่อง x5, หมวด x3, เนื้อหา x1
      const score =
        keys.filter((k) => t.includes(k)).length * 5 +
        keys.filter((k) => c.includes(k)).length * 3 +
        keys.filter((k) => b.includes(k)).length;
      return { ...r, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const context = scored.length
    ? scored
        .map((r, i) => `[${i + 1}] หมวด: ${r.category}\nหัวข้อ: ${r.title}\n${r.content}\nแหล่งที่มา: ${r.source}`)
        .join('\n\n---\n\n')
    : 'ไม่พบข้อมูลที่ตรงกับคำถามนี้ในฐานความรู้ ให้ตอบจากความรู้ทั่วไปด้านภาษี และแนะนำให้ผู้ใช้ตรวจสอบกับกรมสรรพากรอีกครั้ง';

  return { context, hits: scored.length, titles: scored.map((r) => r.title) };
}

// ---------------------------------------------------------------------------
// เรียก API พร้อมควบคุมจังหวะและลองใหม่อัตโนมัติ
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
let apiTimeMs = 0;
let promptCharsMax = 0;

async function chat(provider, messages, tools) {
  const minGap = provider.rpmLimit > 0 ? Math.ceil(60000 / provider.rpmLimit) : 0;
  for (let attempt = 1; ; attempt++) {
    if (minGap) {
      const wait = minGap - (Date.now() - lastCall);
      if (wait > 0) await sleep(wait);
    }
    lastCall = Date.now();

    const body = { model: provider.model, messages, temperature: 0.3 };
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const t0 = Date.now();
    let res, text;
    try {
      res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180000),
      });
      text = await res.text();
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(5000 * attempt);
      continue;
    }

    if (res.ok) {
      apiTimeMs += Date.now() - t0;
      return JSON.parse(text);
    }

    // แยกให้ออกว่าเป็นโควตา "รายวัน" หรือ "รายนาที" เพราะแก้คนละวิธี
    // รายนาที = ยิงเร็วเกินไป ปรับ GEMINI_RPM_LIMIT ให้ต่ำลงแล้วรันต่อได้เลย
    // รายวัน   = โควตาของวันนี้หมดแล้ว รอข้ามวันอย่างเดียว รอในสคริปต์ไม่มีประโยชน์
    // Google ระบุไว้ในฟิลด์ quotaId เช่น GenerateRequestsPerDayPerProjectPerModel
    const isDailyQuota = /PerDay|per day|daily/i.test(text);
    if (res.status === 429 && isDailyQuota) {
      throw new Error('โควตารายวันของแบบจำลองหมดแล้ว ต้องรอรีเซ็ตข้ามวัน');
    }

    const retryable = res.status === 429 || res.status === 503 || res.status === 500;
    if (retryable && attempt < 5) {
      const m = /"retryDelay"\s*:\s*"(\d+)s"/.exec(text);
      const wait = m ? Number(m[1]) * 1000 : Math.min(10000 * 2 ** (attempt - 1), 90000);
      process.stdout.write(`\r    ถูกจำกัดอัตราการเรียก (${res.status}) รอ ${Math.round(wait / 1000)} วินาที...`);
      await sleep(wait);
      process.stdout.write('\r' + ' '.repeat(80) + '\r');
      continue;
    }

    let detail = text.slice(0, 150);
    try {
      const p = JSON.parse(text);
      detail = (Array.isArray(p) ? p[0] : p)?.error?.message || detail;
    } catch (_) {}
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 150)}`);
  }
}

const TOOL_IMPL = {
  calculate_thai_personal_income_tax: calculateThaiPIT,
  calculate_late_filing_penalty: calculateLatePenalty,
};

/** ถามระบบหนึ่งคำถาม โดยจำลองเส้นทางเดียวกับที่รันจริง */
async function askSystem(provider, cfg, kb, question) {
  apiTimeMs = 0;
  const category = classifyIntent(question, cfg.intentRules);
  const needsCalc = cfg.intentRules.calcCategories.indexOf(category) >= 0;
  // คำถามคำนวณใช้บริบทเพียง 2 รายการเหมือนระบบจริง เพื่อลดสิ่งรบกวนและลดขนาดข้อมูลนำเข้า
  const { context, hits, titles } = retrieve(question, cfg.keywordMap, kb, needsCalc ? 2 : 3);

  // แทนที่นิพจน์ของ n8n ในคำสั่งระบบด้วยค่าจริง
  const systemMessage = cfg.systemMessage
    .replace(/\{\{\s*\$json\.retrievedContext\s*\}\}/g, context)
    .replace(/\{\{[^}]*display_name[^}]*\}\}/g, 'ผู้ทดสอบระบบ')
    .replace(/\{\{[^}]*questionCategory[^}]*\}\}/g, category);

  // ต่อคำสั่งกำกับท้ายคำถามเมื่อกฎบอกว่าต้องใช้เครื่องคำนวณ ตรงกับที่ Build Context ทำ
  const userContent = needsCalc ? question + cfg.intentRules.calcDirective : question;

  const messages = [
    { role: 'system', content: systemMessage },
    { role: 'user', content: userContent },
  ];
  const toolDefs = cfg.tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));

  // ประมาณขนาดข้อมูลนำเข้า ใช้เตือนเรื่องหน้าต่างบริบทของแบบจำลองที่รันในเครื่อง
  // Ollama ตัดข้อมูลที่เกินหน้าต่างทิ้ง "จากด้านหน้า" โดยไม่แจ้งเตือน
  // ซึ่งด้านหน้าคือคำสั่งระบบและกฎหมายที่ค้นมา อาการที่เห็นคือแบบจำลองตอบมั่วหรือเงียบ
  const promptChars = systemMessage.length + question.length + JSON.stringify(toolDefs).length;
  promptCharsMax = Math.max(promptCharsMax, promptChars);

  let toolsCalled = [];
  let toolArgs = [];
  let resp = await chat(provider, messages, toolDefs);
  let choice = resp.choices?.[0];

  // รองรับการเรียกเครื่องมือหลายรอบ เหมือน AI Agent ของ n8n
  // n8n ตั้งค่าเริ่มต้นไว้ที่ 10 รอบ ที่นี่ใช้ 6 รอบเพื่อไม่ให้วนนานเกินไป
  // แต่ยังเผื่อกรณีที่แบบจำลองต้องเรียกเครื่องมือหลายครั้งจริง ๆ
  const MAX_ROUNDS = 6;
  let rounds = 0;
  let stillWantsTool = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const calls = choice?.message?.tool_calls;
    if (!calls || calls.length === 0) break;
    rounds++;
    if (round === MAX_ROUNDS - 1) stillWantsTool = true;
    messages.push(choice.message);
    for (const call of calls) {
      const fn = TOOL_IMPL[call.function.name];
      toolsCalled.push(call.function.name);
      // บันทึกข้อมูลนำเข้าที่แบบจำลองส่งให้เครื่องมือด้วย
      // เพราะเมื่อเรียกเครื่องมือแล้วแต่ได้ตัวเลขผิด สาเหตุอยู่ที่ข้อมูลนำเข้าเสมอ
      // ถ้าไม่บันทึกไว้ จะรู้แค่ว่า "ผิด" แต่ไม่รู้ว่าผิดเพราะอ่านโจทย์ตรงไหนพลาด
      toolArgs.push(call.function.arguments || '{}');
      let out;
      try {
        out = fn ? fn(JSON.parse(call.function.arguments || '{}')) : { ข้อผิดพลาด: 'ไม่รู้จักเครื่องมือนี้' };
      } catch (e) {
        out = { สำเร็จ: false, ข้อผิดพลาด: String(e.message) };
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out) });
    }
    resp = await chat(provider, messages, toolDefs);
    choice = resp.choices?.[0];
  }

  const msg = choice?.message || {};
  const answer = String(msg.content || '').trim();

  // วินิจฉัยสาเหตุเมื่อไม่มีข้อความตอบกลับ
  // แยกให้ชัดว่า "แบบจำลองเงียบ" กับ "แบบจำลองวนเรียกเครื่องมือไม่ยอมสรุป" ไม่เหมือนกัน
  // เพราะสองกรณีนี้ต้องแก้คนละทาง และมีนัยต่อการนำไปใช้จริงต่างกัน
  let emptyReason = '';
  if (!answer) {
    const thinking = String(msg.reasoning_content || msg.reasoning || msg.thinking || '').trim();
    if (stillWantsTool) emptyReason = `วนเรียกเครื่องมือครบ ${MAX_ROUNDS} รอบโดยไม่สรุปคำตอบ`;
    else if (thinking) emptyReason = 'มีแต่ความคิดภายใน ไม่ได้ส่งข้อความให้ผู้ใช้';
    else emptyReason = 'แบบจำลองส่งข้อความว่างกลับมา';
  }

  return {
    answer,
    emptyReason,
    rounds,
    toolsCalled,
    toolArgs,
    knowledgeHits: hits,
    knowledgeTitles: titles,
    responseTimeMs: apiTimeMs,
  };
}

// ---------------------------------------------------------------------------
// การตรวจคำตอบ
// ---------------------------------------------------------------------------
function numbersIn(text) {
  return (String(text).match(/[\d,]+(?:\.\d+)?/g) || [])
    .map((s) => Number(s.replace(/,/g, '')))
    .filter(Number.isFinite);
}

function grade(q, r) {
  const a = r.answer || '';
  if (!a) return { pass: false, reason: r.emptyReason || 'ไม่มีคำตอบ' };

  // คำตอบที่เป็นข้อมูลดิบถือว่าไม่ผ่านทันที
  if (/^[\s`]*[{[]/.test(a)) return { pass: false, reason: 'ตอบเป็นข้อมูลดิบ ไม่ใช่ภาษาที่ผู้ใช้อ่านได้' };

  if (q.check === 'exactNumber') {
    if (q.requiresTool && r.toolsCalled.length === 0) {
      return { pass: false, reason: 'ไม่ได้เรียกเครื่องมือคำนวณ ตัวเลขจึงเชื่อถือไม่ได้' };
    }
    // กรณีคำตอบที่ถูกต้องคือ "ไม่ต้องเสียภาษี" (ภาษี = 0 บาท)
    // การเขียนว่า "ไม่ต้องเสียภาษีค่ะ" ถูกต้องและเป็นธรรมชาติกว่าการเขียนเลข 0
    // ถ้าตรวจแค่ตัวเลข จะตัดสินว่าผิดทั้งที่ระบบตอบถูก จึงต้องรับรูปประโยคนี้ด้วย
    // เงื่อนไขคือต้องเรียกเครื่องมือคำนวณแล้วเท่านั้น ผลลัพธ์ 0 จึงตรวจสอบย้อนกลับได้
    if (q.expected === 0) {
      const saysNoTax =
        /ไม่ต้อง(เสีย|ชำระ)ภาษี|ไม่มีภาษีที่ต้อง(เสีย|ชำระ)|ได้รับยกเว้นภาษี|ภาษี\s*(ที่ต้องชำระ)?\s*(คือ|เท่ากับ|เป็น)?\s*0\s*บาท/.test(a);
      const hasZero = numbersIn(a).some((n) => n === 0);
      if (saysNoTax || hasZero) {
        return { pass: true, reason: 'ตอบถูกว่าไม่ต้องเสียภาษี' };
      }
      return { pass: false, reason: 'ไม่ได้ระบุชัดว่าไม่ต้องเสียภาษี' };
    }

    const found = numbersIn(a).some((n) => Math.abs(n - q.expected) < 1);
    return {
      pass: found,
      reason: found ? `พบ ${q.expected.toLocaleString('en-US')}` : `ไม่พบ ${q.expected.toLocaleString('en-US')}`,
    };
  }

  if (q.check === 'keywords') {
    const missing = q.expected.filter((k) => !a.includes(k));
    return { pass: missing.length === 0, reason: missing.length ? `ขาด: ${missing.join(', ')}` : 'ครบ' };
  }

  if (q.check === 'scope') {
    const ok = q.expected.some((k) => a.includes(k));
    return { pass: ok, reason: ok ? 'แจ้งขอบเขตถูกต้อง' : 'ไม่ได้แจ้งขอบเขต' };
  }

  return { pass: false, reason: 'ไม่รู้จักเกณฑ์ตรวจ' };
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

// ---------------------------------------------------------------------------
// ส่วนหลัก
// ---------------------------------------------------------------------------
async function main() {
  const args = { runs: 1, model: 'gemini', fresh: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--runs=')) args.runs = Math.max(1, parseInt(a.slice(7), 10) || 1);
    if (a.startsWith('--model=')) args.model = a.slice(8).trim();
    if (a === '--fresh') args.fresh = true;
  }

  const provider = PROVIDERS[args.model];
  if (!provider) {
    console.error(`ไม่รู้จักผู้ให้บริการ "${args.model}" เลือกได้: ${Object.keys(PROVIDERS).join(', ')}`);
    process.exit(1);
  }
  if (!provider.apiKey) {
    console.error(`ไม่พบกุญแจ API ของ ${provider.label} ในไฟล์ .env`);
    process.exit(1);
  }

  const cfg = loadProductionConfig();
  const kb = loadKnowledgeBase();
  const dataset = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'test-questions-official.json'), 'utf8')
  );
  const questions = dataset.questions;

  console.log('='.repeat(78));
  console.log('  การวัดความแม่นยำของระบบที่ปรึกษาด้านภาษี (ตามการตั้งค่าที่ใช้งานจริง)');
  console.log('='.repeat(78));
  console.log(`แบบจำลองภาษา    : ${provider.label} (${provider.model})`);
  console.log(`ฐานความรู้        : ${kb.length} รายการ`);
  console.log(`เครื่องมือที่ให้ AI : ${cfg.tools.map((t) => t.name).join(', ')}`);
  console.log(`คำสั่งระบบ        : อ่านจากไฟล์ workflow ${cfg.systemMessage.length.toLocaleString('en-US')} ตัวอักษร`);
  console.log(`ชุดคำถาม          : ${questions.length} ข้อ x ${args.runs} รอบ\n`);

  // -------------------------------------------------------------------------
  // จุดบันทึกความคืบหน้า (checkpoint)
  // -------------------------------------------------------------------------
  // แบบจำลองแบบใช้ฟรีมีโควตาต่อวัน เมื่อโควตาหมดกลางทางจะเสียผลที่วัดไปแล้วทั้งหมด
  // จึงบันทึกผลรายข้อลงไฟล์ทันทีที่วัดเสร็จ แล้วรอบถัดไปข้ามข้อที่วัดแล้ว
  // ทำให้แบ่งวัดได้หลายวันโดยผลยังต่อกันเป็นชุดเดียว
  const RESULT_DIR = path.join(__dirname, 'results');
  fs.mkdirSync(RESULT_DIR, { recursive: true });
  const ckptFile = path.join(RESULT_DIR, `.checkpoint-${args.model}.json`);

  let checkpoint = {};
  if (!args.fresh && fs.existsSync(ckptFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(ckptFile, 'utf8'));
      // ใช้ผลเดิมได้เฉพาะเมื่อการตั้งค่าไม่เปลี่ยน มิฉะนั้นผลจะปนกันคนละเวอร์ชัน
      if (saved.configHash === cfg.hash && saved.model === provider.model) {
        checkpoint = saved.records || {};
        const n = Object.keys(checkpoint).length;
        if (n) console.log(`พบผลที่วัดไว้แล้ว ${n} รายการ จะวัดต่อจากของเดิม (ใช้ --fresh เพื่อเริ่มใหม่)\n`);
      } else {
        console.log('การตั้งค่าเปลี่ยนไปจากครั้งก่อน จึงเริ่มวัดใหม่ทั้งหมด\n');
      }
    } catch (_) {}
  }

  const saveCheckpoint = () => {
    fs.writeFileSync(
      ckptFile,
      JSON.stringify({ configHash: cfg.hash, model: provider.model, records: checkpoint }, null, 2),
      'utf8'
    );
  };

  let quotaFails = 0;
  let stoppedEarly = false;

  const rows = [];
  for (const q of questions) {
    for (let run = 1; run <= args.runs; run++) {
      const key = `${q.id}#${run}`;
      if (checkpoint[key]) {
        rows.push(checkpoint[key]);
        console.log(`  ${q.id} ${checkpoint[key].ผล.padEnd(7)} ${String(checkpoint[key].เวลา_ms).padStart(6)} ms  ${q.category.padEnd(14)} (ผลเดิม)`);
        continue;
      }
      if (stoppedEarly) break;
      const rec = {
        รหัส: q.id, หมวด: q.category, ความยาก: q.difficulty, รอบที่: run,
        คำถาม: q.question, ผล: '', เหตุผล: '',
        เรียกเครื่องมือ: '', ข้อมูลที่ส่งให้เครื่องมือ: '', รอบที่เรียกเครื่องมือ: '', ความรู้ที่ค้นเจอ: '', เวลา_ms: '', คำตอบ: '',
        ฐานกฎหมาย: q.ฐานกฎหมาย || '', แหล่งอ้างอิง: (q.แหล่งอ้างอิง || []).join(' '),
      };
      try {
        const r = await askSystem(provider, cfg, kb, q.question);
        const g = grade(q, r);
        rec.ผล = g.pass ? 'ผ่าน' : 'ไม่ผ่าน';
        rec.เหตุผล = g.reason;
        rec.เรียกเครื่องมือ = r.toolsCalled.join(',') || '-';
        rec.ข้อมูลที่ส่งให้เครื่องมือ = (r.toolArgs || []).join(' ; ');
        rec.รอบที่เรียกเครื่องมือ = r.rounds;
        rec.ความรู้ที่ค้นเจอ = r.knowledgeTitles.join(' | ');
        rec.เวลา_ms = r.responseTimeMs;
        rec.คำตอบ = r.answer.replace(/\s+/g, ' ').slice(0, 600);
        console.log(`  ${q.id} ${g.pass ? 'ผ่าน   ' : 'ไม่ผ่าน'} ${String(r.responseTimeMs).padStart(6)} ms  ${q.category.padEnd(14)} ${g.reason}`);
        quotaFails = 0;
        checkpoint[key] = rec;
        saveCheckpoint();
      } catch (e) {
        const msg = String(e.message);
        rec.ผล = 'ผิดพลาด';
        rec.เหตุผล = msg.slice(0, 150);
        // ข้อผิดพลาดเรื่องโควตาไม่ใช่ "ตอบผิด" จึงไม่บันทึกลง checkpoint
        // และไม่นับรวมในความแม่นยำ เพราะระบบยังไม่ได้ตอบอะไรเลย
        const isQuota = /HTTP 429|quota|โควตา|rate limit/i.test(msg);
        const isDaily = /รายวัน/.test(msg);
        if (isQuota) {
          quotaFails++;
          console.log(`  ${q.id} ยังไม่ได้วัด  ${isDaily ? 'โควตารายวันหมด' : 'โควตาแบบจำลองหมด'}`);
          // โควตารายวันไม่มีทางฟื้นภายในการรันครั้งนี้ หยุดทันทีไม่ต้องรอครบ 3 ครั้ง
          if (isDaily) {
            stoppedEarly = true;
            console.log('\n  หยุดการวัด เพราะโควตารายวันของแบบจำลองหมดแล้ว');
            console.log('  โควตารีเซ็ตเที่ยงคืนเวลาแปซิฟิก (ประมาณ 14:00 น. เวลาไทย)');
            console.log('  รันคำสั่งเดิมอีกครั้งหลังรีเซ็ต ระบบจะวัดต่อจากข้อที่ค้างไว้เอง');
          } else if (quotaFails >= 3) {
            stoppedEarly = true;
            console.log('\n  หยุดการวัดชั่วคราว เพราะโควตาของแบบจำลองหมดแล้ว');
            console.log('  ผลที่วัดได้แล้วถูกบันทึกไว้ รันคำสั่งเดิมอีกครั้งเมื่อโควตากลับมาเพื่อวัดต่อ');
          }
        } else {
          console.log(`  ${q.id} ผิดพลาด  ${rec.เหตุผล}`);
        }
      }
      rows.push(rec);
    }
    if (stoppedEarly) break;
  }

  // -------------------------------------------------------------------------
  // สรุปผล
  // -------------------------------------------------------------------------
  const done = rows.filter((r) => r.ผล !== 'ผิดพลาด');
  const pass = done.filter((r) => r.ผล === 'ผ่าน');
  const times = done.filter((r) => typeof r.เวลา_ms === 'number').map((r) => r.เวลา_ms);
  const overall = done.length ? (pass.length / done.length) * 100 : 0;

  console.log('\n' + '='.repeat(78));
  console.log('  สรุปผล');
  console.log('='.repeat(78));
  const totalPlanned = questions.length * args.runs;
  const notMeasured = totalPlanned - done.length;
  console.log(`\nความแม่นยำโดยรวม : ${overall.toFixed(1)}%  (${pass.length}/${done.length} ข้อ)`);
  if (notMeasured > 0) {
    console.log(`ยังไม่ได้วัด      : ${notMeasured} ข้อ จากทั้งหมด ${totalPlanned} ข้อ`);
    console.log('                    ตัวเลขข้างต้นคิดจากเฉพาะข้อที่วัดได้ ยังสรุปผลไม่ได้');
  }
  console.log(`เวลาตอบสนองเฉลี่ย : ${mean(times).toFixed(0)} ms  (SD ${sd(times).toFixed(0)})`);

  const group = (key) => {
    const g = {};
    for (const r of done) {
      g[r[key]] = g[r[key]] || { total: 0, pass: 0 };
      g[r[key]].total++;
      if (r.ผล === 'ผ่าน') g[r[key]].pass++;
    }
    return g;
  };

  console.log('\nแยกตามหมวดคำถาม');
  for (const [k, v] of Object.entries(group('หมวด'))) {
    const p = ((v.pass / v.total) * 100).toFixed(1);
    console.log(`  ${k.padEnd(16)} ${String(p).padStart(6)}%  (${v.pass}/${v.total})`);
  }

  console.log('\nแยกตามระดับความยาก');
  for (const k of ['ง่าย', 'ปานกลาง', 'ยาก']) {
    const v = group('ความยาก')[k];
    if (!v) continue;
    const p = ((v.pass / v.total) * 100).toFixed(1);
    console.log(`  ${k.padEnd(16)} ${String(p).padStart(6)}%  (${v.pass}/${v.total})`);
  }

  // ตัวชี้วัดที่สำคัญที่สุดต่อความปลอดภัยในการใช้งานจริง
  const needTool = done.filter((r) => {
    const q = questions.find((x) => x.id === r.รหัส);
    return q && q.requiresTool;
  });
  const usedTool = needTool.filter((r) => r.เรียกเครื่องมือ !== '-');
  console.log('\nตัวชี้วัดด้านความปลอดภัย');
  console.log(`  เรียกเครื่องมือคำนวณเมื่อจำเป็น : ${needTool.length ? ((usedTool.length / needTool.length) * 100).toFixed(1) : '-'}%  (${usedTool.length}/${needTool.length})`);
  const calcQ = done.filter((r) => r.หมวด === 'คำนวณภาษี' || r.หมวด === 'บทลงโทษ');
  const calcPass = calcQ.filter((r) => r.ผล === 'ผ่าน');
  console.log(`  ความถูกต้องของคำถามที่มีตัวเลข : ${calcQ.length ? ((calcPass.length / calcQ.length) * 100).toFixed(1) : '-'}%  (${calcPass.length}/${calcQ.length})`);

  // -------------------------------------------------------------------------
  // ตัวชี้วัดที่ 2: ความไวในการตอบ
  // -------------------------------------------------------------------------
  // เพดานที่แท้จริงไม่ใช่ความอดทนของผู้ใช้ แต่เป็นอายุของ reply token ของ LINE
  // ซึ่งหมดอายุประมาณ 60 วินาที เกินกว่านั้นคือผู้ใช้ไม่ได้รับคำตอบเลย
  const LINE_TOKEN_LIMIT_MS = 60000;
  const GOOD_UX_MS = 20000;
  const overLimit = times.filter((t) => t > LINE_TOKEN_LIMIT_MS).length;
  const overUx = times.filter((t) => t > GOOD_UX_MS).length;
  console.log('\nตัวชี้วัดด้านความไวในการตอบ');
  if (times.length) {
    const sorted = [...times].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    console.log(`  เวลาตอบช้าที่สุด (P95)          : ${(p95 / 1000).toFixed(1)} วินาที`);
    console.log(`  เกิน 60 วินาที (reply token หมดอายุ) : ${overLimit} ข้อ จาก ${times.length}`);
    console.log(`  เกิน 20 วินาที (ผู้ใช้เริ่มรู้สึกช้า)  : ${overUx} ข้อ จาก ${times.length}`);
    if (overLimit > 0) {
      console.log('  แปลว่าในการใช้งานจริง ผู้ใช้จะไม่ได้รับคำตอบเลยในข้อเหล่านั้น');
      console.log('  แม้คำตอบจะถูกต้อง เพราะ LINE ปฏิเสธ reply token ที่หมดอายุแล้ว');
    }
  }

  // -------------------------------------------------------------------------
  // ตัวชี้วัดที่ 3: ความครบถ้วนของฐานความรู้
  // -------------------------------------------------------------------------
  // คำถามที่ค้นฐานความรู้ไม่เจอเลย แปลว่าแบบจำลองต้องตอบจากความรู้ทั่วไป
  // ซึ่งตรวจสอบย้อนกลับไปยังตัวบทกฎหมายไม่ได้ จึงเป็นช่องโหว่ที่ต้องอุด
  const noHit = done.filter((r) => !r.ความรู้ที่ค้นเจอ);
  const hitRate = done.length ? ((done.length - noHit.length) / done.length) * 100 : 0;
  console.log('\nตัวชี้วัดด้านความครบถ้วนของฐานความรู้');
  console.log(`  ค้นเจอข้อมูลอ้างอิง            : ${hitRate.toFixed(1)}%  (${done.length - noHit.length}/${done.length})`);
  if (noHit.length) {
    console.log(`  คำถามที่ค้นไม่เจอเลย ${noHit.length} ข้อ (ตอบจากความรู้ทั่วไป ตรวจสอบย้อนกลับไม่ได้)`);
    for (const r of noHit) console.log(`    ${r.รหัส} [${r.หมวด}] ${String(r.คำถาม).slice(0, 50)}`);
    console.log('  วิธีอุด: เพิ่มข้อมูลใน postgres/seed-tax-law-extra.sql');
    console.log('           หรือเพิ่มคำสำคัญใน DOMAIN_KEYWORDS ของ n8n/build-workflow.py');
  }

  // ขนาดข้อมูลนำเข้า เทียบกับหน้าต่างบริบทเริ่มต้นของ Ollama (4,096 โทเคน)
  // ภาษาไทยกินโทเคนมากกว่าภาษาอังกฤษ ประมาณ 1 โทเคนต่อ 1.5 ตัวอักษร
  const estTokens = Math.round(promptCharsMax / 1.5);
  console.log(`\nขนาดข้อมูลนำเข้าสูงสุด : ${promptCharsMax.toLocaleString('en-US')} ตัวอักษร (~${estTokens.toLocaleString('en-US')} โทเคน)`);

  // ถามค่า num_ctx จริงจาก Ollama แทนการเดา จะได้ไม่เตือนผิดหลังผู้ใช้แก้ไขแล้ว
  let ollamaCtx = null;
  if (args.model === 'typhoon') {
    try {
      const base = (ENV.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/v1\/?$/, '');
      const res = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: provider.model }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const info = await res.json();
        const m = /num_ctx\s+(\d+)/.exec(info.parameters || '');
        ollamaCtx = m ? Number(m[1]) : 4096; // ไม่ได้ตั้งไว้ = ใช้ค่าเริ่มต้น
      }
    } catch (_) {
      // ถามไม่ได้ก็ไม่เป็นไร จะกลับไปใช้การเดาแบบเดิม
    }
    if (ollamaCtx !== null) {
      console.log(`หน้าต่างบริบทของแบบจำลอง : ${ollamaCtx.toLocaleString('en-US')} โทเคน (อ่านจาก Ollama โดยตรง)`);
    }
  }

  const ctxLimit = ollamaCtx !== null ? ollamaCtx : 4096;
  if (args.model === 'typhoon' && estTokens > ctxLimit * 0.85) {
    console.log(`  คำเตือน: ข้อมูลนำเข้าใกล้เต็มหน้าต่างบริบท (${ctxLimit.toLocaleString('en-US')} โทเคน)`);
    console.log('  Ollama จะตัดข้อมูลส่วนหน้าทิ้งเงียบ ๆ ซึ่งคือคำสั่งระบบและกฎหมายที่ค้นมา');
    console.log('  ผลที่วัดได้ในสภาพนี้ไม่ได้สะท้อนความสามารถจริงของแบบจำลอง');
    console.log('  วิธีแก้: สร้างแบบจำลองที่ตั้งหน้าต่างบริบทใหม่ ดู n8n/ollama/README.md');
  }

  const failed = done.filter((r) => r.ผล !== 'ผ่าน');

  // จัดกลุ่มสาเหตุที่ไม่ผ่าน เพื่อให้เห็นว่าควรแก้ตรงไหนก่อน
  // สาเหตุที่พบบ่อยที่สุดคือจุดที่ให้ผลตอบแทนสูงสุดเมื่อแก้
  if (failed.length) {
    const bucket = (reason) => {
      if (/วนเรียกเครื่องมือ/.test(reason)) return 'วนเรียกเครื่องมือไม่ยอมสรุปคำตอบ';
      if (/ความคิดภายใน|ข้อความว่าง|ไม่มีคำตอบ/.test(reason)) return 'ไม่ส่งข้อความตอบกลับ';
      if (/ข้อมูลดิบ/.test(reason)) return 'ตอบเป็นข้อมูลดิบ';
      if (/ไม่ได้เรียกเครื่องมือ/.test(reason)) return 'ไม่เรียกเครื่องมือคำนวณ';
      if (/^ไม่พบ/.test(reason)) return 'ตัวเลขไม่ตรง';
      if (/^ขาด/.test(reason)) return 'เนื้อหาไม่ครบตามที่กฎหมายกำหนด';
      return 'อื่นๆ';
    };
    const tally = {};
    for (const r of failed) tally[bucket(r.เหตุผล)] = (tally[bucket(r.เหตุผล)] || 0) + 1;
    console.log('\nสาเหตุที่ไม่ผ่าน (เรียงจากพบบ่อยที่สุด)');
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(3)} ข้อ  ${k}`);
    }
  }

  console.log('\nรายการที่ไม่ผ่าน');
  if (failed.length === 0) console.log('  ไม่มี');
  for (const r of failed) console.log(`  ${r.รหัส} [${r.หมวด}] ${r.เหตุผล}`);

  // -------------------------------------------------------------------------
  // บันทึกไฟล์
  // -------------------------------------------------------------------------
  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const headers = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
  // ชื่อแบบจำลองบางตัวมีเครื่องหมาย / เช่น scb10x/typhoon2.5-qwen3-4b
  // ซึ่งใช้เป็นชื่อไฟล์ไม่ได้ ต้องแทนที่ก่อน
  const safeModel = provider.model.replace(/[\\/:*?"<>|]/g, '-');
  const file = path.join(outDir, `accuracy-${safeModel}-${stamp}.csv`);
  fs.writeFileSync(file, '﻿' + csv, 'utf8');

  console.log(`\nบันทึกผลรายข้อไว้ที่: ${file}`);

  // -------------------------------------------------------------------------
  // การตีความผลเพื่อตัดสินใจนำไปใช้จริง
  // -------------------------------------------------------------------------
  console.log('\n' + '='.repeat(78));
  console.log('  การตีความผล');
  console.log('='.repeat(78));
  const toolRate = needTool.length ? (usedTool.length / needTool.length) * 100 : 0;
  if (notMeasured > 0) {
    console.log(`  ยังสรุปไม่ได้ เพราะวัดได้เพียง ${done.length} จาก ${totalPlanned} ข้อ`);
    console.log('  ให้รันคำสั่งเดิมซ้ำเมื่อโควตากลับมา ระบบจะวัดต่อจากข้อที่ค้างไว้เอง');
    console.log('  หรือใช้ --model=typhoon ซึ่งรันในเครื่อง ไม่มีโควตาจำกัด\n');
  }
  // สรุปสามด้านที่ตกลงกันว่าใช้ตัดสิน: ความถูกต้อง ความไว ความครบถ้วนของฐานความรู้
  // ระบบจะพร้อมใช้จริงก็ต่อเมื่อผ่านครบทั้งสามด้าน ไม่ใช่ผ่านด้านเดียว
  const pass3 = {
    'ความถูกต้อง (≥80%)': overall >= 80,
    'ตอบทันก่อน reply token หมดอายุ': overLimit === 0,
    'ฐานความรู้ครอบคลุม (≥90%)': hitRate >= 90,
  };
  console.log('  สรุปสามด้านที่ใช้ตัดสิน');
  for (const [k, v] of Object.entries(pass3)) {
    console.log(`    ${v ? 'ผ่าน    ' : 'ยังไม่ผ่าน'} ${k}`);
  }
  console.log('');

  if (overall >= 90 && toolRate >= 98) {
    console.log('  ผลอยู่ในระดับที่นำไปทดลองใช้กับผู้ใช้จริงได้ โดยยังต้องแสดงคำเตือนทุกครั้ง');
  } else if (overall >= 80) {
    console.log('  ผลอยู่ในระดับใช้สาธิตได้ แต่ยังไม่ควรเปิดให้ประชาชนทั่วไปใช้');
    console.log('  ให้ดูรายการที่ไม่ผ่านด้านบนว่าพลาดเพราะเหตุใด แล้วแก้ที่ต้นเหตุ');
  } else {
    console.log('  ผลยังไม่พร้อมนำไปใช้ ควรตรวจสอบรายการที่ไม่ผ่านและปรับปรุงก่อน');
  }
  if (toolRate < 100 && needTool.length) {
    console.log(`  ข้อควรระวัง: มี ${needTool.length - usedTool.length} ครั้งที่ระบบตอบตัวเลขโดยไม่ผ่านเครื่องมือคำนวณ`);
    console.log('  ตัวเลขเหล่านั้นไม่มีอะไรรับประกันความถูกต้อง ถือเป็นความเสี่ยงสูงสุดของระบบนี้');
  }
}

// เปิดให้สคริปต์อื่นนำตรรกะการอ่านการตั้งค่าและการสืบค้นไปใช้ซ้ำได้
// เพื่อไม่ให้มีโค้ดสืบค้นสองชุดที่อาจเพี้ยนจากกันเมื่อแก้ไขในอนาคต
module.exports = { loadProductionConfig, loadKnowledgeBase, retrieve };

if (require.main === module) {
  main().catch((e) => {
    console.error('\nเกิดข้อผิดพลาด:', e.message);
    process.exit(1);
  });
}
