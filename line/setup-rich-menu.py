#!/usr/bin/env python3
"""
สร้างและติดตั้ง Rich Menu ของ LINE OA ให้ระบบที่ปรึกษาภาษี

Rich Menu คือแถบเมนูที่แสดงค้างอยู่ด้านล่างหน้าจอแชท
ทำให้ผู้ใช้กดถามคำถามที่พบบ่อยได้ทันทีโดยไม่ต้องพิมพ์

ทำไมถึงสำคัญกับงานนี้
---------------------
ปัญหาที่ระบุไว้ในโครงงานข้อหนึ่งคือ "ไม่มีเวลาหาที่ปรึกษา"
การพิมพ์คำถามเองก็เป็นการเสียเวลาของผู้ใช้เช่นกัน โดยเฉพาะผู้ที่ไม่รู้ว่าควรถามอะไร
Rich Menu จึงทำสองอย่างพร้อมกัน
  1. ลดเวลาที่ผู้ใช้ต้องใช้ในการเริ่มต้น เหลือแค่กดปุ่มเดียว
  2. บอกขอบเขตของระบบโดยไม่ต้องอธิบาย ผู้ใช้เห็นปุ่มก็รู้ทันทีว่าถามอะไรได้บ้าง

สิ่งที่สคริปต์นี้ทำ
-------------------
  1. เลือกรูปเมนูขนาด 2,500 x 1,686 พิกเซล
     ถ้ามีไฟล์ rich-menu-custom.png (รูปที่ออกแบบเอง) จะใช้ไฟล์นั้น
     ถ้าไม่มี จะวาดรูปสำรองขึ้นเองด้วย Pillow
  2. สร้าง Rich Menu ผ่าน LINE Messaging API
  3. อัปโหลดรูปเข้าไปผูกกับเมนูนั้น
  4. ตั้งเป็นเมนูเริ่มต้นของผู้ใช้ทุกคน

ใช้รูปที่ออกแบบเอง
------------------
ส่งออกจากโปรแกรมออกแบบให้ได้ขนาด 2500 x 1686 พิกเซล ไฟล์ PNG ไม่เกิน 1 MB
แล้ววางไว้ที่ line/rich-menu-custom.png

ลำดับปุ่มในรูปต้องเรียงแบบเดียวกับตัวแปร BUTTONS ด้านล่าง คือ
    แถวบน  คำนวณภาษี | ค่าลดหย่อน | กำหนดยื่นภาษี
    แถวล่าง ยื่นล่าช้า | ขั้นตอนยื่นออนไลน์ | ติดต่อกรมสรรพากร
เพราะพื้นที่กดถูกคำนวณจากลำดับในตัวแปรนั้น ไม่ได้อ่านจากตัวรูป
ถ้าสลับตำแหน่งในรูปโดยไม่แก้ตัวแปร ผู้ใช้จะกดปุ่มหนึ่งแล้วได้คำตอบของอีกปุ่ม

วิธีใช้
-------
    pip install pillow requests
    python line/setup-rich-menu.py

อ่านค่า LINE_CHANNEL_ACCESS_TOKEN จากไฟล์ .env ให้อัตโนมัติ

คำสั่งเสริม
-----------
    python line/setup-rich-menu.py --image-only   วาดรูปอย่างเดียว ไม่ติดต่อ LINE
    python line/setup-rich-menu.py --list         ดูเมนูที่มีอยู่
    python line/setup-rich-menu.py --clean        ลบเมนูเดิมทั้งหมดก่อนสร้างใหม่
"""

import json
import sys
from pathlib import Path

try:
    import requests
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("ต้องติดตั้งไลบรารีก่อน:\n    pip install pillow requests")

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent

# รูปที่สคริปต์วาดเอง ใช้เป็นตัวสำรองเมื่อไม่มีรูปที่ออกแบบไว้
IMG_PATH = HERE / "rich-menu.png"

