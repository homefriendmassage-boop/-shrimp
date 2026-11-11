async function runShopLoginCheck() {
  const panel = document.getElementById('shop-login-check');
  const status = document.getElementById('shop-login-check-status');
  document.getElementById('player-main').hidden = true;
  panel.hidden = false;
  document.title = 'ทดสอบ LINE Login · บ่อทดสอบ2';
  try {
    await liff.init({ liffId: '2009043114-jTsiIhMR' });
    if (!liff.isLoggedIn()) {
      const redirect = new URL(location.pathname, location.origin);
      redirect.searchParams.set('shop', 'SHOP_001');
      redirect.searchParams.set('shop_login_check', '1');
      liff.login({ redirectUri: redirect.href });
      return;
    }
    const token = liff.getIDToken();
    if (!token) {
      status.textContent = 'LIFF นี้ยังอ่าน ID token ไม่ได้ กรุณาตรวจ Scope openid';
      return;
    }
    const response = await fetch(APP_CONFIG.SUPABASE_URL + '/functions/v1/shop-login-check', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, apikey: APP_CONFIG.SUPABASE_ANON_KEY },
      signal: AbortSignal.timeout(12000)
    });
    const result = await response.json();
    if (result.ok && result.member_code) {
      status.textContent = 'ยืนยันสำเร็จ · พบบัญชีสมาชิกเดิม ' + result.member_code;
      return;
    }
    const messages = {
      LINE_AUTH_INVALID: 'LINE Login ของร้านยืนยันบัญชีไม่สำเร็จ กรุณาเปิดลิงก์นี้ใน LINE อีกครั้ง',
      ACCOUNT_NOT_LINKED: 'ยังจับคู่ LINE บัญชีนี้กับสมาชิกเดิมของบ่อทดสอบ2 ไม่ได้',
      MEMBER_NOT_ACTIVE: 'พบการเชื่อมบัญชี แต่สมาชิกเดิมยังไม่อยู่ในสถานะใช้งาน',
    };
    status.textContent = messages[result.code] || 'ตรวจสอบไม่สำเร็จ กรุณาลองใหม่';
  } catch {
    status.textContent = 'เปิดการทดสอบไม่ได้ กรุณาเปิดลิงก์นี้ใน LINE อีกครั้ง';
  }
}
