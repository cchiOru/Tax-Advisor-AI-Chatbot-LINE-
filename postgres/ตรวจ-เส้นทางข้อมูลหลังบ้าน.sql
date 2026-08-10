-- ============================================================================
--  ตรวจ-เส้นทางข้อมูลหลังบ้าน.sql
--  ยืนยันว่าคำสั่งที่โหนดใหม่สองตัวใช้ ทำงานถูกต้องกับ PostgreSQL จริง
-- ----------------------------------------------------------------------------
--  ทำไมต้องมีไฟล์นี้ ทั้งที่มีชุดทดสอบอยู่แล้ว
--
--    ชุดทดสอบ tests/test-feedback-and-gaps.js ตรวจได้แค่ว่า
--    โหนดมีอยู่จริง ต่อสายถูก และโค้ดในโหนดทำงานถูก
--    แต่ตรวจไม่ได้ว่าคำสั่ง SQL รันแล้วผ่าน เพราะตอนรันชุดทดสอบไม่มีฐานข้อมูล
--
--    คำสั่งทั้งสองมีจุดที่พังได้เฉพาะตอนรันจริงเท่านั้น
--      โหนดบันทึกช่องว่าง  ใช้ INSERT ... SELECT ... WHERE ร่วมกับ ON CONFLICT
--                         ซึ่งต้องมีดัชนีไม่ซ้ำบนคอลัมน์ keyword อยู่ก่อน
--                         และต้องระบุชนิดข้อมูลของพารามิเตอร์ ไม่งั้นจะขึ้นว่า
--                         could not determine data type of parameter
--      โหนดบันทึกคะแนน     ส่งค่าว่างเข้าคอลัมน์ตัวเลขได้ ต้องแน่ใจว่าตารางยอมรับ
--
--  ไฟล์นี้ไม่ทิ้งข้อมูลค้างไว้ ทุกอย่างอยู่ในรายการเดียวและย้อนกลับตอนจบ
--  จึงรันกับฐานข้อมูลที่ใช้งานอยู่ได้โดยไม่กระทบข้อมูลจริง
--
--  วิธีรัน
--    docker cp postgres\ตรวจ-เส้นทางข้อมูลหลังบ้าน.sql tax-advisor-postgres:/tmp/check.sql
--    docker exec -it tax-advisor-postgres psql -U n8n_admin -d tax_advisor -f /tmp/check.sql
--
--  ผลที่ต้องได้ ทุกบรรทัดในคอลัมน์ ผล ต้องขึ้นว่า ผ่าน
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  0) ตารางและดัชนีที่จำเป็นต้องมีอยู่ก่อน
-- ---------------------------------------------------------------------------
SELECT 'โครงสร้าง' AS ขั้น,
       'ตาราง knowledge_gaps มีอยู่' AS สิ่งที่ตรวจ,
       CASE WHEN to_regclass('public.knowledge_gaps') IS NOT NULL
            THEN 'ผ่าน' ELSE 'ไม่ผ่าน ให้รัน migration 005 ก่อน' END AS ผล
UNION ALL
SELECT 'โครงสร้าง',
       'ตาราง answer_feedback มีอยู่',
       CASE WHEN to_regclass('public.answer_feedback') IS NOT NULL
            THEN 'ผ่าน' ELSE 'ไม่ผ่าน ให้รัน migration 005 ก่อน' END
UNION ALL
-- ถ้าไม่มีดัชนีไม่ซ้ำ คำสั่ง ON CONFLICT (keyword) จะพังทันทีตอนรันจริง
SELECT 'โครงสร้าง',
       'มีดัชนีไม่ซ้ำบนคอลัมน์ keyword',
       CASE WHEN EXISTS (
                SELECT 1 FROM pg_indexes
                WHERE tablename = 'knowledge_gaps' AND indexdef ILIKE '%UNIQUE%(keyword)%'
            ) THEN 'ผ่าน' ELSE 'ไม่ผ่าน ON CONFLICT จะใช้ไม่ได้' END;