# รูปที่ออกแบบเองจากภายนอก เช่น Canva หรือ Figma
# ถ้ามีไฟล์นี้อยู่ สคริปต์จะใช้ไฟล์นี้แทนรูปที่วาดเองเสมอ
# เหตุผลที่แยกไฟล์ ไม่ทับไฟล์เดิม
#   รูปที่วาดเองสร้างใหม่ได้ตลอดจากโค้ด แต่รูปที่ออกแบบเองสร้างใหม่ไม่ได้
#   ถ้าเก็บชื่อเดียวกัน การรันสคริปต์ครั้งถัดไปจะเขียนทับงานออกแบบทิ้ง
CUSTOM_IMG_PATH = HERE / "rich-menu-custom.png"

# ขนาดที่ LINE กำหนดสำหรับ Rich Menu แบบเต็ม
W, H = 2500, 1686
COLS, ROWS = 3, 2
CW, CH = W // COLS, H // ROWS

# ขนาดไอคอนราว 22% ของความสูงช่อง เป็นสัดส่วนที่เห็นชัดบนมือถือโดยไม่เบียดข้อความ
ICON_R = int(CH * 0.11)
ICON_W = max(6, int(CH * 0.012))

# ปุ่มทั้ง 6 เลือกจากหมวดคำถามที่ระบบทำคะแนนได้ดีและผู้ใช้ถามบ่อยที่สุด
# ข้อความในช่อง text คือสิ่งที่จะถูกส่งเข้าระบบเหมือนผู้ใช้พิมพ์เอง
# จึงต้องเขียนให้ตรงกับคำสำคัญที่ระบบใช้ค้นฐานความรู้
BUTTONS = [
    {
        "title": "คำนวณภาษี",
        "icon": "calculator",
        "subtitle": "รู้ยอดภาษีที่ต้องจ่าย",
        "text": "อยากคำนวณภาษี ต้องบอกข้อมูลอะไรบ้าง",
        "color": (0x1D, 0x9E, 0x75),
    },
    {
        "title": "ค่าลดหย่อน",
        "icon": "receipt",
        "subtitle": "ลดหย่อนอะไรได้บ้าง",
        "text": "ค่าลดหย่อนภาษีมีอะไรบ้าง",
        "color": (0x37, 0x8A, 0xDD),
    },
    {
        "title": "กำหนดยื่นภาษี",
        "icon": "calendar",
        "subtitle": "ยื่นเมื่อไหร่ ใช้แบบไหน",
        "text": "ต้องยื่นภาษีเมื่อไหร่ และใช้แบบไหน",
        "color": (0x7F, 0x77, 0xDD),
    },
    {
        "title": "ยื่นล่าช้า",
        "icon": "alarm",
        "subtitle": "ค่าปรับและเงินเพิ่ม",
        "text": "ยื่นภาษีล่าช้าต้องเสียค่าปรับและเงินเพิ่มเท่าไหร่",
        "color": (0xD8, 0x5A, 0x30),
    },
    {
        "title": "ขั้นตอนยื่นออนไลน์",
        "icon": "monitor",
        "subtitle": "ยื่นผ่าน rd.go.th",
        "text": "ขั้นตอนการยื่นภาษีออนไลน์ทำอย่างไร",
        "color": (0xBA, 0x75, 0x17),
    },
    {
        "title": "ติดต่อกรมสรรพากร",
        "icon": "phone",
        "subtitle": "สายด่วน 1161",
        "text": "ขอช่องทางติดต่อกรมสรรพากร",
        "color": (0x5F, 0x5E, 0x5A),
    },
]



# ---------------------------------------------------------------------------
# ไอคอนประจำแต่ละปุ่ม วาดด้วยเส้นแทนการใช้ไฟล์ภาพ
# ---------------------------------------------------------------------------
# เหตุผลที่วาดเอง ไม่ใช้ไฟล์ไอคอนสำเร็จรูป
#   1. ไม่ต้องพึ่งไฟล์ภายนอกหรือสัญญาอนุญาตของไอคอนชุดใด
#   2. ปรับสีให้เข้ากับสีประจำปุ่มได้อัตโนมัติ ทั้ง 6 ปุ่มจึงเป็นชุดเดียวกันแน่นอน
#   3. คมชัดทุกขนาดเพราะวาดตามพิกัดจริง ไม่ได้ย่อขยายจากภาพ
#
# ทุกไอคอนเป็นแบบเส้น ความหนาเท่ากันหมด เพื่อให้ดูเป็นชุดเดียวกัน


