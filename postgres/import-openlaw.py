#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================================
 นำเข้าข้อมูลกฎหมายภาษีจาก Open Law Data Thailand
----------------------------------------------------------------------------
 แหล่งข้อมูล:
   Open Law Data Thailand (องค์กรไม่แสวงหากำไร ทำงานร่วมกับสำนักงานพัฒนารัฐบาลดิจิทัล)
   ชุดข้อมูล ocs-krisdika ซึ่งรวบรวมจากสำนักงานคณะกรรมการกฤษฎีกา
   https://huggingface.co/datasets/open-law-data-thailand/ocs-krisdika
   สัญญาอนุญาต CC-BY 4.0

 ข้อสงวนของชุดข้อมูลต้นทาง (ต้องระบุในรายงาน):
   "ข้อมูลชุดนี้จัดทำขึ้นเพื่อการศึกษาและพัฒนาเทคโนโลยี
    ไม่สามารถใช้อ้างอิงในทางกฎหมายอย่างเป็นทางการได้
    กรุณาตรวจสอบกับเอกสารต้นฉบับอีกครั้ง"

 หน้าที่ของสคริปต์:
   1. ดาวน์โหลดชุดข้อมูล (รูปแบบ JSON Lines แบ่งตามปีและเดือน)
   2. คัดกรองเฉพาะกฎหมายที่เกี่ยวกับภาษี ไม่เอาทั้งชุด
   3. แยกเนื้อหาออกเป็นรายมาตรา
   4. สร้างไฟล์ SQL สำหรับนำเข้าฐานข้อมูล พร้อมลิงก์ตรวจสอบย้อนกลับ

 การติดตั้งไลบรารีที่ต้องใช้ (ครั้งเดียว):
   pip install huggingface_hub

 วิธีรัน:
   python postgres/import-openlaw.py
   python postgres/import-openlaw.py --latest-only      # เอาเฉพาะฉบับล่าสุดที่บังคับใช้
   python postgres/import-openlaw.py --keywords รัษฎากร  # กำหนดคำคัดกรองเอง