-- ---------------------------------------------------------------------------
--  1) คำสั่งเดียวกับโหนด Log Knowledge Gap
-- ---------------------------------------------------------------------------
-- กรณีที่หนึ่ง มีคำที่ค้นไม่เจอ ต้องแทรกแถวใหม่
PREPARE บันทึกช่องว่าง (varchar, varchar) AS
INSERT INTO knowledge_gaps (keyword, category)
SELECT $1::varchar, $2::varchar
WHERE $1::varchar IS NOT NULL
ON CONFLICT (keyword) DO UPDATE SET
    hit_count    = knowledge_gaps.hit_count + 1,
    last_seen_at = now(),
    status       = CASE WHEN knowledge_gaps.status = 'done'
                       THEN 'open' ELSE knowledge_gaps.status END;

EXECUTE บันทึกช่องว่าง('คำทดสอบห้ามค้างไว้', 'กฎหมายภาษี');
EXECUTE บันทึกช่องว่าง('คำทดสอบห้ามค้างไว้', 'กฎหมายภาษี');
EXECUTE บันทึกช่องว่าง('คำทดสอบห้ามค้างไว้', 'กฎหมายภาษี');

SELECT 'บันทึกช่องว่าง' AS ขั้น,
       'เจอคำเดิมซ้ำ ต้องเพิ่มตัวนับ ไม่ใช่แทรกแถวใหม่' AS สิ่งที่ตรวจ,
       CASE WHEN (SELECT count(*) FROM knowledge_gaps
                  WHERE keyword = 'คำทดสอบห้ามค้างไว้') = 1
             AND (SELECT hit_count FROM knowledge_gaps
                  WHERE keyword = 'คำทดสอบห้ามค้างไว้') = 3
            THEN 'ผ่าน' ELSE 'ไม่ผ่าน' END AS ผล;

-- กรณีที่สอง ค้นเจอข้อมูลแล้ว จึงไม่มีคำที่ค้นไม่เจอ ต้องไม่แทรกอะไรเลย
-- นี่คือกรณีที่เกิดบ่อยที่สุด เพราะระบบค้นเจอเป็นส่วนใหญ่
EXECUTE บันทึกช่องว่าง(NULL, 'กฎหมายภาษี');

SELECT 'บันทึกช่องว่าง' AS ขั้น,
       'ไม่มีคำที่ค้นไม่เจอ ต้องไม่แทรกแถวว่าง' AS สิ่งที่ตรวจ,
       CASE WHEN (SELECT count(*) FROM knowledge_gaps WHERE keyword IS NULL) = 0
            THEN 'ผ่าน' ELSE 'ไม่ผ่าน มีแถวที่ไม่มีคำสำคัญหลุดเข้ามา' END AS ผล;

-- กรณีที่สาม เคยปิดเรื่องไปแล้วแต่ยังค้นไม่เจออีก ต้องเปิดกลับมา
UPDATE knowledge_gaps SET status = 'done'
WHERE keyword = 'คำทดสอบห้ามค้างไว้';
EXECUTE บันทึกช่องว่าง('คำทดสอบห้ามค้างไว้', 'กฎหมายภาษี');

SELECT 'บันทึกช่องว่าง' AS ขั้น,
       'เติมความรู้แล้วแต่ยังค้นไม่เจอ ต้องเปิดเรื่องกลับมา' AS สิ่งที่ตรวจ,
       CASE WHEN (SELECT status FROM knowledge_gaps
                  WHERE keyword = 'คำทดสอบห้ามค้างไว้') = 'open'
            THEN 'ผ่าน' ELSE 'ไม่ผ่าน' END AS ผล;

-- กรณีที่สี่ ตัดสินใจแล้วว่าไม่ทำ ต้องไม่ถูกเปิดกลับ เพราะเป็นการตัดสินใจของคน
UPDATE knowledge_gaps SET status = 'wontfix'
WHERE keyword = 'คำทดสอบห้ามค้างไว้';
EXECUTE บันทึกช่องว่าง('คำทดสอบห้ามค้างไว้', 'กฎหมายภาษี');

