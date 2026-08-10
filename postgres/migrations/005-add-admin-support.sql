-- ============================================================================
--  005-add-admin-support.sql
--  โครงสร้างข้อมูลสำหรับหน้าหลังบ้าน โดยผู้ดูแลต้องดูประวัติแชทไม่ได้
-- ----------------------------------------------------------------------------
--  ข้อกำหนดที่เป็นตัวตั้งของการออกแบบนี้
--
--    ผู้ดูแลระบบต้องไม่สามารถอ่านประวัติการสนทนาได้ ไม่ว่าด้วยเหตุผลใด
--    ข้อกำหนดนี้เข้มกว่าที่ พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 บังคับ
--    และเป็นการตัดสินใจเชิงออกแบบของผู้จัดทำ ไม่ใช่ข้อจำกัดทางเทคนิค
--
--  ปัญหาที่ตามมา และวิธีแก้
--
--    ถ้าผู้ดูแลอ่านคำถามไม่ได้เลย จะไม่มีทางรู้ว่าฐานข้อมูลขาดเรื่องอะไร
--    ระบบจึงต้องสกัดสิ่งที่จำเป็นออกมาเก็บแยก ตั้งแต่ตอนที่ประมวลผลคำถาม
--
--      เก็บได้    คำสำคัญที่ระบบค้นแล้วไม่เจอในฐานข้อมูล
--                หมวดของคำถาม
--                คะแนนความพึงพอใจที่ผู้ใช้กด
--      ไม่เก็บ    ข้อความที่ผู้ใช้พิมพ์
--                คำตอบที่ระบบตอบ
--                สิ่งใดก็ตามที่ชี้กลับไปหาผู้ใช้รายบุคคลได้
--
--    คำสำคัญที่ระบบสกัดเองไม่ใช่ข้อความของผู้ใช้ และไม่ระบุตัวบุคคล
--    ผู้ดูแลจึงรู้ว่า "ขาดความรู้เรื่องนี้" ได้โดยไม่เห็นว่าใครถามว่าอะไร
--
--  วิธีรัน
--    docker cp postgres\migrations\005-add-admin-support.sql tax-advisor-postgres:/tmp/m005.sql
--    docker exec -it tax-advisor-postgres psql -U n8n_admin -d tax_advisor -f /tmp/m005.sql
--
--  รันซ้ำได้ ไม่ทำให้ข้อมูลเดิมเสียหาย
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  1) ช่องว่างของฐานข้อมูล ที่ระบบสกัดได้เอง
-- ---------------------------------------------------------------------------
--  บันทึกเฉพาะ "คำสำคัญ" กับ "หมวด" ไม่มีข้อความของผู้ใช้อยู่ในตารางนี้
--  ตั้งใจไม่ให้มีคอลัมน์ user_id หรือ conversation_id
--  เพราะถ้ามี จะเชื่อมกลับไปหาบทสนทนาได้ ซึ่งขัดกับข้อกำหนด
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_gaps (
    id            SERIAL PRIMARY KEY,

    -- คำสำคัญที่ระบบดักได้จากคำถาม แต่ค้นในฐานข้อมูลแล้วไม่เจอ
    -- เก็บเป็นคำเดี่ยว ไม่ใช่ประโยค เช่น บุตรบุญธรรม ไม่ใช่ ลดหย่อนบุตรบุญธรรมได้มั้ย
    keyword       VARCHAR(100) NOT NULL,

    -- หมวดที่ระบบจำแนกได้ตอนนั้น ใช้ดูว่าช่องว่างกระจุกอยู่หมวดไหน
    category      VARCHAR(100),

    -- นับจำนวนครั้งที่เจอคำนี้ แทนการบันทึกทีละแถว
    -- ทำแบบนี้ทำให้ผูกกลับไปหาเหตุการณ์รายครั้งไม่ได้ ซึ่งเป็นผลพลอยได้ที่ต้องการ
    hit_count     INTEGER NOT NULL DEFAULT 1,

    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    --   open     ยังไม่ได้เติมความรู้
    --   done     เติมแล้ว
    --   wontfix  พิจารณาแล้วไม่ทำ ต้องเขียนเหตุผลใน note
    status        VARCHAR(16) NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'done', 'wontfix')),
    note          TEXT,
    resolved_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_gaps_keyword
    ON knowledge_gaps (keyword);
CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_open
    ON knowledge_gaps (status, hit_count DESC)
    WHERE status = 'open';

COMMENT ON TABLE knowledge_gaps IS
  'คำสำคัญที่ค้นในฐานข้อมูลไม่เจอ สกัดจากคำถามโดยระบบ ไม่มีข้อความของผู้ใช้';
