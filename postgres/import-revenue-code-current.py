#!/usr/bin/env python3
"""
ดึงตัวบทประมวลรัษฎากรฉบับปัจจุบันจากเว็บไซต์กรมสรรพากร แล้วสร้างไฟล์ SQL

ทำไมต้องมีสคริปต์นี้
--------------------
ตาราง revenue_code_sections เดิมที่นำเข้าจาก Open Law Data Thailand
เป็นประมวลรัษฎากร "ฉบับ พ.ศ. 2482" คือตัวบทดั้งเดิมที่ยังไม่ผ่านการแก้ไข
ตัวเลขในนั้นล้าสมัยทั้งหมด เช่น ค่าลดหย่อนส่วนตัวยังเป็นหลักพันบาท
จึงใช้ตอบคำถามผู้ใช้ไม่ได้เลย

เว็บไซต์กรมสรรพากรเผยแพร่ตัวบทฉบับที่รวมการแก้ไขล่าสุดไว้แล้ว
พร้อมหมายเหตุกำกับว่าแต่ละวรรคถูกแก้ไขโดยกฎหมายฉบับใดและใช้บังคับเมื่อใด
ซึ่งเป็นสิ่งที่ระบบต้องการ

ข้อควรระวังที่สำคัญที่สุดของข้อมูลชุดนี้
-----------------------------------------
ตัวบทในประมวลรัษฎากรหลายมาตราระบุตัวเลขไว้ค่าหนึ่ง
แต่มีกฎกระทรวงหรือพระราชกฤษฎีกาแก้ไขค่านั้นในภายหลัง
ตัวอย่างที่ชัดที่สุดคือ มาตรา 47(1)(ง) เขียนว่าเบี้ยประกันชีวิตหักได้ไม่เกิน 10,000 บาท
แต่ค่าที่ใช้จริงคือ 100,000 บาท ตามกฎกระทรวง ฉบับที่ 126 ข้อ 2(61)

ถ้านำตัวบทดิบไปให้แบบจำลองภาษาตอบคำถามเรื่องตัวเลขโดยตรง
ระบบจะตอบ 10,000 บาท ซึ่งผิด และผิดแบบที่ผู้ใช้ตรวจจับไม่ได้เพราะอ้างมาตราถูก

ด้วยเหตุนี้สคริปต์จึงเก็บข้อมูลลงตาราง revenue_code_current แยกต่างหาก
ไม่ปนกับตาราง tax_law_knowledge ที่ระบบใช้ค้นมาตอบคำถามทั่วไป
ตัวบทมีไว้สำหรับ "อ้างอิงถ้อยคำของกฎหมาย" เมื่อผู้ใช้ถามถึงมาตราโดยตรงเท่านั้น

วิธีใช้
-------
    pip install requests beautifulsoup4
    python postgres/import-revenue-code-current.py

จะได้ไฟล์ postgres/seed-revenue-code-current.sql แล้วนำเข้าด้วย
    docker cp postgres\\seed-revenue-code-current.sql tax-advisor-postgres:/tmp/rc.sql
    docker exec -it tax-advisor-postgres psql -U n8n_admin -d tax_advisor -f /tmp/rc.sql

แหล่งข้อมูล
-----------
เว็บไซต์กรมสรรพากร https://www.rd.go.th หมวด รวมกฎหมายภาษี > ประมวลรัษฎากร
ข้อมูลเป็นเอกสารราชการที่เผยแพร่ต่อสาธารณะ
"""

import html
import re
import sys
import time
from pathlib import Path

try:
    import requests
    from bs4 import BeautifulSoup
except ImportError:
    sys.exit(
        "ต้องติดตั้งไลบรารีก่อน:\n"
        "    pip install requests beautifulsoup4"
    )

BASE = "https://www.rd.go.th"
OUT = Path(__file__).resolve().parent / "seed-revenue-code-current.sql"

# หน้าเว็บที่รวมตัวบทของประมวลรัษฎากรทั้งฉบับ
# โครงสร้างนี้อ่านมาจากเมนู "บทบัญญัติแห่งประมวลรัษฎากร" ของเว็บไซต์กรมสรรพากร
PAGES = [
    ("ลักษณะ 1 ข้อความเบื้องต้น", "/2600.html"),
    ("หมวด 1 บทเบ็ดเสร็จทั่วไป", "/2591.html"),
    ("หมวด 1 ทวิ คณะกรรมการวินิจฉัยภาษีอากร", "/2599.html"),
    ("หมวด 2 วิธีการเกี่ยวแก่ภาษีอากรประเมิน", "/2598.html"),
    ("หมวด 3 ภาษีเงินได้ (มาตรา 38-64)", "/5937.html"),
    ("หมวด 3 ภาษีเงินได้ (มาตรา 65-76)", "/5939.html"),
    ("หมวด 3 บัญชีอัตราภาษีเงินได้", "/5938.html"),
    ("หมวด 4 ภาษีมูลค่าเพิ่ม", "/2596.html"),
    ("หมวด 5 ภาษีธุรกิจเฉพาะ", "/2595.html"),
    ("หมวด 6 อากรแสตมป์", "/2593.html"),
]

