-- ============================================================================
--  Migration 002: รวมย่อหน้ากฎหมายที่ถูกแบ่งไว้ ให้กลับเป็นมาตราเดียว
-- ----------------------------------------------------------------------------
--  ปัญหาที่แก้:
--    ชุดข้อมูลจาก Open Law Data Thailand แบ่งเนื้อหากฎหมายเป็นย่อหน้าย่อยหลายแถว
--    โดยแต่ละแถวใช้เลขมาตราเดียวกัน และบางครั้งตัดกลางประโยค
--    เช่น ประมวลรัษฎากร มาตรา 40 ถูกแบ่งเป็น 59 แถว
--    ทำให้ดึงมาใช้อ้างอิงทีละแถวแล้วอ่านไม่รู้เรื่อง
--
--  วิธีแก้:
--    ใช้เทคนิค gaps and islands คือหาว่าแถวใดบ้างที่มีเลขมาตราเดียวกัน
--    และเรียงติดกันในลำดับเดิม (ถือเป็นมาตราเดียวกัน) แล้วต่อเนื้อหาเข้าด้วยกัน
--
--    เหตุผลที่ต้องดูความต่อเนื่องด้วย ไม่ใช่จัดกลุ่มตามเลขมาตราอย่างเดียว
--    เพราะกฎหมายแก้ไขเพิ่มเติมหลายฉบับถูกจัดกลุ่มภายใต้ชื่อเดียวกัน
--    และมีเลขมาตราซ้ำกันได้ แต่อยู่คนละตำแหน่งในไฟล์
--
--  วิธีรัน:
--    docker cp postgres\migrations\002-merge-law-sections.sql tax-advisor-postgres:/tmp/m002.sql
--    docker exec -it tax-advisor-postgres psql -U <POSTGRES_USER> -d tax_advisor -f /tmp/m002.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- มุมมองรวมย่อหน้าให้เป็นมาตราเดียว
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_law_sections AS
WITH runs AS (
    SELECT
        id,
        law_title,
        section_no,
        section_name,
        content,
        publish_date,
        reference_url,
        is_latest,
        -- ผลต่างระหว่างเลขแถวจริงกับลำดับภายในกลุ่ม จะคงที่เมื่อแถวเรียงติดกัน
        -- ใช้ค่านี้แยกว่าเป็นมาตราเดียวกันหรือคนละมาตราที่บังเอิญเลขซ้ำ
        id - ROW_NUMBER() OVER (PARTITION BY law_title, section_no ORDER BY id) AS run_group
    FROM revenue_code_sections
    WHERE section_no IS NOT NULL AND section_no <> ''
)
SELECT
    MIN(id)                                   AS first_id,
    law_title,
    section_no,
    MIN(section_name)                         AS section_name,
    string_agg(content, ' ' ORDER BY id)      AS content,
    MIN(publish_date)                         AS publish_date,
    MIN(reference_url)                        AS reference_url,
    bool_or(is_latest)                        AS is_latest,
    COUNT(*)                                  AS fragment_count,
    LENGTH(string_agg(content, ' ' ORDER BY id)) AS content_length
FROM runs
GROUP BY law_title, section_no, run_group;

COMMENT ON VIEW v_law_sections IS
  'ตัวบทกฎหมายรายมาตราที่รวมย่อหน้าย่อยเข้าด้วยกันแล้ว ใช้สำหรับอ้างอิงเลขมาตราในคำตอบ';

-- ---------------------------------------------------------------------------
-- มุมมองเฉพาะประมวลรัษฎากร เลือกฉบับที่มีเนื้อหายาวที่สุดของแต่ละมาตรา
-- ซึ่งโดยทั่วไปคือตัวบทเต็มของมาตรานั้น ไม่ใช่บทเฉพาะกาลหรือบทแก้ไขสั้นๆ
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_revenue_code AS
SELECT DISTINCT ON (section_no)
    section_no,
    section_name,
    content,
    content_length,
    fragment_count,
    reference_url
FROM v_law_sections
WHERE law_title = 'ประมวลรัษฎากร'
ORDER BY section_no, content_length DESC;

COMMENT ON VIEW v_revenue_code IS
  'ประมวลรัษฎากรรายมาตรา เลือกเนื้อหาฉบับเต็มของแต่ละมาตรา';

-- ---------------------------------------------------------------------------
-- ตรวจสอบผล
-- ---------------------------------------------------------------------------

-- จำนวนมาตราหลังรวมย่อหน้าแล้ว ควรลดลงจากหลักหมื่นเหลือหลักร้อยถึงพัน
SELECT 'มาตราทั้งหมดหลังรวมย่อหน้า: ' || COUNT(*) AS สรุป FROM v_law_sections;
SELECT 'ประมวลรัษฎากรมีทั้งหมด: ' || COUNT(*) || ' มาตรา' AS สรุป FROM v_revenue_code;

-- ตรวจมาตราสำคัญที่ระบบใช้อ้างอิง
SELECT
    section_no AS มาตรา,
    fragment_count AS จำนวนย่อหน้าที่รวม,
    content_length AS ความยาวตัวอักษร,
    LEFT(content, 80) AS ตัวอย่างเนื้อหา
FROM v_revenue_code
WHERE section_no IN ('27', '35', '40', '42 ทวิ', '47', '48')
ORDER BY content_length DESC;