COMMENT ON COLUMN knowledge_gaps.keyword IS
  'คำเดี่ยวที่ระบบดักได้ ไม่ใช่ประโยคของผู้ใช้ จึงไม่ถือเป็นข้อมูลส่วนบุคคล';
COMMENT ON COLUMN knowledge_gaps.hit_count IS
  'นับรวมแทนการเก็บรายครั้ง ทำให้ย้อนกลับไปหาเหตุการณ์รายบุคคลไม่ได้';


-- ---------------------------------------------------------------------------
--  2) ความพึงพอใจของผู้ใช้ต่อคำตอบ
-- ---------------------------------------------------------------------------
--  ผู้ใช้กดให้คะแนนคำตอบได้ผ่านปุ่มใน LINE
--  ตารางนี้เก็บเฉพาะคะแนนกับหมวด ไม่เก็บว่าคำตอบนั้นคืออะไร และไม่เก็บว่าใครกด
--
--  เหตุผลที่ไม่เก็บ user_id
--    ถ้าเก็บไว้ จะดูย้อนหลังได้ว่าผู้ใช้คนนี้พอใจหรือไม่พอใจอะไรบ้าง
--    ซึ่งเป็นการสร้างโปรไฟล์พฤติกรรมรายบุคคล เกินกว่าที่แจ้งไว้ในข้อความขอความยินยอม
--    การวัดความพึงพอใจภาพรวมไม่จำเป็นต้องรู้ว่าใครกด
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answer_feedback (
    id           SERIAL PRIMARY KEY,

    -- 1 = ตรงคำถาม   0 = ไม่ตรงคำถาม
    -- ใช้สองระดับเพราะผู้ใช้บน LINE กดปุ่มเดียวจบ ถ้าให้เลือก 1 ถึง 5 คนจะไม่กด
    is_helpful   BOOLEAN NOT NULL,

    -- หมวดของคำถามที่ได้คะแนนนี้ ใช้ดูว่าหมวดไหนตอบได้ดีหรือไม่ดี
    category     VARCHAR(100),

    -- ค้นเจอข้อมูลอ้างอิงกี่รายการตอนตอบคำถามนั้น
    -- ใช้ตรวจสมมติฐานว่า ค้นเจอน้อย ทำให้คนไม่พอใจ จริงหรือไม่
    knowledge_hits INTEGER,

    -- เวลาที่ใช้ตอบ ใช้ตรวจสมมติฐานว่า ตอบช้า ทำให้คนไม่พอใจ จริงหรือไม่
    response_time_ms INTEGER,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_answer_feedback_created
    ON answer_feedback (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_answer_feedback_category
    ON answer_feedback (category, is_helpful);

COMMENT ON TABLE answer_feedback IS
  'คะแนนความพึงพอใจต่อคำตอบ ไม่เก็บว่าใครกดและไม่เก็บว่าคำตอบคืออะไร';
COMMENT ON COLUMN answer_feedback.is_helpful IS
  'true คือผู้ใช้กดว่าตรงคำถาม false คือกดว่าไม่ตรง';


-- ---------------------------------------------------------------------------
--  3) มุมมองสรุปการใช้งาน สำหรับหน้าแดชบอร์ด
-- ---------------------------------------------------------------------------
--  สร้างเป็น VIEW เพื่อให้หน้าหลังบ้านเรียกได้โดยไม่ต้องแตะตาราง conversations โดยตรง
--  VIEW นี้คืนเฉพาะตัวเลขนับ ไม่มีคอลัมน์ message อยู่ในผลลัพธ์เลย
--  ต่อให้มีคนเขียนโค้ดหน้าเว็บผิด ก็ดึงข้อความออกมาไม่ได้อยู่ดี
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_usage_daily AS
SELECT
    created_at::date                                    AS วันที่,
    count(*) FILTER (WHERE role = 'user')               AS จำนวนคำถาม,
    count(DISTINCT user_id)                             AS จำนวนผู้ใช้,
    round(avg(response_time_ms) FILTER (WHERE role = 'assistant'))
                                                        AS เวลาตอบเฉลี่ย_ms,
    count(*) FILTER (WHERE role = 'assistant' AND coalesce(knowledge_hits, 0) = 0)
                                                        AS ครั้งที่ค้นไม่เจอ
FROM conversations
GROUP BY 1;

COMMENT ON VIEW v_usage_daily IS
  'สรุปการใช้งานรายวัน คืนเฉพาะตัวเลขนับ ไม่มีข้อความของผู้ใช้ในผลลัพธ์';

CREATE OR REPLACE VIEW v_usage_monthly AS
SELECT
    to_char(created_at, 'YYYY-MM')                      AS เดือน,
    count(*) FILTER (WHERE role = 'user')               AS จำนวนคำถาม,
    count(DISTINCT user_id)                             AS จำนวนผู้ใช้,
    round(avg(response_time_ms) FILTER (WHERE role = 'assistant'))
                                                        AS เวลาตอบเฉลี่ย_ms
FROM conversations
GROUP BY 1;

CREATE OR REPLACE VIEW v_usage_yearly AS
SELECT
    to_char(created_at, 'YYYY')                         AS ปี,
    count(*) FILTER (WHERE role = 'user')               AS จำนวนคำถาม,
    count(DISTINCT user_id)                             AS จำนวนผู้ใช้
FROM conversations
GROUP BY 1;


-- ---------------------------------------------------------------------------
--  4) บัญชีฐานข้อมูลสำหรับหน้าหลังบ้าน ที่อ่านข้อความไม่ได้ในระดับฐานข้อมูล
-- ---------------------------------------------------------------------------
--  ด่านสำคัญที่สุดของข้อกำหนดนี้
--
--  การพึ่งพาโค้ดหน้าเว็บอย่างเดียวไม่พอ เพราะวันหนึ่งอาจมีคนแก้โค้ดแล้วพลาด
--  จึงบังคับที่ระดับสิทธิ์ของฐานข้อมูลด้วย
--  บัญชีนี้ไม่มีสิทธิ์ SELECT บนตาราง conversations และ n8n_chat_histories เลย
--  ต่อให้เขียนคำสั่ง SELECT message FROM conversations ก็จะถูกปฏิเสธ
--
--  ตั้งรหัสผ่านจริงผ่านตัวแปร ADMIN_DB_PASSWORD ในไฟล์ .env
--  แล้วรันคำสั่ง ALTER ROLE ... PASSWORD ... ตามที่ระบุในเอกสาร
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tax_admin_readonly') THEN
        CREATE ROLE tax_admin_readonly LOGIN PASSWORD 'ต้องเปลี่ยนรหัสผ่านนี้ทันที';
    END IF;