def _icon_calculator(d, cx, cy, r, color, w):
    """เครื่องคิดเลข สื่อถึงการคำนวณภาษี"""
    d.rounded_rectangle([cx - r * 0.62, cy - r, cx + r * 0.62, cy + r], radius=r * 0.16,
                        outline=color, width=w)
    d.rounded_rectangle([cx - r * 0.42, cy - r * 0.78, cx + r * 0.42, cy - r * 0.38],
                        radius=r * 0.06, outline=color, width=w)
    for row in range(3):
        for col in range(3):
            x = cx - r * 0.34 + col * r * 0.34
            y = cy - r * 0.08 + row * r * 0.32
            d.ellipse([x - r * 0.08, y - r * 0.08, x + r * 0.08, y + r * 0.08], fill=color)


def _icon_receipt(d, cx, cy, r, color, w):
    """ใบเสร็จขอบหยักพร้อมสัญลักษณ์บาท สื่อถึงค่าลดหย่อน"""
    top, bot = cy - r, cy + r * 0.72
    left, right = cx - r * 0.6, cx + r * 0.6
    zig = [(left, bot)]
    steps = 6
    for i in range(steps + 1):
        x = left + (right - left) * i / steps
        zig.append((x, bot + (r * 0.16 if i % 2 else 0)))
    d.line([(left, bot), (left, top), (right, top), (right, bot)], fill=color, width=w, joint="curve")
    d.line(zig, fill=color, width=w, joint="curve")
    d.line([(cx - r * 0.22, cy - r * 0.52), (cx + r * 0.22, cy - r * 0.52)], fill=color, width=w)
    d.line([(cx - r * 0.22, cy - r * 0.18), (cx + r * 0.22, cy - r * 0.18)], fill=color, width=w)
    d.line([(cx - r * 0.22, cy + r * 0.16), (cx + r * 0.05, cy + r * 0.16)], fill=color, width=w)


def _icon_calendar(d, cx, cy, r, color, w):
    """ปฏิทินพร้อมเครื่องหมายถูก สื่อถึงกำหนดเวลายื่นภาษี"""
    d.rounded_rectangle([cx - r * 0.72, cy - r * 0.72, cx + r * 0.72, cy + r * 0.78],
                        radius=r * 0.12, outline=color, width=w)
    d.line([(cx - r * 0.72, cy - r * 0.3), (cx + r * 0.72, cy - r * 0.3)], fill=color, width=w)
    for x in (cx - r * 0.36, cx + r * 0.36):
        d.line([(x, cy - r), (x, cy - r * 0.56)], fill=color, width=w)
    d.line([(cx - r * 0.32, cy + r * 0.22), (cx - r * 0.06, cy + r * 0.46),
            (cx + r * 0.38, cy - r * 0.04)], fill=color, width=int(w * 1.2), joint="curve")


def _icon_alarm(d, cx, cy, r, color, w):
    """นาฬิกาปลุก สื่อถึงการยื่นล่าช้าและค่าปรับ"""
    d.ellipse([cx - r * 0.72, cy - r * 0.62, cx + r * 0.72, cy + r * 0.82], outline=color, width=w)
    d.line([(cx - r * 0.86, cy - r * 0.62), (cx - r * 0.5, cy - r * 0.94)], fill=color, width=w)
    d.line([(cx + r * 0.86, cy - r * 0.62), (cx + r * 0.5, cy - r * 0.94)], fill=color, width=w)
    d.line([(cx, cy + r * 0.1), (cx, cy - r * 0.24)], fill=color, width=w)
    d.line([(cx, cy + r * 0.1), (cx + r * 0.3, cy + r * 0.1)], fill=color, width=w)


