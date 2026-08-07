#!/bin/bash
# สร้างตารางในฐานข้อมูล tax_advisor (users, conversations, tax_knowledge, tax_deductions)
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${APP_DB_NAME}" <<-'EOSQL'

-- =========================================================
-- ผู้ใช้งานที่ทักผ่าน LINE Official Account
-- =========================================================
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    line_user_id    VARCHAR(64) UNIQUE NOT NULL,
    display_name    VARCHAR(255),
    -- ความยินยอมให้เก็บข้อมูลส่วนบุคคล ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562
    --   pending ถามแล้วยังไม่ตอบ / granted ยินยอม / denied ไม่ยินยอม
    -- ค่าเริ่มต้นเป็น pending เสมอ ห้ามตั้งเป็น granted โดยอัตโนมัติ
    -- เพราะการนิ่งเฉยไม่ถือเป็นการให้ความยินยอม
    consent_status  VARCHAR(16) NOT NULL DEFAULT 'pending'
                    CHECK (consent_status IN ('pending', 'granted', 'denied')),
    consent_at      TIMESTAMPTZ,
    consent_version VARCHAR(16),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_consent_status ON users (consent_status);

-- =========================================================
-- ประวัติการสนทนา (บันทึกไว้เพื่อนำไปวิเคราะห์ผลในบทที่ 4)
-- =========================================================
CREATE TABLE IF NOT EXISTS conversations (
    id                SERIAL PRIMARY KEY,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role              VARCHAR(16) NOT NULL CHECK (role IN ('user', 'assistant')),
    message           TEXT NOT NULL,
    response_time_ms  INTEGER,        -- เวลาตอบสนอง ใช้ในการทดสอบประสิทธิภาพ
    matched_knowledge TEXT,           -- หัวข้อความรู้ที่ค้นเจอและใช้ประกอบการตอบ
    knowledge_hits    INTEGER,        -- จำนวนรายการที่ค้นเจอ ใช้คำนวณ retrieval hit rate
    model_name        VARCHAR(50),    -- แบบจำลองภาษาที่ใช้ ใช้เปรียบเทียบระหว่างเวอร์ชัน
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_id_created_at
    ON conversations (user_id, created_at);

-- =========================================================
-- หน่วยความจำบทสนทนาของ n8n (Postgres Chat Memory)
-- n8n สร้างให้อัตโนมัติ แต่ประกาศไว้เพื่อให้ติดตั้งซ้ำได้เหมือนเดิมทุกครั้ง
-- =========================================================
CREATE TABLE IF NOT EXISTS n8n_chat_histories (
    id         SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    message    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_n8n_chat_histories_session
    ON n8n_chat_histories (session_id);

-- =========================================================
-- ฐานความรู้กฎหมายภาษี (ใช้ประกอบการตอบคำถามของ AI Agent)
-- =========================================================
CREATE TABLE IF NOT EXISTS tax_knowledge (
    id              SERIAL PRIMARY KEY,
    category        VARCHAR(100) NOT NULL,      -- เช่น 'ภ.ง.ด.90', 'ค่าลดหย่อน', 'กำหนดเวลา'
    title           VARCHAR(255) NOT NULL,
    content         TEXT NOT NULL,
    source_url      VARCHAR(500),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================
-- ตารางอ้างอิงค่าลดหย่อนภาษีเงินได้บุคคลธรรมดา (สำหรับคำนวณเบื้องต้น)
-- =========================================================
CREATE TABLE IF NOT EXISTS tax_deductions (
    id              SERIAL PRIMARY KEY,
    deduction_name  VARCHAR(255) NOT NULL,
    max_amount      NUMERIC(12, 2) NOT NULL,
    description     TEXT,
    tax_year        INTEGER NOT NULL DEFAULT 2568
);

-- ---------------------------------------------------------
-- ข้อมูลตั้งต้น (seed) ค่าลดหย่อนหลักที่พบบ่อย ปีภาษี 2568
-- โปรดตรวจสอบ/อัปเดตให้ตรงกับประกาศกรมสรรพากรล่าสุดก่อนใช้งานจริง
-- ---------------------------------------------------------
INSERT INTO tax_deductions (deduction_name, max_amount, description, tax_year) VALUES
    ('ค่าลดหย่อนส่วนตัว', 60000, 'ลดหย่อนได้ทุกกรณีสำหรับผู้มีเงินได้', 2568),
    ('ค่าลดหย่อนคู่สมรส', 60000, 'กรณีคู่สมรสไม่มีเงินได้', 2568),
    ('ค่าลดหย่อนบุตร', 30000, 'ต่อบุตร 1 คน (คนที่ 2 เป็นต้นไปที่เกิดปี 2561+ ลดหย่อนเพิ่ม)', 2568),
    ('กองทุน RMF', 500000, 'ไม่เกิน 30% ของเงินได้พึงประเมิน และไม่เกิน 500,000 บาท เมื่อรวมกองทุนเพื่อการเกษียณอื่น', 2568),
    ('กองทุน SSF', 200000, 'ไม่เกิน 30% ของเงินได้พึงประเมิน และไม่เกิน 200,000 บาท', 2568),
    ('เบี้ยประกันชีวิต', 100000, 'กรมธรรม์อายุ 10 ปีขึ้นไป', 2568)
ON CONFLICT DO NOTHING;

-- =========================================================
-- ฐานความรู้กฎหมายภาษีแบบละเอียด (ใช้ทำ RAG ให้ AI Agent ค้นก่อนตอบ)
-- =========================================================
CREATE TABLE IF NOT EXISTS tax_law_knowledge (
    id          SERIAL PRIMARY KEY,
    category    VARCHAR(100),
    title       TEXT,
    content     TEXT,
    source      VARCHAR(200),
    tax_year    INTEGER DEFAULT 2567,
    created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_law_knowledge_fts
    ON tax_law_knowledge USING GIN (to_tsvector('simple', coalesce(category,'') || ' ' || coalesce(title,'') || ' ' || coalesce(content,'')));

-- =========================================================
-- มุมมองสำเร็จรูปสำหรับวิเคราะห์ผลในบทที่ 4
-- =========================================================
CREATE OR REPLACE VIEW v_response_time_stats AS
SELECT
    COUNT(*)                                                              AS จำนวนคำตอบ,
    ROUND(AVG(response_time_ms)::numeric, 2)                              AS เฉลี่ย_ms,
    ROUND(STDDEV_SAMP(response_time_ms)::numeric, 2)                      AS ส่วนเบี่ยงเบนมาตรฐาน_ms,
    MIN(response_time_ms)                                                 AS ต่ำสุด_ms,
    MAX(response_time_ms)                                                 AS สูงสุด_ms,
    ROUND(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY response_time_ms)::numeric, 2) AS มัธยฐาน_ms,
    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms)::numeric, 2) AS เปอร์เซ็นไทล์ที่95_ms
FROM conversations
WHERE role = 'assistant' AND response_time_ms IS NOT NULL;

CREATE OR REPLACE VIEW v_retrieval_stats AS
SELECT
    COUNT(*)                                                                       AS จำนวนคำถามทั้งหมด,
    COUNT(*) FILTER (WHERE knowledge_hits > 0)                                     AS ค้นเจอข้อมูลอ้างอิง,
    ROUND(100.0 * COUNT(*) FILTER (WHERE knowledge_hits > 0) / NULLIF(COUNT(*), 0), 2) AS อัตราค้นเจอ_ร้อยละ
FROM conversations
WHERE role = 'assistant';

CREATE OR REPLACE VIEW v_daily_usage AS
SELECT
    DATE(created_at AT TIME ZONE 'Asia/Bangkok') AS วันที่,
    COUNT(*) FILTER (WHERE role = 'user')        AS จำนวนคำถาม,
    COUNT(DISTINCT user_id)                      AS จำนวนผู้ใช้,
    ROUND(AVG(response_time_ms) FILTER (WHERE role = 'assistant')::numeric, 2) AS เวลาตอบสนองเฉลี่ย_ms
FROM conversations
GROUP BY 1
ORDER BY 1 DESC;

EOSQL

echo "Schema created in database '${APP_DB_NAME}'"
