# ติดตั้ง Admin API

ชุดนี้แก้การเข้าถึงข้อมูลที่ถูก RLS กั้น โดยรักษาเมนูและขั้นตอนเดิมใน admin.html และไม่แก้ member-approval, config.js หรือ Policy ของฐานข้อมูล

## 1. ติดตั้งเซิร์ฟเวอร์ก่อนเปิดใช้หน้าเว็บใหม่

ใน Supabase โปรเจกต์ shrimp-saas เปิด Edge Functions → Deploy a new function → Via Editor (ชื่อเมนูอาจต่างตามหน้าจอ)

ตั้งชื่อฟังก์ชัน `admin-api` และวางเนื้อหาทั้งไฟล์ `supabase/functions/admin-api/index.ts` แทนโค้ดตัวอย่าง จากนั้น Deploy

ตั้ง Verify JWT เป็น OFF สำหรับ admin-api: ฟังก์ชันนี้ตรวจ LINE ID Token กับ LINE ทุกคำขอเอง ไม่ใช้ Supabase JWT

ใช้ Secrets เดียวกับ member-approval ซึ่งเป็นระดับโปรเจกต์:

- LINE_CHANNEL_ID_ADMIN: Channel ID ของ LINE Login ที่มี LIFF Admin ไม่ใช่ LIFF ID เต็ม
- WEB_ORIGIN: https://homefriendmassage-boop.github.io (ไม่มี /-shrimp ต่อท้าย)
- SUPABASE_URL และ SUPABASE_SECRET_KEYS หรือ SUPABASE_SERVICE_ROLE_KEY: ค่าฝั่งเซิร์ฟเวอร์ของโปรเจกต์ปัจจุบัน

ห้ามใส่ server key ใน config.js หรือไฟล์หน้าเว็บ

## 2. เปิดใช้ไฟล์หน้าเว็บ

นำ admin.html และ admin-api-client.js จาก branch นี้เข้าสู่ main พร้อมกัน หลังติดตั้งฟังก์ชันแล้ว

Endpoint LIFF ใช้ URL เดิม ไม่ต้องเปลี่ยน:
https://homefriendmassage-boop.github.io/-shrimp/admin.html

เปิด https://liff.line.me/2012454809-41EMnP1K?shop=SHOP_001

## 3. ตรวจในร้านทดสอบก่อนใช้ยอดเงินจริง

- บัญชี users ของร้าน SHOP_001 ต้องมี role Admin หรือ Superadmin และ status Active
- ร้าน shops ต้องมี status active
- ยืนยันเมนูควบคุมบ่อ / รอดำเนินการ / รายงาน และรายการโต๊ะปรากฏ
- ยืนยันแผงอนุมัติสมาชิกยังใช้งานได้
- บัญชีที่มีเพียง membership_admins ต้องไม่ได้สิทธิ์ Admin เดิม
- ทดสอบเพิ่ม/ลบโต๊ะทดสอบ และอ่านกลับหลังรีเฟรช
- ทดสอบฝาก/ถอน/ยกเลิกบิล/ตัดผลด้วยข้อมูลทดสอบ และเทียบยอดกับฐานข้อมูลทุกขั้นตอน

## ขอบเขตและข้อจำกัด

ยังไม่ได้ทดสอบกับ LINE Token หรือ Supabase จริงจนกว่าจะ Deploy ฟังก์ชัน ไม่ได้ย้ายข้อมูลสมาชิก/ยอดเงินเดิมจากฐานเก่า

ตรรกะฝากถอนและตัดผลเดิมยังเป็นหลายคำสั่งแยกกัน ไม่ใช่ธุรกรรมเดียว การแก้นี้ไม่ได้รับประกันความถูกต้องเมื่อมีการแก้ยอดพร้อมกันหรือคำสั่งล้มเหลวระหว่างทาง ต้องทดสอบและปรับเป็นธุรกรรมฝั่งเซิร์ฟเวอร์ก่อนใช้เงินจริงพร้อมกันหลายเครื่อง

Read API จำกัดสูงสุด 1,000 แถวต่อคำขอ (สอดคล้องข้อจำกัดปกติของ Supabase) รายงานที่มีข้อมูลเกินนี้ต้องเพิ่ม pagination

หน้าอื่น เช่น index.html, backer.html, promoter.html, dashboard.html ยังไม่ได้ย้ายมาใช้ API นี้ จึงยังอาจถูก RLS กั้นตามเดิม

## ย้อนกลับ

คงไฟล์ admin.html ของ main เดิมไว้จนทดสอบผ่าน หากจำเป็นให้ revert commit หน้าเว็บ ฟังก์ชันแยกนี้ไม่เปลี่ยนตารางหรือ Policy และ member-approval ยังคงเดิม
