-- ============================================================================
--  Migration 003: เพิ่มการวิเคราะห์ประเภทคำถาม และข้อมูลโปรไฟล์ผู้ใช้
-- ----------------------------------------------------------------------------
--  เหตุผล:
--    1) ขอบเขตระบบระบุว่าต้อง "วิเคราะห์ประเภทคำถาม (Intent Analysis)"
--       เดิมระบบตัดสินใจโดยปริยายผ่าน AI Agent แต่ไม่ได้บันทึกผลไว้
--       จึงนำไปวิเคราะห์พฤติกรรมการใช้งานไม่ได้ ต้องเพิ่มช่องเก็บผลการจำแนก
--
--    2) ขอบเขตระบบระบุว่าต้อง "จดจำข้อมูลและประวัติผู้ใช้"
--       เดิมตาราง users มีช่อง display_name แต่ไม่เคยถูกกรอก
--       เพราะระบบไม่ได้เรียก LINE Profile API จึงต้องเพิ่มช่องเก็บข้อมูลโปรไฟล์
--
--  วิธีรัน:
--    docker cp postgres\migrations\003-add-intent-and-profile.sql tax-advisor-postgres:/tmp/m003.sql
--    docker exec -it tax-advisor-postgres psql -U <POSTGRES_USER> -d tax_advisor -f /tmp/m003.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) ช่องเก็บผลการวิเคราะห์ประเภทคำถาม
-- ---------------------------------------------------------------------------
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS question_category VARCHAR(50);

COMMENT ON COLUMN conversations.question_category IS
  'ประเภทคำถามที่ระบบจำแนกได้ ใช้วิเคราะห์พฤติกรรมการใช้งานและความต้องการของผู้ใช้';

-- ---------------------------------------------------------------------------
-- 2) ช่องเก็บข้อมูลโปรไฟล์ผู้ใช้จาก LINE
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS picture_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_message TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT now();

COMMENT ON COLUMN users.display_name IS 'ชื่อที่ผู้ใช้ตั้งไว้ใน LINE ดึงมาจาก LINE Profile API';
COMMENT ON COLUMN users.first_seen_at IS 'เวลาที่ผู้ใช้ทักเข้ามาครั้งแรก ใช้แยกผู้ใช้ใหม่กับผู้ใช้เดิม';

-- ---------------------------------------------------------------------------
-- 3) มุมมองสรุปประเภทคำถาม สำหรับวิเคราะห์ผลในบทที่ 4
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_intent_stats AS
SELECT
    COALESCE(question_category, 'ไม่ระบุ')                        AS ประเภทคำถาม,
    COUNT(*)                                                       AS จำนวนครั้ง,
    ROUND(100.0 * COUNT(*) / NULLIF(SUM(COUNT(*)) OVER (), 0), 2)  AS ร้อยละ,
    ROUND(AVG(response_time_ms)::numeric, 0)                       AS เวลาเฉลี่ย_ms,
    ROUND(AVG(knowledge_hits)::numeric, 2)                         AS ความรู้เฉลี่ย
FROM conversations
WHERE role = 'assistant'
GROUP BY question_category
ORDER BY COUNT(*) DESC;

COMMENT ON VIEW v_intent_stats IS
  'สัดส่วนประเภทคำถามที่ผู้ใช้ถาม ใช้ตอบว่าผู้ใช้ต้องการอะไรจากระบบมากที่สุด';

-- ---------------------------------------------------------------------------
-- 4) มุมมองสรุปข้อมูลผู้ใช้ สำหรับอธิบายกลุ่มตัวอย่างในบทที่ 4
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_user_stats AS
SELECT
    u.id,
    u.display_name                                            AS ชื่อผู้ใช้,
    COUNT(*) FILTER (WHERE c.role = 'user')                   AS จำนวนคำถาม,
    MIN(c.created_at)                                         AS ใช้งานครั้งแรก,
    MAX(c.created_at)                                         AS ใช้งานล่าสุด,
    ROUND(AVG(c.response_time_ms) FILTER (WHERE c.role = 'assistant')::numeric, 0)
                                                              AS เวลาตอบสนองเฉลี่ย_ms
FROM users u
LEFT JOIN conversations c ON c.user_id = u.id
GROUP BY u.id, u.display_name
ORDER BY COUNT(*) FILTER (WHERE c.role = 'user') DESC;

COMMENT ON VIEW v_user_stats IS
  'สรุปการใช้งานรายบุคคล ใช้อธิบายลักษณะกลุ่มตัวอย่างที่ทดสอบระบบ';

COMMIT;

-- ---------------------------------------------------------------------------
-- ตรวจสอบผล
-- ---------------------------------------------------------------------------
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'conversations'
ORDER BY ordinal_position;

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'users'
ORDER BY ordinal_position;