SELECT 'บันทึกช่องว่าง' AS ขั้น,
       'เรื่องที่คนตัดสินใจว่าไม่ทำ ต้องไม่ถูกเปิดกลับเอง' AS สิ่งที่ตรวจ,
       CASE WHEN (SELECT status FROM knowledge_gaps
                  WHERE keyword = 'คำทดสอบห้ามค้างไว้') = 'wontfix'
            THEN 'ผ่าน' ELSE 'ไม่ผ่าน' END AS ผล;


-- ---------------------------------------------------------------------------
--  2) คำสั่งเดียวกับโหนด Save Feedback
-- ---------------------------------------------------------------------------
PREPARE บันทึกคะแนน (boolean, varchar, int, int) AS
INSERT INTO answer_feedback
    (is_helpful, category, knowledge_hits, response_time_ms)
VALUES ($1::boolean, $2::varchar, $3::int, $4::int);

EXECUTE บันทึกคะแนน(true,  'สิทธิ์ลดหย่อน', 3, 2100);
EXECUTE บันทึกคะแนน(false, 'คำนวณภาษี',    0, 8400);
-- กรณีข้อมูลจากปุ่มผิดรูป โหนดแกะข้อมูลจะส่งค่าว่างมา ตารางต้องรับได้
EXECUTE บันทึกคะแนน(true,  NULL,           NULL, NULL);

SELECT 'บันทึกคะแนน' AS ขั้น,
       'บันทึกได้ทั้งกรณีข้อมูลครบและกรณีค่าว่าง' AS สิ่งที่ตรวจ,
       CASE WHEN (SELECT count(*) FROM answer_feedback) = 3
            THEN 'ผ่าน' ELSE 'ไม่ผ่าน' END AS ผล;

-- ตัวเลขที่หน้าความพึงพอใจจะแสดง ต้องคำนวณออกมาได้จริง
SELECT 'บันทึกคะแนน' AS ขั้น,
       'หน้าหลังบ้านคำนวณสัดส่วนความพึงพอใจได้' AS สิ่งที่ตรวจ,
       CASE WHEN (SELECT round(100.0 * count(*) FILTER (WHERE is_helpful) / count(*))
                  FROM answer_feedback) = 67
            THEN 'ผ่าน' ELSE 'ไม่ผ่าน' END AS ผล;


-- ---------------------------------------------------------------------------
--  3) ข้อกำหนดเรื่องความเป็นส่วนตัว
-- ---------------------------------------------------------------------------
--  ทั้งสองตารางต้องไม่มีคอลัมน์ที่ระบุตัวผู้ใช้หรือเก็บข้อความ
--  ถ้าวันหนึ่งมีคนเพิ่มคอลัมน์แบบนั้นเข้ามา ต้องรู้ตัวตรงนี้
-- ---------------------------------------------------------------------------
SELECT 'ความเป็นส่วนตัว' AS ขั้น,
       'ตารางทั้งสองไม่มีคอลัมน์ที่ระบุตัวผู้ใช้หรือเก็บข้อความ' AS สิ่งที่ตรวจ,
       CASE WHEN NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name IN ('knowledge_gaps', 'answer_feedback')
                  AND (column_name ILIKE '%user%'
                    OR column_name ILIKE '%message%'
                    OR column_name ILIKE '%answer%'
                    OR column_name ILIKE '%question%'
                    OR column_name ILIKE '%conversation%')
            ) THEN 'ผ่าน' ELSE 'ไม่ผ่าน มีคอลัมน์ที่ไม่ควรมี' END AS ผล;

DEALLOCATE บันทึกช่องว่าง;
DEALLOCATE บันทึกคะแนน;

-- ย้อนทุกอย่างที่ไฟล์นี้ทำ ไม่ให้เหลือข้อมูลทดสอบค้างในฐานข้อมูลจริง
ROLLBACK;

-- ยืนยันหลังย้อนกลับแล้วว่าไม่มีอะไรค้าง ต้องได้ 0 ทั้งสองค่า
SELECT (SELECT count(*) FROM knowledge_gaps WHERE keyword = 'คำทดสอบห้ามค้างไว้')
         AS แถวทดสอบที่ค้างในตารางช่องว่าง,
       (SELECT count(*) FROM answer_feedback WHERE response_time_ms IN (2100, 8400))
         AS แถวทดสอบที่ค้างในตารางคะแนน;