============================================================================
"""

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "postgres" / "seed-revenue-code.sql"

REPO_ID = "open-law-data-thailand/ocs-krisdika"
SOURCE_NAME = "Open Law Data Thailand (สำนักงานคณะกรรมการกฤษฎีกา)"

# คำที่ใช้คัดกรองว่ากฎหมายฉบับใดเกี่ยวข้องกับภาษี
# ตรวจจากชื่อกฎหมาย (title) เท่านั้น เพื่อไม่ให้ได้กฎหมายที่บังเอิญเอ่ยถึงภาษีผ่านๆ
DEFAULT_KEYWORDS = [
    "รัษฎากร",                    # ประมวลรัษฎากร และกฎหมายแก้ไขเพิ่มเติม
    "ภาษีเงินได้",
    "ภาษีมูลค่าเพิ่ม",
    "ภาษีธุรกิจเฉพาะ",
    "ภาษีที่ดินและสิ่งปลูกสร้าง",
]


def sql_escape(value):
    """แปลงค่าให้ปลอดภัยสำหรับใส่ใน SQL (คูณเครื่องหมาย single quote)"""
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def download_dataset(years=None, max_workers=4, disable_xet=True, max_retries=8):
    """
    ดาวน์โหลดชุดข้อมูลจาก Hugging Face แล้วคืนพาธของโฟลเดอร์ที่เก็บไฟล์

    ชุดข้อมูลนี้แบ่งเป็นไฟล์ย่อยกว่า 800 ไฟล์ หากดาวน์โหลดพร้อมกันหลายไฟล์เกินไป
    Hugging Face จะปฏิเสธด้วยรหัส 429 (Too Many Requests) สคริปต์จึงลดจำนวน
    การเชื่อมต่อพร้อมกันลง และลองใหม่อัตโนมัติเมื่อถูกปฏิเสธ

    ไฟล์ที่ดาวน์โหลดสำเร็จแล้วจะถูกเก็บไว้ในแคชของ Hugging Face
    การลองใหม่แต่ละรอบจึงข้ามไฟล์เดิมและดาวน์โหลดต่อจากที่ค้างไว้
    """
    # ต้องตั้งค่าก่อนนำเข้าไลบรารี จึงจะมีผล
    # ระบบจัดเก็บแบบ xet เป็นสาเหตุหลักของการถูกปฏิเสธด้วยรหัส 429
    # การปิดใช้งานทำให้กลับไปดาวน์โหลดแบบ HTTP ปกติซึ่งเสถียรกว่าในกรณีนี้
    if disable_xet:
        os.environ["HF_HUB_DISABLE_XET"] = "1"
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "0")

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("ไม่พบไลบรารี huggingface_hub")
        print("ติดตั้งด้วยคำสั่ง:  pip install huggingface_hub")
        sys.exit(1)

    patterns = (
        [f"data/{y}/*.jsonl" for y in years] if years else ["data/**/*.jsonl"]
    )
    print(f"กำลังดาวน์โหลดชุดข้อมูลจาก {REPO_ID}")
    print(f"  ขอบเขตไฟล์          : {', '.join(patterns)}")
    print(f"  ดาวน์โหลดพร้อมกัน    : {max_workers} ไฟล์")
    print(f"  ระบบจัดเก็บแบบ xet   : {'ปิด' if disable_xet else 'เปิด'}")
    print("  ชุดข้อมูลมีขนาดประมาณ 418 MB แบ่งเป็นไฟล์ย่อยกว่า 800 ไฟล์")
    print("  ไฟล์ที่โหลดสำเร็จแล้วจะถูกเก็บไว้ ลองใหม่ได้โดยไม่ต้องเริ่มจากศูนย์\n")

    import time

    for attempt in range(1, max_retries + 1):
        try:
            path = snapshot_download(
                repo_id=REPO_ID,
                repo_type="dataset",
                allow_patterns=patterns,
                max_workers=max_workers,
            )
            print("\nดาวน์โหลดครบทุกไฟล์แล้ว\n")
            return Path(path)
        except Exception as e:
            msg = str(e)
            is_rate_limit = "429" in msg or "Too Many Requests" in msg
            if attempt >= max_retries:
                print(f"\nดาวน์โหลดไม่สำเร็จหลังลอง {max_retries} ครั้ง")
                print(f"  สาเหตุ: {msg[:200]}")
                print("\nคำแนะนำ:")
                print("  - รันคำสั่งเดิมซ้ำอีกครั้ง ไฟล์ที่โหลดแล้วจะถูกข้ามไป")
                print("  - หรือลดจำนวนการเชื่อมต่อลงด้วย --max-workers 2")
                sys.exit(1)

            wait = min(20 * attempt, 120)
            reason = "ถูกจำกัดอัตราการเชื่อมต่อ (429)" if is_rate_limit else "การเชื่อมต่อขัดข้อง"
            print(f"\n  {reason} รอ {wait} วินาที แล้วดาวน์โหลดต่อ (ครั้งที่ {attempt}/{max_retries})")
            print(f"  ไฟล์ที่โหลดสำเร็จแล้วจะถูกข้าม ไม่ต้องเริ่มใหม่")
            time.sleep(wait)


def collect_tax_laws(data_dir, keywords, latest_only):
    """
    อ่านไฟล์ JSON Lines ทั้งหมด แล้วคัดเฉพาะกฎหมายที่ชื่อมีคำสำคัญด้านภาษี

    หมายเหตุทางเทคนิค: อ่านทีละบรรทัดด้วย json.loads แทนการใช้ไลบรารี datasets
    เพราะไฟล์แต่ละปีมีโครงสร้าง sections ไม่เหมือนกัน (บางไฟล์มี sectionNo บางไฟล์ไม่มี)
    ซึ่งทำให้ไลบรารีที่ต้องการ schema คงที่อ่านไม่ผ่าน
    """
    files = sorted(data_dir.rglob("*.jsonl"))
    if not files:
        print(f"ไม่พบไฟล์ .jsonl ใน {data_dir}")
        sys.exit(1)

    print(f"พบไฟล์ข้อมูลทั้งหมด {len(files):,} ไฟล์ กำลังคัดกรอง...\n")

    laws = []
    total_lines = 0
    for i, f in enumerate(files, 1):
        if i % 200 == 0:
            print(f"  อ่านแล้ว {i:,}/{len(files):,} ไฟล์ | พบกฎหมายภาษี {len(laws)} ฉบับ")
        try:
            with open(f, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    total_lines += 1
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    title = rec.get("title") or ""
                    if not any(kw in title for kw in keywords):
                        continue
                    if latest_only and rec.get("is_latest") is not True:
                        continue
                    laws.append(rec)
        except OSError as e:
            print(f"  ข้ามไฟล์ {f.name}: {e}")

    print(f"\nอ่านข้อมูลทั้งหมด {total_lines:,} รายการ")
    print(f"คัดได้กฎหมายที่เกี่ยวกับภาษี {len(laws)} ฉบับ")
    return laws


def extract_sections(laws):
    """แปลงกฎหมายแต่ละฉบับเป็นรายการมาตรา พร้อมข้อมูลอ้างอิง"""
    rows = []
    for law in laws:
        title = law.get("title") or ""
        publish_date = law.get("publish_date") or None
        if publish_date:
            publish_date = str(publish_date)[:10]  # เก็บเฉพาะ YYYY-MM-DD
        ref_url = law.get("reference_url") or None
        is_latest = bool(law.get("is_latest"))

        for sec in law.get("sections") or []:
            content = (sec.get("content") or "").strip()
            if not content:
                continue
            rows.append(
                {
                    "law_title": title,
                    "section_no": (sec.get("sectionNo") or "").strip() or None,
                    "section_name": (sec.get("sectionName") or "").strip() or None,
                    "content": content,
                    "publish_date": publish_date,
                    "reference_url": ref_url,
                    "is_latest": is_latest,
                }
            )
    return rows


SQL_HEADER = """-- ============================================================================
--  seed-revenue-code.sql
--  ข้อมูลกฎหมายภาษีจาก Open Law Data Thailand (สำนักงานคณะกรรมการกฤษฎีกา)
--  สร้างอัตโนมัติด้วยสคริปต์ postgres/import-openlaw.py  ห้ามแก้ไฟล์นี้ด้วยมือ
--
--  แหล่งที่มา : https://huggingface.co/datasets/open-law-data-thailand/ocs-krisdika
--  สัญญาอนุญาต: CC-BY 4.0
--  ข้อสงวน   : ข้อมูลชุดนี้จัดทำเพื่อการศึกษาและพัฒนาเทคโนโลยี
--              ไม่สามารถใช้อ้างอิงในทางกฎหมายอย่างเป็นทางการได้
--
--  วิธีนำเข้า:
--    docker cp postgres\\seed-revenue-code.sql tax-advisor-postgres:/tmp/rc.sql
--    docker exec -it tax-advisor-postgres psql -U <POSTGRES_USER> -d tax_advisor -f /tmp/rc.sql
-- ============================================================================

