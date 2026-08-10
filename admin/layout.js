'use strict';
/**
 * ============================================================================
 *  โครงหน้าเว็บและตัวช่วยแสดงผล
 * ----------------------------------------------------------------------------
 *  หน้าเว็บนี้สร้าง HTML ที่ฝั่งเซิร์ฟเวอร์ทั้งหมด ไม่ใช้ JavaScript framework
 *
 *  เหตุผล
 *    ผู้ใช้มีคนเดียว ปริมาณข้อมูลน้อย และหน้าเว็บนี้ต้องอยู่ได้นานหลังส่งงาน
 *    การไม่พึ่ง framework ทำให้ไม่มีอะไรให้อัปเดตตามและไม่มีช่องโหว่จากไลบรารีภายนอก
 *    ทั้งโปรเจกต์นี้ใช้ npm package ตัวเดียวคือ pg สำหรับต่อฐานข้อมูล
 * ============================================================================
 */

/**
 * แปลงอักขระพิเศษของ HTML ให้ปลอดภัยก่อนนำไปแสดง
 *
 * ต้องเรียกกับทุกค่าที่มาจากฐานข้อมูลหรือจากฟอร์ม
 * ถ้าลืมแม้แต่ที่เดียว จะเปิดช่องให้ฝังสคริปต์ผ่านเนื้อหาความรู้ที่ผู้ดูแลกรอกเอง
 */
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** ใส่เครื่องหมายคั่นหลักพันให้ตัวเลขอ่านง่าย */
function เลข(v) {
  if (v === null || v === undefined || v === '') return '-';
  return Number(v).toLocaleString('th-TH');
}

const CSS = `
:root{
  --พื้นหลัง:#f6f7f9; --การ์ด:#ffffff; --เส้น:#e3e6ea;
  --ตัวอักษร:#1f2933; --รอง:#66727f; --เน้น:#1f6feb;
  --เตือน:#b45309; --อันตราย:#b91c1c; --ดี:#15803d;
}
*{box-sizing:border-box}
body{margin:0;font-family:"Sarabun","Segoe UI",system-ui,sans-serif;
  background:var(--พื้นหลัง);color:var(--ตัวอักษร);line-height:1.6}
header{background:var(--การ์ด);border-bottom:1px solid var(--เส้น);padding:0 24px}
header .แถบ{max-width:1100px;margin:0 auto;display:flex;align-items:center;gap:8px;
  height:56px;flex-wrap:wrap}
header .ชื่อ{font-weight:700;margin-right:16px}
header a{color:var(--รอง);text-decoration:none;padding:8px 12px;border-radius:6px;font-size:15px}
header a:hover{background:var(--พื้นหลัง);color:var(--ตัวอักษร)}
header a.active{color:var(--เน้น);font-weight:600}
header .ขวา{margin-left:auto}
main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:28px 0 10px}
.คำอธิบาย{color:var(--รอง);font-size:14px;margin:0 0 20px}
.การ์ด{background:var(--การ์ด);border:1px solid var(--เส้น);border-radius:10px;
  padding:18px 20px;margin-bottom:16px}
.ตัวเลขชุด{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.ตัวเลข{background:var(--การ์ด);border:1px solid var(--เส้น);border-radius:10px;padding:16px}
.ตัวเลข .ป้าย{color:var(--รอง);font-size:13px}
.ตัวเลข .ค่า{font-size:26px;font-weight:700;margin-top:2px}
.ตัวเลข .ท้าย{color:var(--รอง);font-size:12px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--เส้น);vertical-align:top}
th{color:var(--รอง);font-weight:600;font-size:13px;white-space:nowrap}
td.เลข,th.เลข{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover{background:#fafbfc}
.ว่าง{color:var(--รอง);padding:24px 0;text-align:center}
input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--เส้น);
  border-radius:7px;font-family:inherit;font-size:14px;background:#fff;color:inherit}
textarea{min-height:150px;resize:vertical;line-height:1.7}
label{display:block;margin-bottom:14px}
label .ชื่อช่อง{display:block;font-weight:600;font-size:14px;margin-bottom:4px}
label .ช่วย{display:block;color:var(--รอง);font-size:13px;margin-bottom:5px}
button,.ปุ่ม{background:var(--เน้น);color:#fff;border:0;border-radius:7px;
  padding:9px 18px;font-family:inherit;font-size:14px;cursor:pointer;text-decoration:none;
  display:inline-block}
button:hover{opacity:.9}
button.รอง{background:#fff;color:var(--ตัวอักษร);border:1px solid var(--เส้น)}
button.อันตราย{background:var(--อันตราย)}
.แถวปุ่ม{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:6px}
.แจ้ง{padding:11px 14px;border-radius:8px;margin-bottom:16px;font-size:14px}
.แจ้ง.ดี{background:#ecfdf5;color:var(--ดี);border:1px solid #a7f3d0}
.แจ้ง.เตือน{background:#fffbeb;color:var(--เตือน);border:1px solid #fde68a}
.แจ้ง.ผิด{background:#fef2f2;color:var(--อันตราย);border:1px solid #fecaca}
.ป้ายเล็ก{display:inline-block;padding:1px 8px;border-radius:20px;font-size:12px;
  background:var(--พื้นหลัง);border:1px solid var(--เส้น);color:var(--รอง)}
.ป้ายเล็ก.คำนวณ{background:#eff6ff;border-color:#bfdbfe;color:#1d4ed8}
.แท่ง{height:7px;background:var(--พื้นหลัง);border-radius:4px;overflow:hidden;min-width:70px}
.แท่ง>i{display:block;height:100%;background:var(--เน้น)}
.บันทึกท้าย{color:var(--รอง);font-size:13px;margin-top:8px}

/* กลุ่มปุ่มเลือกแบบเลือกได้อย่างเดียว ใช้กับช่องต้องคำนวณต่อ */
fieldset.ช่องเลือก{border:0;padding:0;margin:0 0 14px}
fieldset.ช่องเลือก legend{padding:0;font-weight:600;font-size:14px;margin-bottom:4px}
label.ตัวเลือก{display:flex;gap:10px;align-items:flex-start;margin:0 0 8px;
  border:1px solid var(--เส้น);border-radius:8px;padding:10px 12px;cursor:pointer}
label.ตัวเลือก:hover{background:#fafbfc}
label.ตัวเลือก input{width:auto;margin-top:4px;flex:none}
label.ตัวเลือก strong{display:block;font-size:14px}
label.ตัวเลือก em{display:block;color:var(--รอง);font-size:13px;font-style:normal}

/* แถวตัวกรองด้านบนตาราง ให้ช่องค้นหากว้างกว่าตัวเลือกอื่น */
.แถวกรอง{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.แถวกรอง input{flex:2 1 220px}
.แถวกรอง select{flex:1 1 180px}
.แถวกรอง button,.แถวกรอง .ปุ่ม{flex:none}

/* กราฟแท่งแนวตั้ง สร้างเป็น SVG เสร็จจากฝั่งเซิร์ฟเวอร์ ไม่ใช้ JavaScript ในเบราว์เซอร์ */
svg.กราฟแท่ง{width:100%;height:220px;display:block}
svg.กราฟแท่ง .แท่งกราฟ{fill:var(--เน้น)}
svg.กราฟแท่ง .แท่งกราฟ:hover{fill:#1550b3}
svg.กราฟแท่ง .เส้นอ้างอิง{stroke:var(--เส้น);stroke-width:1}
svg.กราฟแท่ง .ป้ายแกน{fill:var(--รอง);font-size:11px;font-family:inherit}

/* หัวตารางที่กดเพื่อเรียงได้ ต้องดูออกว่ากดได้ ไม่ใช่ข้อความเฉย ๆ */
th a.หัวเรียง{color:var(--รอง);text-decoration:none;display:inline-block;white-space:nowrap}
th a.หัวเรียง:hover{color:var(--เน้น);text-decoration:underline}
th a.หัวเรียง.กำลังเรียง{color:var(--เน้น);font-weight:700}

/* กราฟแท่งแนวนอนในหน้าภาพรวม วาดด้วย CSS ล้วน ไม่พึ่งไลบรารีภายนอก */
.กราฟ{display:grid;grid-template-columns:minmax(90px,auto) 1fr minmax(52px,auto);
  gap:6px 12px;align-items:center;font-size:14px}
.กราฟ .ชื่อแกน{color:var(--รอง);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.กราฟ .แท่ง{height:16px;border-radius:5px}
.กราฟ .ค่าท้าย{text-align:right;font-variant-numeric:tabular-nums}
.กราฟ .แท่ง>i{transition:width .2s}
`;

