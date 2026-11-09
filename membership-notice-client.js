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
  return 'ส่งแจ้งเตือนไม่สำเร็จ กรุณาติดต่อผู้ดูแลร้าน';
}
