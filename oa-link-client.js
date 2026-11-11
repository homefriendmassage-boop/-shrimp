function mountShopOaLink(container, shopId) {
  if (!container || container.dataset.shop === shopId) return;
  container.dataset.shop = shopId;

  const start = document.createElement('button');
  start.type = 'button';
  start.textContent = 'ผูกรับแจ้งเตือน LINE ของร้าน';
  const open = document.createElement('a');
  open.textContent = 'เปิดแชต OA ของร้าน';
  open.hidden = true;
  const check = document.createElement('button');
  check.type = 'button';
  check.textContent = 'ตรวจสอบการผูกบัญชี';
  check.hidden = true;
  for (const control of [start, open, check]) {
    control.style.cssText = 'font:inherit;color:inherit;background:transparent;border:1px solid #657084;border-radius:8px;padding:8px 12px;margin:4px 6px 4px 0';
  }
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  container.replaceChildren(start, open, check, status);

  async function request(action, endpoint = 'round-notice') {
    const response = await fetch(APP_CONFIG.SUPABASE_URL + '/functions/v1/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: APP_CONFIG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + liff.getIDToken() },
      body: JSON.stringify({ action, shop_id: shopId })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.code || 'OA_LINK_UNAVAILABLE');
    return result;
  }

  function showLinked() {
    container.hidden = false;
    start.hidden = open.hidden = check.hidden = true;
    open.removeAttribute('href');
    status.textContent = 'ผูกรับแจ้งเตือน LINE ของร้านแล้ว';
  }

  async function refresh(manual = false) {
    check.disabled = true;
    try {
      const result = await request('oa_link_status');
      if (container.dataset.shop !== shopId) return;
      if (!result.available) {
        container.hidden = true;
        return;
      }
      container.hidden = false;
      if (result.linked) {
        showLinked();
        if (manual) request('status', 'member-approval').catch(() => {});
      } else if (manual) {
        status.textContent = 'ยังไม่ได้รับข้อความผูกบัญชี กรุณากดส่งข้อความในแชต OA แล้วตรวจสอบอีกครั้ง';
      }
    } catch {
      if (manual) status.textContent = 'ตรวจสอบการผูกบัญชีไม่สำเร็จ กรุณาลองอีกครั้ง';
    } finally {
      check.disabled = false;
    }
  }

  start.onclick = async () => {
    start.disabled = true;
    try {
      const result = await request('oa_link_start');
      if (container.dataset.shop !== shopId) return;
      if (result.linked) return showLinked();
      if (!result.available || !result.chat_url) throw new Error('OA_LINK_UNAVAILABLE');
      open.href = result.chat_url;
      open.hidden = check.hidden = false;
      status.textContent = 'เปิดแชต OA ของร้าน เพิ่มเพื่อนหากจำเป็น แล้วกดส่งข้อความที่เตรียมไว้ภายใน 10 นาที';
    } catch {
      status.textContent = 'เปิดแชต OA ไม่สำเร็จ กรุณาลองอีกครั้งหรือติดต่อร้าน';
    } finally {
      start.disabled = false;
    }
  };
  check.onclick = () => refresh(true);
  refresh();
}