END
$$;

-- เพิกถอนสิทธิ์ทั้งหมดก่อน แล้วค่อยให้เฉพาะที่จำเป็น
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM tax_admin_readonly;
GRANT USAGE ON SCHEMA public TO tax_admin_readonly;

-- อ่านและแก้ไขฐานข้อมูลได้ เพราะเป็นหน้าที่หลักของผู้ดูแล
GRANT SELECT, INSERT, UPDATE, DELETE ON tax_law_knowledge TO tax_admin_readonly;
GRANT USAGE, SELECT ON SEQUENCE tax_law_knowledge_id_seq TO tax_admin_readonly;

-- อ่านตัวบทกฎหมายได้ แต่แก้ไม่ได้ เพราะดึงมาจากเว็บกรมสรรพากรโดยตรง
GRANT SELECT ON revenue_code_current TO tax_admin_readonly;

-- จัดการรายการช่องว่างความรู้และดูคะแนนความพึงพอใจได้
GRANT SELECT, INSERT, UPDATE ON knowledge_gaps TO tax_admin_readonly;
GRANT USAGE, SELECT ON SEQUENCE knowledge_gaps_id_seq TO tax_admin_readonly;
GRANT SELECT ON answer_feedback TO tax_admin_readonly;

-- ดูสรุปการใช้งานได้ผ่าน VIEW เท่านั้น
GRANT SELECT ON v_usage_daily, v_usage_monthly, v_usage_yearly TO tax_admin_readonly;

-- ย้ำอีกครั้งว่าห้ามแตะตารางที่มีข้อความของผู้ใช้
-- บรรทัดนี้ซ้ำซ้อนกับ REVOKE ALL ข้างบน แต่เขียนไว้ให้ชัดเจนว่าเป็นความตั้งใจ
REVOKE ALL ON conversations FROM tax_admin_readonly;
REVOKE ALL ON n8n_chat_histories FROM tax_admin_readonly;
REVOKE ALL ON users FROM tax_admin_readonly;

COMMIT;

-- ============================================================================
--  ตรวจผลหลังรัน
-- ============================================================================

-- ต้องไม่มีแถวใดคืนมาจากคำสั่งนี้ ถ้ามีแปลว่าสิทธิ์รั่ว
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'tax_admin_readonly'
  AND table_name IN ('conversations', 'n8n_chat_histories', 'users');

-- รายการที่บัญชีนี้เข้าถึงได้จริง
SELECT table_name, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS สิทธิ์
FROM information_schema.role_table_grants
WHERE grantee = 'tax_admin_readonly'
GROUP BY table_name
ORDER BY table_name;