CREATE TABLE IF NOT EXISTS revenue_code_sections (
    id            SERIAL PRIMARY KEY,
    law_title     TEXT NOT NULL,
    section_no    VARCHAR(50),
    section_name  TEXT,
    content       TEXT NOT NULL,
    publish_date  DATE,
    reference_url TEXT,
    is_latest     BOOLEAN DEFAULT true,
    source        VARCHAR(200) DEFAULT 'Open Law Data Thailand (OCS Krisdika)',
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_revenue_code_section_no ON revenue_code_sections (section_no);
CREATE INDEX IF NOT EXISTS idx_revenue_code_latest ON revenue_code_sections (is_latest);

COMMENT ON TABLE revenue_code_sections IS
  'ตัวบทกฎหมายภาษีรายมาตรา นำเข้าจาก Open Law Data Thailand ใช้สำหรับอ้างอิงเลขมาตราในคำตอบ';

-- ล้างข้อมูลเดิมก่อนนำเข้าใหม่ เพื่อไม่ให้ข้อมูลซ้ำเมื่อรันสคริปต์หลายครั้ง
TRUNCATE TABLE revenue_code_sections RESTART IDENTITY;

"""


def write_sql(rows, output_path, batch_size=200):
    """เขียนไฟล์ SQL โดยแบ่ง INSERT เป็นชุดๆ เพื่อไม่ให้คำสั่งเดียวยาวเกินไป"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(SQL_HEADER)

        for start in range(0, len(rows), batch_size):
            chunk = rows[start : start + batch_size]
            f.write(
                "INSERT INTO revenue_code_sections\n"
                "  (law_title, section_no, section_name, content, publish_date, reference_url, is_latest)\nVALUES\n"
            )
            values = []
            for r in chunk:
                values.append(
                    "  ("
                    + sql_escape(r["law_title"])
                    + ", "
                    + sql_escape(r["section_no"])
                    + ", "
                    + sql_escape(r["section_name"])
                    + ", "
                    + sql_escape(r["content"])
                    + ", "
                    + (sql_escape(r["publish_date"]) if r["publish_date"] else "NULL")
                    + ", "
                    + sql_escape(r["reference_url"])
                    + ", "
                    + ("true" if r["is_latest"] else "false")
                    + ")"
                )
            f.write(",\n".join(values))
            f.write(";\n\n")

        f.write(
            "-- ตรวจสอบผลการนำเข้า\n"
            "SELECT law_title, COUNT(*) AS จำนวนมาตรา\n"
            "FROM revenue_code_sections\n"
            "GROUP BY law_title\n"
            "ORDER BY COUNT(*) DESC\n"
            "LIMIT 20;\n\n"
            "SELECT 'รวมทั้งหมด ' || COUNT(*) || ' มาตรา' AS สรุป FROM revenue_code_sections;\n"
        )


def main():
    ap = argparse.ArgumentParser(
        description="นำเข้าข้อมูลกฎหมายภาษีจาก Open Law Data Thailand"
    )
    ap.add_argument(
        "--keywords",
        nargs="+",
        default=DEFAULT_KEYWORDS,
        help="คำที่ใช้คัดกรองจากชื่อกฎหมาย (ค่าเริ่มต้นครอบคลุมกฎหมายภาษีหลัก)",
    )
    ap.add_argument(
        "--years",
        nargs="+",
        default=None,
        help="จำกัดเฉพาะบางปี (ค.ศ.) เพื่อลดขนาดการดาวน์โหลด เช่น --years 1938 2024",
    )
    ap.add_argument(
        "--latest-only",
        action="store_true",
        help="เอาเฉพาะฉบับล่าสุดที่มีผลบังคับใช้ (is_latest = true)",
    )
    ap.add_argument("--output", default=str(DEFAULT_OUTPUT), help="ไฟล์ SQL ที่จะสร้าง")
    ap.add_argument(
        "--local-dir",
        default=None,
        help="ใช้โฟลเดอร์ข้อมูลที่ดาวน์โหลดไว้แล้ว แทนการดาวน์โหลดใหม่",
    )
    ap.add_argument(
        "--max-workers",
        type=int,
        default=4,
        help="จำนวนไฟล์ที่ดาวน์โหลดพร้อมกัน ลดลงหากถูกปฏิเสธด้วยรหัส 429 (ค่าเริ่มต้น 4)",
    )
    ap.add_argument(
        "--use-xet",
        action="store_true",
        help="ใช้ระบบจัดเก็บแบบ xet ของ Hugging Face (ค่าเริ่มต้นคือปิด เพราะมักถูกจำกัดอัตราการเชื่อมต่อ)",
    )
    args = ap.parse_args()

    print("=" * 74)
    print("  นำเข้าข้อมูลกฎหมายภาษีจาก Open Law Data Thailand")
    print("=" * 74)
    print(f"คำคัดกรอง: {', '.join(args.keywords)}")
    print(f"เอาเฉพาะฉบับล่าสุด: {'ใช่' if args.latest_only else 'ไม่ (เอาทุกฉบับรวมฉบับแก้ไข)'}\n")

    data_dir = (
        Path(args.local_dir)
        if args.local_dir
        else download_dataset(
            args.years,
            max_workers=args.max_workers,
            disable_xet=not args.use_xet,
        )
    )

    laws = collect_tax_laws(data_dir, args.keywords, args.latest_only)
    if not laws:
        print("\nไม่พบกฎหมายที่ตรงกับคำคัดกรอง")
        print("ลองปรับคำคัดกรองด้วยตัวเลือก --keywords หรือเอาตัวเลือก --latest-only ออก")
        sys.exit(1)

    # แสดงรายชื่อกฎหมายที่คัดได้ เพื่อให้ตรวจสอบก่อนนำเข้า
    print("\nรายชื่อกฎหมายที่คัดได้ (สูงสุด 25 รายการแรก):")
    seen = []
    for law in laws:
        t = law.get("title") or ""
        if t not in seen:
            seen.append(t)
    for t in seen[:25]:
        print(f"  - {t}")
    if len(seen) > 25:
        print(f"  ... และอีก {len(seen) - 25} ฉบับ")

    rows = extract_sections(laws)
    print(f"\nแยกเนื้อหาได้ทั้งหมด {len(rows):,} มาตรา")

    if not rows:
        print("ไม่พบเนื้อหารายมาตรา อาจเป็นเพราะโครงสร้างข้อมูลเปลี่ยนไป")
        sys.exit(1)

    out = Path(args.output)
    write_sql(rows, out)
    size_mb = out.stat().st_size / (1024 * 1024)

    print("\n" + "=" * 74)
    print(f"สร้างไฟล์สำเร็จ: {out}")
    print(f"  จำนวนกฎหมาย : {len(seen)} ฉบับ")
    print(f"  จำนวนมาตรา  : {len(rows):,} มาตรา")
    print(f"  ขนาดไฟล์    : {size_mb:.1f} MB")
    print("\nขั้นตอนถัดไป นำเข้าฐานข้อมูลด้วยคำสั่ง:")
    print("  docker cp postgres\\seed-revenue-code.sql tax-advisor-postgres:/tmp/rc.sql")
    print("  docker exec -it tax-advisor-postgres psql -U n8n_admin -d tax_advisor -f /tmp/rc.sql")


if __name__ == "__main__":
    main()