# จับหัวมาตราทุกแบบที่ปรากฏจริงในตัวบท
# รองรับ ทวิ ตรี จัตวา เบญจ ฉ สัตต อัฏฐ นว ทศ และเลขทับ เช่น 91/1
#
# เงื่อนไข ^ ที่ต้นบรรทัดสำคัญมาก
# ตัวบทอ้างถึงมาตราอื่นกลางประโยคตลอดเวลา เช่น
#   "มาตรา 41 ผู้มีเงินได้พึงประเมินตามมาตรา 40 ในปีภาษีที่ล่วงมาแล้ว..."
# ถ้าไม่บังคับให้อยู่ต้นบรรทัด คำว่า "มาตรา 40" กลางประโยคจะถูกนับเป็นหัวมาตราใหม่
# ทำให้มาตรา 41 ถูกตัดเหลือไม่กี่ตัวอักษรแล้วหายไป และเกิดมาตราแปลกปลอมขึ้นมาแทน
# (ยืนยันจากข้อมูลจริง: หมวด 3 เคยได้มาตรา 5, 6, 7, 8, 26, 27 ซึ่งไม่ได้อยู่ในหมวดนั้นเลย)
SECTION_RE = re.compile(
    r"^[ \t]*มาตรา\s*(\d+(?:/\d+)?"
    r"(?:\s*(?:ทวิ|ตรี|จัตวา|เบญจ|ฉ|สัตต|อัฏฐ|นว|ทศ|เอกาทศ|ทวาทศ|เตรส|จตุทศ|ปัณรส|โสฬส|สัตตรส))?)"
    r"(?=[\s\u0e00-\u0e7f(])",
    re.MULTILINE,
)


def fetch(path: str) -> str:
    """ดึงหน้าเว็บพร้อมลองใหม่เมื่อเครือข่ายสะดุด"""
    url = BASE + path
    for attempt in range(1, 4):
        try:
            r = requests.get(url, timeout=60, headers={"User-Agent": "tax-advisor-thesis/1.0"})
            r.raise_for_status()
            r.encoding = r.apparent_encoding or "utf-8"
            return r.text
        except Exception as e:
            if attempt == 3:
                raise
            print(f"    ดึงไม่สำเร็จ ({e}) รอ {attempt * 5} วินาทีแล้วลองใหม่")
            time.sleep(attempt * 5)
    return ""