const เมนู = [
  ['/', 'ภาพรวม'],
  ['/knowledge', 'ฐานข้อมูล'],
  ['/feedback', 'ความพึงพอใจ'],
  ['/gaps', 'ความรู้ที่ยังขาด'],
];

function หน้า({ title, active, body }) {
  const ลิงก์ = เมนู
    .map(([u, n]) => `<a href="${u}"${u === active ? ' class="active"' : ''}>${n}</a>`)
    .join('');
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · หลังบ้านระบบที่ปรึกษาภาษี</title>
<style>${CSS}</style></head>
<body>
<header><div class="แถบ">
  <span class="ชื่อ">หลังบ้านระบบที่ปรึกษาภาษี</span>
  ${ลิงก์}
  <span class="ขวา"><a href="/logout">ออกจากระบบ</a></span>
</div></header>
<main>${body}</main>
</body></html>`;
}

/** หน้าล็อกอิน แยกออกมาเพราะไม่ควรมีเมนูให้กดตอนยังไม่ได้ยืนยันตัวตน */
function หน้าล็อกอิน(ข้อผิดพลาด) {
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>เข้าสู่ระบบ · หลังบ้านระบบที่ปรึกษาภาษี</title>
<style>${CSS}
body{display:flex;align-items:center;justify-content:center;min-height:100vh}
.กล่อง{width:100%;max-width:380px}</style></head>
<body><div class="กล่อง">
  <div class="การ์ด">
    <h1>เข้าสู่ระบบ</h1>
    <p class="คำอธิบาย">สำหรับผู้ดูแลระบบเท่านั้น</p>
    ${ข้อผิดพลาด ? `<div class="แจ้ง ผิด">${esc(ข้อผิดพลาด)}</div>` : ''}
    <form method="post" action="/login">
      <label>
        <span class="ชื่อช่อง">รหัสผ่าน</span>
        <input type="password" name="password" autofocus required autocomplete="current-password">
      </label>
      <button type="submit">เข้าสู่ระบบ</button>
    </form>
  </div>
  <p class="บันทึกท้าย">
    หน้านี้ไม่แสดงประวัติการสนทนาของผู้ใช้ ไม่ว่ากรณีใด
    บัญชีฐานข้อมูลที่ใช้ถูกเพิกถอนสิทธิ์อ่านตารางบทสนทนาไว้แล้ว
  </p>
</div></body></html>`;
}

module.exports = { esc, เลข, หน้า, หน้าล็อกอิน };
