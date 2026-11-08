# เปิดใช้ Thunder ตรวจสลิปกับ Supabase เดิม (ไม่มี Project ใหม่)

## สิ่งที่พร้อมใน GitHub
- `supabase/functions/verify-slip/index.ts`: ตรวจ LINE ID token ฝั่งเซิร์ฟเวอร์; เก็บภาพใน Private Storage; เรียก Thunder v2 และบันทึกผล
- `staging/slip-verify.html?shop=YOUR_SHOP_ID`: หน้าอัปโหลดภาพและแสดงผล
- `staging/slip-admin.html?shop=YOUR_SHOP_ID`: หน้า Admin ดูผลตรวจและภาพผ่าน signed URL
- `staging/sql/001_slip_verifications.sql`: ตารางเพิ่มใหม่ ไม่มีการแก้ตารางเดิม
- `staging/slip-preview.html`: offline preview เท่านั้น

> **ยังไม่เปิดใช้งาน** ไม่มี Supabase connector หรือสิทธิ์ deploy Supabase ในเซสชันนี้ จึงยังไม่ได้รัน SQL / สร้าง bucket / ตั้ง Secrets / Deploy Edge Function ให้จริง และยังไม่ได้ทดสอบด้วย API Key

## ลงมือบน Supabase Project เดิม (ต้องมีผู้ดูแลดำเนินการ)

1. สำรอง Schema และข้อมูลสำคัญก่อน
2. เปิด Supabase SQL Editor แล้วตรวจไฟล์ `staging/sql/001_slip_verifications.sql` อย่างละเอียด จากนั้นรัน **เฉพาะ SQL เพิ่มตารางใหม่** หลังอนุมัติ
3. เปิด Storage > New bucket: `slips-private` และ **ปิด Public bucket**
4. เปิด Edge Functions > Secrets ใส่ค่า:
   - `THUNDER_API_KEY`: ใช้ Key ของ Thunder; ห้ามใส่ใน GitHub หรือ Frontend
   - `LINE_CHANNEL_ID_PLAYER`: LINE Login channel ID ของ LIFF ผู้เล่น (ไม่ใช่ LIFF ID)
   - `LINE_CHANNEL_ID_ADMIN`: LINE Login channel ID ของ LIFF Admin (ไม่ใช่ LIFF ID)
   - `WEB_ORIGIN`: เว็บที่ใช้เปิดหน้า Web App เช่น `https://YOUR-USERNAME.github.io` (ไม่มี slash ปิดท้าย)
   - Supabase มี `SUPABASE_URL` และ `SUPABASE_SERVICE_ROLE_KEY` จาก environment ของโปรเจกต์ (ตรวจให้ครบก่อน Deploy)
5. ลง Edge Function ชื่อ `verify-slip` จากโค้ด `supabase/functions/verify-slip/index.ts`; ปิดการตรวจ **Supabase JWT** สำหรับฟังก์ชันนี้ เพราะใช้ LINE ID token โดยตรวจ token กับ LINE โดยตรงในฟังก์ชัน (เลือก `verify_jwt=false`). จะต้องบังคับ validation LINE token จริงเสมอ
6. ลงทะเบียนบัญชีผู้รับที่ต้องการตรวจสอบใน Thunder เพื่อให้ `matchAccount=true` ใช้งานได้จริง มิฉะนั้นรายการจะถูกส่ง `ReviewRequired`
7. เปิดไฟล์ `staging/slip-verify.html?shop=...` ผ่าน URL HTTPS ใน LIFF ที่กำหนดให้ตรง channel; หน้า Admin ใช้ LIFF Admin และ `staging/slip-admin.html?shop=...`. แก้ LIFF endpoint / redirect URLs ให้รองรับหน้าดังกล่าวก่อนเปิดทดสอบ
8. ตรวจ Supabase `users` ว่ามี record ของผู้ทดสอบและผู้ดูแลตรง `uid`, `shop_id`, `role`, `status=Active` แล้ว โดย **ห้าม** ปิด RLS เดิมเพื่ออำนวยความสะดวก
9. ทดสอบรูปจริงเฉพาะบัญชีทดสอบ ยอดถูก-ผิด บัญชีผิด สลิปซ้ำ timeout และ role ไม่ถูกต้อง

## ข้อควรตรวจเพิ่มเติมก่อนใช้จริง
- คำขอชื่อ shop/amount จากหน้าเว็บอาจถูกเปลี่ยนโดยผู้ใช้; สำหรับการจับคู่ยอด *คำสั่งซื้อ* ต้องใช้จำนวนเงินที่อ่านจากแหล่งข้อมูลเชื่อถือได้ฝั่งเซิร์ฟเวอร์ ไม่ใช่ตัวเลขที่ผู้ใช้พิมพ์เอง
- Code ปัจจุบันเป็นการตรวจภาพเอกสารและบันทึกผลตรวจเท่านั้น **ไม่ใช่การตรวจยอดเงินเข้าบัญชีจริง** ไม่อนุมัติคำขอฝากถอน และไม่เพิ่ม/ลดเครดิต
- `slip_verifications` มี RLS เปิดและไม่มี Client Policy ซึ่งตั้งใจไว้ ให้ server Edge Function ทำงานเท่านั้น
- การอัปโหลดแบบซ้ำจะถูกกันด้วย transaction_ref unique constraint แต่การ retry อาจใช้ Thunder quota; ควรเพิ่ม rate limits และ request-level idempotency ก่อนเปิดสาธารณะ
- ทบทวน CORS allowlist และอัปเดต `WEB_ORIGIN` ให้ตรงกับ HTTPS origin ที่โฮสต์จริง
- `config.js` เป็น Publishable Key เท่านั้น; ห้ามเพิ่ม service-role / Thunder Key ลงไฟล์นี้
- ไม่มี CI/integration tests ใน Repo จึงยังไม่ถือว่า production-ready

## การย้อนกลับ
ไม่ Merge หากยังไม่ผ่านทดสอบ; ไม่มีการแก้ตารางเดิม. ถ้าต้องถอดฟังก์ชันออก ให้ disable/delete Edge Function และหยุดเว็บหน้าทดลอง; อย่าลบตาราง log โดยไม่สำรองข้อมูลก่อน.
