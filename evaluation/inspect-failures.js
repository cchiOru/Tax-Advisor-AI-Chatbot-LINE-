/**
 * เปิดดูรายละเอียดของข้อที่ไม่ผ่าน จากไฟล์ผลการวัดล่าสุด
 *
 * ทำไมต้องมี
 *   ตัวเลขสรุปบอกว่า "ตก 15 ข้อ" แต่ไม่บอกว่าระบบตอบอะไรออกมา
 *   และที่สำคัญกว่าคือไม่บอกว่าส่งข้อมูลอะไรให้เครื่องคำนวณ
 *   ซึ่งเป็นจุดที่บอกได้ว่าแบบจำลองอ่านโจทย์พลาดตรงไหน
 *
 * วิธีใช้
 *   node evaluation/inspect-failures.js                 ดูไฟล์ล่าสุด
 *   node evaluation/inspect-failures.js --file=ชื่อไฟล์  ระบุไฟล์เอง
 *   node evaluation/inspect-failures.js --all           ดูทุกข้อไม่เฉพาะที่ตก
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'results');

function parseCsv(text) {
  // ตัด BOM ที่ใส่ไว้ให้ Excel อ่านภาษาไทยได้
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows
    .filter((r) => r.length === head.length)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const fileArg = args.find((a) => a.startsWith('--file='));

  let file;
  if (fileArg) {
    file = path.isAbsolute(fileArg.slice(7)) ? fileArg.slice(7) : path.join(DIR, fileArg.slice(7));
  } else {
    const files = fs
      .readdirSync(DIR)
      .filter((f) => f.startsWith('accuracy-') && f.endsWith('.csv'))
      .map((f) => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) return console.log('ไม่พบไฟล์ผลการวัดในโฟลเดอร์ evaluation/results');
    file = path.join(DIR, files[0].f);
  }

  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  console.log('ไฟล์:', path.basename(file));
  console.log('จำนวนข้อ:', rows.length, '\n');

  const target = showAll ? rows : rows.filter((r) => r.ผล !== 'ผ่าน');
  if (!target.length) return console.log('ไม่มีข้อที่ไม่ผ่าน');

  for (const r of target) {
    console.log('='.repeat(78));
    console.log(`${r.รหัส}  [${r.หมวด} / ${r.ความยาก}]  ${r.ผล}  ${r.เวลา_ms} ms`);
    console.log('เหตุผล   :', r.เหตุผล);
    console.log('คำถาม    :', r.คำถาม);
    const args2 = r['ข้อมูลที่ส่งให้เครื่องมือ'];
    if (args2 && args2 !== '') {
      console.log('ส่งให้เครื่องมือ:');
      for (const a of args2.split(' ; ')) {
        try {
          console.log('   ' + JSON.stringify(JSON.parse(a)));
        } catch (_) {
          console.log('   ' + a);
        }
      }
    } else if (r.เรียกเครื่องมือ === '-' || !r.เรียกเครื่องมือ) {
      console.log('ส่งให้เครื่องมือ: ไม่ได้เรียกเลย');
    }
    console.log('ความรู้ที่ค้นเจอ:', r.ความรู้ที่ค้นเจอ || '(ไม่มี)');
    console.log('คำตอบ    :', (r.คำตอบ || '').slice(0, 400));
    console.log();
  }

  // สรุปรูปแบบที่พบ เพื่อให้เห็นว่าควรแก้อะไรก่อน
  const noTool = target.filter((r) => /ไม่ได้เรียกเครื่องมือ/.test(r.เหตุผล));
  if (noTool.length) {
    const times = noTool.map((r) => Number(r.เวลา_ms)).filter(Number.isFinite);
    const ok = rows.filter((r) => r.ผล === 'ผ่าน' && r.เรียกเครื่องมือ && r.เรียกเครื่องมือ !== '-');
    const okTimes = ok.map((r) => Number(r.เวลา_ms)).filter(Number.isFinite);
    const avg = (a) => (a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : 0);
    console.log('='.repeat(78));
    console.log('ข้อสังเกตจากเวลา');
    console.log(`  ข้อที่ไม่เรียกเครื่องมือ ใช้เวลาเฉลี่ย ${avg(times).toLocaleString()} ms`);
    console.log(`  ข้อที่เรียกเครื่องมือแล้วผ่าน ใช้เวลาเฉลี่ย ${avg(okTimes).toLocaleString()} ms`);
    console.log('  ถ้าตัวเลขต่างกันมาก แปลว่าแบบจำลองตัดสินใจตอบทันทีโดยไม่คิดจะเรียกเครื่องมือ');
    console.log('  ไม่ใช่เรียกแล้วล้มเหลว ซึ่งเป็นคนละปัญหาและแก้คนละทาง');
  }
}

main();