def _icon_monitor(d, cx, cy, r, color, w):
    """จอภาพพร้อมลูกศรส่งขึ้น สื่อถึงการยื่นภาษีออนไลน์"""
    d.rounded_rectangle([cx - r * 0.82, cy - r * 0.78, cx + r * 0.82, cy + r * 0.32],
                        radius=r * 0.1, outline=color, width=w)
    d.line([(cx, cy + r * 0.32), (cx, cy + r * 0.62)], fill=color, width=w)
    d.line([(cx - r * 0.4, cy + r * 0.72), (cx + r * 0.4, cy + r * 0.72)], fill=color, width=w)
    d.line([(cx, cy + r * 0.06), (cx, cy - r * 0.5)], fill=color, width=w)
    d.line([(cx - r * 0.22, cy - r * 0.28), (cx, cy - r * 0.52),
            (cx + r * 0.22, cy - r * 0.28)], fill=color, width=w, joint="curve")


def _icon_phone(d, cx, cy, r, color, w):
    """หูฟังคอลเซ็นเตอร์ สื่อถึงช่องทางติดต่อกรมสรรพากร"""
    d.arc([cx - r * 0.8, cy - r * 0.86, cx + r * 0.8, cy + r * 0.5], 180, 360, fill=color, width=w)
    d.rounded_rectangle([cx - r * 0.86, cy - r * 0.2, cx - r * 0.5, cy + r * 0.46],
                        radius=r * 0.16, outline=color, width=w)
    d.rounded_rectangle([cx + r * 0.5, cy - r * 0.2, cx + r * 0.86, cy + r * 0.46],
                        radius=r * 0.16, outline=color, width=w)
    d.arc([cx + r * 0.1, cy + r * 0.16, cx + r * 0.78, cy + r * 0.84], 0, 90, fill=color, width=w)
    d.line([(cx + r * 0.44, cy + r * 0.84), (cx + r * 0.1, cy + r * 0.84)], fill=color, width=w)


ICONS = {
    "calculator": _icon_calculator,
    "receipt": _icon_receipt,
    "calendar": _icon_calendar,
    "alarm": _icon_alarm,
    "monitor": _icon_monitor,
    "phone": _icon_phone,
}


def load_token() -> str:
    """อ่าน LINE_CHANNEL_ACCESS_TOKEN จากไฟล์ .env"""
    env = ROOT / ".env"
    if not env.exists():
        sys.exit("ไม่พบไฟล์ .env")
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("LINE_CHANNEL_ACCESS_TOKEN="):
            token = line.split("=", 1)[1].strip().strip('"').strip("'")
            if token and not token.startswith("your_"):
                return token
    sys.exit("ไม่พบค่า LINE_CHANNEL_ACCESS_TOKEN ในไฟล์ .env")