def extract_body(page_html: str) -> str:
    """
    ตัดเมนู หัวเว็บ ท้ายเว็บ ออก เหลือเฉพาะเนื้อหาตัวบท

    เว็บไซต์ใช้ TYPO3 เนื้อหาหลักอยู่ในบล็อกที่ยาวที่สุดของหน้า
    จึงเลือกด้วยความยาวแทนการอิงชื่อคลาสที่อาจเปลี่ยนได้
    """
    soup = BeautifulSoup(page_html, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()

    candidates = soup.find_all(["div", "section", "article"])
    best = max(candidates, key=lambda t: len(t.get_text()), default=soup)
    text = best.get_text("\n")
    text = html.unescape(text)
    # ตัดอักขระขึ้นบรรทัดแบบวินโดวส์และช่องว่างที่มองไม่เห็นซึ่งติดมากับ HTML
    # ถ้าปล่อยไว้จะกลายเป็นขยะในคำตอบที่ส่งให้ผู้ใช้ เช่น "มาตรา 40 \r"
    text = text.replace("\r", "").replace("\u00a0", " ").replace("\u200b", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_sections(text: str, chapter: str):
    """แยกข้อความออกเป็นรายมาตรา โดยเก็บทุกวรรคและทุกอนุมาตราไว้ครบ"""
    marks = list(SECTION_RE.finditer(text))
    out = []
    for i, m in enumerate(marks):
        start = m.start()
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[start:end].strip()

        # ตัดเฉพาะเศษที่สั้นมากจนไม่มีเนื้อความ
        # ไม่ตั้งไว้สูง เพราะมาตราที่ถูกยกเลิกมีข้อความสั้นจริง เช่น "มาตรา 47 ตรี (ยกเลิก)"
        if len(body) < 25:
            continue

        section_no = re.sub(r"\s+", " ", m.group(1)).strip()
        out.append(
            {
                "chapter": chapter,
                "section_no": section_no,
                "content": body,
            }
        )
    return out


def sql_escape(s: str) -> str:
    return s.replace("'", "''")


def main():
    print("=" * 70)
    print("  ดึงตัวบทประมวลรัษฎากรฉบับปัจจุบันจากเว็บไซต์กรมสรรพากร")
    print("=" * 70)

    all_sections = []
    for chapter, path in PAGES:
        print(f"  กำลังดึง: {chapter}")
        body = extract_body(fetch(path))
        secs = split_sections(body, chapter)
        nums = sorted({int(re.match(r"\d+", x["section_no"]).group()) for x in secs})
        span = f"{nums[0]}-{nums[-1]}" if nums else "ไม่พบ"
        print(f"    ได้ {len(secs)} มาตรา ช่วงเลข {span} ({len(body):,} ตัวอักษร)")
        all_sections.extend(secs)
        time.sleep(1.5)  # เว้นจังหวะไม่ให้รบกวนเซิร์ฟเวอร์ของราชการ

    # ตัดมาตราซ้ำที่อาจเกิดจากหน้าเว็บที่เนื้อหาคาบเกี่ยวกัน เก็บฉบับที่ยาวกว่า
    best = {}
    for s in all_sections:
        key = (s["chapter"].split("(")[0].strip(), s["section_no"])
        if key not in best or len(s["content"]) > len(best[key]["content"]):
            best[key] = s
    sections = sorted(best.values(), key=lambda s: (s["chapter"], len(s["section_no"]), s["section_no"]))

    print(f"\n  รวมทั้งสิ้น {len(sections):,} มาตรา")

    lines = [
        "-- ============================================================================",
        "--  seed-revenue-code-current.sql",
        "--  ตัวบทประมวลรัษฎากรฉบับปัจจุบัน สร้างอัตโนมัติจาก postgres/import-revenue-code-current.py",
        "-- ----------------------------------------------------------------------------",
        "--  แหล่งข้อมูล: เว็บไซต์กรมสรรพากร https://www.rd.go.th",
        "--",
        "--  คำเตือนสำคัญเรื่องการนำไปใช้",
        "--    ตัวบทหลายมาตราระบุตัวเลขที่ถูกแก้ไขโดยกฎกระทรวงหรือพระราชกฤษฎีกาในภายหลัง",
        "--    เช่น มาตรา 47(1)(ง) เขียนว่าเบี้ยประกันชีวิตหักได้ 10,000 บาท",
        "--    แต่ค่าที่ใช้จริงคือ 100,000 บาท ตามกฎกระทรวง ฉบับที่ 126",
        "--    ตารางนี้จึงใช้สำหรับอ้างอิงถ้อยคำของกฎหมายเท่านั้น",
        "--    ห้ามนำตัวเลขในตารางนี้ไปตอบคำถามผู้ใช้โดยตรง",
        "--    ตัวเลขที่ใช้ตอบผู้ใช้ต้องมาจากตาราง tax_law_knowledge เท่านั้น",
        "-- ============================================================================",
        "",
        "CREATE TABLE IF NOT EXISTS revenue_code_current (",
        "  id          SERIAL PRIMARY KEY,",
        "  chapter     TEXT NOT NULL,",
        "  section_no  TEXT NOT NULL,",
        "  content     TEXT NOT NULL,",
        "  source_url  TEXT,",
        "  fetched_at  DATE NOT NULL DEFAULT CURRENT_DATE",
        ");",
        "",
        "CREATE INDEX IF NOT EXISTS idx_rcc_section ON revenue_code_current (section_no);",
        "",
        "TRUNCATE TABLE revenue_code_current RESTART IDENTITY;",
        "",
    ]

    url_by_chapter = {c: BASE + p for c, p in PAGES}
    for s in sections:
        lines.append(
            "INSERT INTO revenue_code_current (chapter, section_no, content, source_url) VALUES ("
            f"'{sql_escape(s['chapter'])}', "
            f"'{sql_escape(s['section_no'])}', "
            f"'{sql_escape(s['content'])}', "
            f"'{sql_escape(url_by_chapter.get(s['chapter'], BASE))}');"
        )

    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    size_mb = OUT.stat().st_size / 1024 / 1024
    print(f"  บันทึกไฟล์: {OUT}  ({size_mb:.1f} MB)")
    print()
    print("  ขั้นตอนถัดไป")
    print("    docker cp postgres\\seed-revenue-code-current.sql tax-advisor-postgres:/tmp/rc.sql")
    print("    docker exec -it tax-advisor-postgres psql -U n8n_admin -d tax_advisor -f /tmp/rc.sql")


if __name__ == "__main__":
    main()
