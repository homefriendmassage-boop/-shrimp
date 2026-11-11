function mountShopOaLink(container, shopId) {
  if (!container || container.dataset.shop === shopId) return;
  container.dataset.shop = shopId;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'เปิดรับแจ้งเตือน LINE';
  button.style.cssText = 'box-sizing:border-box;max-width:100%;min-height:40px;padding:8px 14px;border:1px solid #657084;border-radius:8px;background:transparent;color:inherit;font:inherit;white-space:normal;cursor:pointer';
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText = 'font-size:.875rem;color:#aebbcf;margin-top:4px';
  container.replaceChildren(button, status);

  const pendingKey = 'shop-oa-link:' + shopId;
  let waitingUntil = 0;
  let chatUrl;
  let checking = false;
  let retryTimer;
  try { waitingUntil = Number(sessionStorage.getItem(pendingKey)) || 0; } catch {}

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

  function hidePrompt(linked) {
    container.hidden = true;
    clearTimeout(retryTimer);
    window.removeEventListener('focus', checkOnReturn);
    document.removeEventListener('visibilitychange', checkOnReturn);
    if (linked && waitingUntil) {
      try { sessionStorage.removeItem(pendingKey); } catch {}
      request('status', 'member-approval').catch(() => {});
    }
  }

  async function refresh(retries = 0) {
    if (checking || container.dataset.shop !== shopId) return;
    checking = true;
    try {
      const result = await request('oa_link_status');
      if (container.dataset.shop !== shopId) return;
      if (!result.available || result.linked) return hidePrompt(result.linked);
      container.hidden = false;
      if (Date.now() < waitingUntil) {
        status.textContent = 'กดส่งข้อความที่เตรียมไว้ในแชตร้าน ระบบจะตรวจให้อัตโนมัติ';
        if (retries > 0 && !document.hidden) {
          retryTimer = setTimeout(() => refresh(retries - 1), 1800);
        }
      } else {
        status.textContent = '';
        button.textContent = 'เปิดรับแจ้งเตือน LINE';
      }
    } catch {
      if (!container.hidden) status.textContent = 'ตรวจสถานะแจ้งเตือนไม่สำเร็จ กรุณาลองอีกครั้ง';
    } finally {
      checking = false;
    }
  }

  function checkOnReturn() {
    if (waitingUntil && !document.hidden) {
      clearTimeout(retryTimer);
      refresh(3);
    }
  }

  button.onclick = async () => {
    button.disabled = true;
    try {
      if (!chatUrl || Date.now() >= waitingUntil) {
        const result = await request('oa_link_start');
        if (container.dataset.shop !== shopId) return;
        if (result.linked) return hidePrompt(true);
        const url = new URL(result.chat_url);
        if (url.origin !== 'https://line.me' || !url.pathname.startsWith('/R/oaMessage/')) {
          throw new Error('OA_CHAT_URL_INVALID');
        }
        chatUrl = url.href;
        waitingUntil = Date.now() + 10 * 60 * 1000;
        try { sessionStorage.setItem(pendingKey, String(waitingUntil)); } catch {}
      }
      button.textContent = 'เปิดแชตร้าน';
      status.textContent = 'กดส่งข้อความที่เตรียมไว้ในแชตร้าน ระบบจะตรวจให้อัตโนมัติ';
      try {
        liff.openWindow({ url: chatUrl, external: false });
      } catch {
        window.location.assign(chatUrl);
      }
      clearTimeout(retryTimer);
      retryTimer = setTimeout(checkOnReturn, 1800);
    } catch {
      status.textContent = 'เปิดแชตร้านไม่สำเร็จ กรุณาลองอีกครั้ง';
    } finally {
      button.disabled = false;
    }
  };

  window.addEventListener('focus', checkOnReturn);
  document.addEventListener('visibilitychange', checkOnReturn);
  refresh(waitingUntil ? 3 : 0);
}