def find_thai_font(size: int):
    """
    หาฟอนต์ที่แสดงภาษาไทยได้

    เรียงตามลำดับความสวยงามบนวินโดวส์
    ถ้าหาไม่เจอจะใช้ฟอนต์เริ่มต้นซึ่งแสดงภาษาไทยไม่ได้ และจะเตือนผู้ใช้
    """
    candidates = [
        "C:/Windows/Fonts/LeelaUIb.ttf",     # Leelawadee UI Bold
        "C:/Windows/Fonts/LeelawUI.ttf",     # Leelawadee UI
        "C:/Windows/Fonts/tahomabd.ttf",     # Tahoma Bold
        "C:/Windows/Fonts/tahoma.ttf",
        "C:/Windows/Fonts/upcdb.TTF",
        "/usr/share/fonts/truetype/tlwg/Garuda-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSansThai-Bold.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return None


def draw_image() -> Path:
    """วาดรูป Rich Menu 6 ปุ่ม"""
    img = Image.new("RGB", (W, H), (0xFA, 0xFA, 0xF8))
    d = ImageDraw.Draw(img)

    f_title = find_thai_font(88)
    f_sub = find_thai_font(46)
    if f_title is None:
        print("  คำเตือน: ไม่พบฟอนต์ภาษาไทย รูปที่ได้จะแสดงตัวอักษรไม่ถูกต้อง")
        f_title = ImageFont.load_default()
        f_sub = ImageFont.load_default()

    for i, btn in enumerate(BUTTONS):
        col, row = i % COLS, i // COLS
        x0, y0 = col * CW, row * CH
        x1, y1 = x0 + CW, y0 + CH

        # พื้นหลังแต่ละช่องใช้สีอ่อนของสีประจำปุ่ม เพื่อให้ตัวอักษรสีเข้มอ่านง่าย
        r, g, b = btn["color"]
        light = (int(r + (255 - r) * 0.88), int(g + (255 - g) * 0.88), int(b + (255 - b) * 0.88))
        d.rectangle([x0 + 12, y0 + 12, x1 - 12, y1 - 12], fill=light)

        # แถบสีเข้มด้านบนของช่อง ใช้แยกปุ่มออกจากกันโดยไม่ต้องใช้เส้นขอบหนา
        d.rectangle([x0 + 12, y0 + 12, x1 - 12, y0 + 28], fill=btn["color"])

        cx = x0 + CW // 2
        # ข้อความหลักใช้สีเข้มของตระกูลสีเดียวกัน ไม่ใช้สีดำ เพื่อให้กลมกลืน
        dark = (int(r * 0.55), int(g * 0.55), int(b * 0.55))
        mid = (int(r * 0.72), int(g * 0.72), int(b * 0.72))

        # ไอคอนอยู่บน ข้อความอยู่ล่าง เป็นลำดับการอ่านที่คนคุ้นเคยที่สุด
        ICONS[btn["icon"]](d, cx, y0 + CH * 0.34, ICON_R, dark, ICON_W)

        tw = d.textlength(btn["title"], font=f_title)
        d.text((cx - tw / 2, y0 + CH * 0.58), btn["title"], font=f_title, fill=dark)

        sw = d.textlength(btn["subtitle"], font=f_sub)
        d.text((cx - sw / 2, y0 + CH * 0.76), btn["subtitle"], font=f_sub, fill=mid)

    img.save(IMG_PATH, "PNG", optimize=True)
    size_kb = IMG_PATH.stat().st_size / 1024
    print(f"  วาดรูปเสร็จ: {IMG_PATH}  ({size_kb:.0f} KB)")
    if size_kb > 1024:
        print("  คำเตือน: LINE จำกัดขนาดรูปไว้ที่ 1 MB")
    return IMG_PATH


def resolve_image() -> Path:
    """
    เลือกว่าจะอัปโหลดรูปไหนขึ้น LINE

    ลำดับความสำคัญ
      1. rich-menu-custom.png  รูปที่ออกแบบเอง ถ้ามีให้ใช้อันนี้
      2. rich-menu.png         รูปที่สคริปต์วาดเอง ใช้เมื่อยังไม่มีรูปออกแบบ

    ตรวจขนาดก่อนเสมอ เพราะ LINE ปฏิเสธรูปที่ขนาดไม่ตรงกับที่ประกาศไว้ใน
    ฟิลด์ size ของ Rich Menu และข้อความผิดพลาดที่ได้กลับมาอ่านเข้าใจยาก
    การตรวจตรงนี้ทำให้รู้สาเหตุทันทีตั้งแต่ก่อนส่ง
    """
    if CUSTOM_IMG_PATH.exists():
        with Image.open(CUSTOM_IMG_PATH) as im:
            w, h = im.size
        if (w, h) != (W, H):
            sys.exit(
                f"รูปที่ออกแบบเองขนาดไม่ถูกต้อง\n"
                f"  ไฟล์: {CUSTOM_IMG_PATH}\n"
                f"  ขนาดที่พบ: {w} x {h}\n"
                f"  ขนาดที่ LINE ต้องการ: {W} x {H}\n"
                f"  วิธีแก้: ส่งออกจากโปรแกรมออกแบบใหม่ให้ได้ {W} x {H} พิกเซล"
            )
        size_kb = CUSTOM_IMG_PATH.stat().st_size / 1024
        if size_kb > 1024:
            sys.exit(f"รูปใหญ่เกินไป {size_kb:.0f} KB LINE จำกัดไว้ที่ 1 MB")
        print(f"  ใช้รูปที่ออกแบบเอง: {CUSTOM_IMG_PATH.name}  ({size_kb:.0f} KB)")
        return CUSTOM_IMG_PATH

    print("  ไม่พบรูปที่ออกแบบเอง จึงวาดรูปสำรองจากโค้ดแทน")
    print(f"  ถ้าต้องการใช้รูปของตัวเอง ให้วางไว้ที่ {CUSTOM_IMG_PATH}")
    return draw_image()


def build_menu_object() -> dict:
    """สร้างโครงสร้าง Rich Menu ตามรูปแบบที่ LINE กำหนด"""
    areas = []
    for i, btn in enumerate(BUTTONS):
        col, row = i % COLS, i // COLS
        areas.append(
            {
                "bounds": {"x": col * CW, "y": row * CH, "width": CW, "height": CH},
                # ใช้ action แบบ message เพื่อให้ข้อความถูกส่งเข้า webhook เหมือนผู้ใช้พิมพ์เอง
                # ระบบจะบันทึกลงตาราง conversations และนำไปวิเคราะห์ได้เหมือนคำถามปกติ
                "action": {"type": "message", "text": btn["text"]},
            }
        )
    return {
        "size": {"width": W, "height": H},
        "selected": True,
        "name": "คุณภาษี - เมนูหลัก",
        "chatBarText": "เมนูช่วยเหลือ",
        "areas": areas,
    }


def api(method: str, path: str, token: str, **kw):
    url = "https://api.line.me" + path
    headers = kw.pop("headers", {})
    headers["Authorization"] = f"Bearer {token}"
    r = requests.request(method, url, headers=headers, timeout=60, **kw)
    if not r.ok:
        sys.exit(f"เรียก LINE API ไม่สำเร็จ {r.status_code}\n{r.text}")
    return r


def main():
    args = sys.argv[1:]
    print("=" * 70)
    print("  ติดตั้ง Rich Menu ให้ LINE OA ระบบที่ปรึกษาภาษี")
    print("=" * 70)

    if "--image-only" in args:
        draw_image()
        print("\n  โหมดวาดรูปอย่างเดียว ไม่ได้ติดต่อ LINE")
        print(f"  เปิดดูรูปได้ที่ {IMG_PATH}")
        return

    img_path = resolve_image()
    token = load_token()

    if "--list" in args:
        data = api("GET", "/v2/bot/richmenu/list", token).json()
        menus = data.get("richmenus", [])
        print(f"\n  มีเมนูอยู่ {len(menus)} รายการ")
        for m in menus:
            print(f"    {m['richMenuId']}  {m.get('name')}")
        return

    if "--clean" in args:
        data = api("GET", "/v2/bot/richmenu/list", token).json()
        for m in data.get("richmenus", []):
            api("DELETE", f"/v2/bot/richmenu/{m['richMenuId']}", token)
            print(f"  ลบเมนูเดิม {m['richMenuId']}")

    print("\n  สร้างเมนูใหม่")
    menu = build_menu_object()
    res = api(
        "POST",
        "/v2/bot/richmenu",
        token,
        headers={"Content-Type": "application/json"},
        data=json.dumps(menu, ensure_ascii=False).encode("utf-8"),
    ).json()
    menu_id = res["richMenuId"]
    print(f"    รหัสเมนู {menu_id}")

    print(f"  อัปโหลดรูป {img_path.name}")
    with open(img_path, "rb") as f:
        requests.post(
            f"https://api-data.line.me/v2/bot/richmenu/{menu_id}/content",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "image/png"},
            data=f.read(),
            timeout=120,
        ).raise_for_status()

    print("  ตั้งเป็นเมนูเริ่มต้นของผู้ใช้ทุกคน")
    api("POST", f"/v2/bot/user/all/richmenu/{menu_id}", token)

    print("\n  ติดตั้งสำเร็จ")
    print("  เปิดแชท LINE ของบอทแล้วดูแถบเมนูด้านล่าง")
    print("  ถ้ายังไม่ขึ้น ให้ปิดหน้าแชทแล้วเปิดใหม่ หรือรอสักครู่")


if __name__ == "__main__":
    main()
