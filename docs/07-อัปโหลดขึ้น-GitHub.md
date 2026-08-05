# วิธีอัปโหลดโปรเจกต์ขึ้น GitHub

> repository ปลายทาง: https://github.com/cchiOru/Tax-Advisor-AI-Chatbot-LINE-v3

---

## ผลการตรวจสอบความปลอดภัย (ตรวจแล้วก่อนหน้านี้)

ไฟล์ `.gitignore` กันไฟล์เหล่านี้ไว้ถูกต้องแล้ว ยืนยันด้วยการทดสอบจริง

| ไฟล์ | สถานะ | เหตุผล |
|---|---|---|
| `.env` | ไม่ถูกอัปโหลด | มีกุญแจ API ทั้งหมด |
| `backup/` | ไม่ถูกอัปโหลด | ไฟล์สำรองฐานข้อมูล อาจมีข้อมูลผู้ใช้จริง |
| `evaluation/results/` | ไม่ถูกอัปโหลด | ผลการทดลอง สร้างใหม่ได้ |
| `postgres/seed-revenue-code.sql` | ไม่ถูกอัปโหลด | ขนาด 13 MB สร้างใหม่ได้จากสคริปต์ |

ตรวจเนื้อหาไฟล์ทุกไฟล์ที่จะอัปโหลดแล้ว **ไม่พบกุญแจ API ของ OpenAI, Gemini, LINE หรือ ngrok**

---

## ขั้นตอนที่ 1: ลบโฟลเดอร์ .git ที่ค้างอยู่

โฟลเดอร์นี้ถูกสร้างค้างไว้และมีไฟล์ล็อกที่ลบไม่ได้จากฝั่งเครื่องมือ ต้องลบด้วยตัวเอง

เปิด **PowerShell** แล้วรัน

```powershell
cd D:\project
Remove-Item .git -Recurse -Force
Remove-Item .movetest -Recurse -Force -ErrorAction SilentlyContinue
```

---

## ขั้นตอนที่ 2: ตั้งค่า Git ครั้งแรก (ข้ามได้ถ้าเคยตั้งแล้ว)

```powershell
git config --global user.name "Yodsakorn Jangmanee"
git config --global user.email "kanoi7654@gmail.com"
```

---

## ขั้นตอนที่ 3: สร้าง repository และเพิ่มไฟล์

```powershell
cd D:\project
git init
git add -A
```

---

## ขั้นตอนที่ 4: ตรวจสอบก่อนอัปโหลด (สำคัญที่สุด อย่าข้าม)

```powershell
git status --short
```

**สิ่งที่ต้องเห็น** — รายการควรมีประมาณ 20 ไฟล์ และ**ต้องไม่มี** `.env` อยู่ในรายการ

ตรวจซ้ำอีกชั้นด้วยคำสั่งนี้

```powershell
git ls-files | Select-String -Pattern "^\.env$"
```

**ถ้าไม่มีผลลัพธ์ออกมา แปลว่าปลอดภัย** ไปขั้นตอนถัดไปได้

**ถ้ามีผลลัพธ์ออกมาว่า `.env`** ให้หยุดทันที แล้วรัน

```powershell
git rm --cached .env
```
แล้วตรวจใหม่จนกว่าจะไม่มีผลลัพธ์

---

## ขั้นตอนที่ 5: บันทึกและอัปโหลด

```powershell
git commit -m "Tax Advisor AI Chatbot on LINE v3"
git branch -M main
git remote add origin https://github.com/cchiOru/Tax-Advisor-AI-Chatbot-LINE-v3.git
git push -u origin main
```

ระหว่าง push จะมีหน้าต่างให้ล็อกอิน GitHub ขึ้นมา ล็อกอินตามปกติ

---

## ขั้นตอนที่ 6: ตรวจสอบบนเว็บ

เปิด https://github.com/cchiOru/Tax-Advisor-AI-Chatbot-LINE-v3 แล้วตรวจว่า

- เห็นไฟล์ README แสดงเป็นหน้าแรกของ repository
- **ไม่มีไฟล์ `.env` อยู่ในรายการไฟล์**
- มีโฟลเดอร์ `docs`, `n8n`, `postgres`, `tests`, `evaluation`, `pgadmin`

---

## สิ่งที่ต้องทำต่อเรื่องความปลอดภัย

repository เดิม `Demo_Legal_AI` มีไฟล์ `.env` อยู่ในนั้น ซึ่งหมายความว่ากุญแจ API ทั้งหมด
ที่เคยใช้ถือว่ารั่วไหลไปแล้ว **การลบไฟล์ออกไม่เพียงพอ เพราะประวัติการ commit ยังเก็บค่าเดิมไว้**

ต้องออกกุญแจใหม่ทุกตัว

| บริการ | ที่ออกใหม่ |
|---|---|
| OpenAI | https://platform.openai.com/api-keys → Revoke กุญแจเดิม แล้ว Create ใหม่ |
| Google Gemini | https://aistudio.google.com/apikey → ลบกุญแจเดิม แล้วสร้างใหม่ |
| LINE | Developers Console → Messaging API → Issue channel access token ใหม่ |
| ngrok | https://dashboard.ngrok.com/get-started/your-authtoken → Reset |

หลังออกกุญแจใหม่แล้ว นำค่าใหม่ใส่ในไฟล์ `.env` แล้วรัน

```powershell
docker compose up -d --force-recreate n8n
```

พิจารณาลบ repository เดิม `Demo_Legal_AI` ทิ้งด้วย เพื่อไม่ให้กุญแจเก่าค้างอยู่ในประวัติสาธารณะ

---

## หากต้องการอัปเดต repository ในอนาคต

```powershell
cd D:\project
git add -A
git status --short          # ตรวจก่อนทุกครั้งว่าไม่มี .env
git commit -m "อธิบายสิ่งที่แก้ไข"
git push
```
