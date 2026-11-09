function applyMembershipRetryWindow(button, retryAt) {
  clearTimeout(button.membershipRetryTimer);
  const remaining = Date.parse(retryAt || '') - Date.now();
  button.disabled = remaining > 0;
  button.style.opacity = button.disabled ? '.45' : '';
  if (!button.disabled) {
    button.textContent = 'ส่งเตือนแอดมินอีกครั้ง';
    return;
  }
  button.textContent = 'ส่งซ้ำได้ใน ' + Math.ceil(remaining / 60000) + ' นาที';
  button.membershipRetryTimer = setTimeout(() => applyMembershipRetryWindow(button, retryAt), Math.min(remaining, 15000));
}
function membershipRetryFeedback(result) {
  if (result.application?.state !== 'Pending') return 'ใบสมัครไม่ได้อยู่ในสถานะรออนุมัติแล้ว';
  if (result.delivery === 'accepted') return 'LINE API รับคำขอส่งแจ้งเตือนแล้ว';
  if (result.delivery === 'waiting') return 'ยังส่งซ้ำไม่ได้ กรุณารอให้ครบเวลา';
  const code = result.delivery_code;
  const labels = {
    MEMBERSHIP_OWNER_UIDS_INVALID: 'รูปแบบ Secret ของผู้รับไม่ถูกต้อง',
    MEMBERSHIP_OWNER_UID_MISSING: 'ยังไม่ได้กำหนด LINE เจ้าของสำหรับร้านนี้',
    SHOP_OA_TOKEN_MISSING: 'ยังไม่ได้กำหนด Token ของ LINE OA ร้านนี้',
    LINE_PUSH_HTTP_401: 'LINE ปฏิเสธ Token ของ OA',
    LINE_PUSH_HTTP_400: 'LINE ปฏิเสธข้อมูลข้อความหรือผู้รับ',
    LINE_PUSH_HTTP_429: 'LINE จำกัดจำนวนข้อความที่ส่ง'
  };
  return 'ส่งแจ้งเตือนไม่สำเร็จ' + (code ? ' · ' + (labels[code] || code) + ' [' + code + ']' : ' กรุณาติดต่อผู้ดูแลร้าน');
}
