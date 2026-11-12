const planLabels = { free: 'Free', starter: 'Starter', basic: 'Basic', pro: 'Pro' };

export function filterSaasShops(entries, status, plan) {
  return entries.filter(shop => {
    const active = String(shop.status).toLowerCase() === 'active';
    const planCode = shop.current_plan || shop.requested_plan;
    return (!status || status === (active ? 'active' : 'inactive')) &&
      (!plan || plan === (Object.hasOwn(planLabels, planCode) ? planCode : 'none'));
  });
}

export async function mountSaasAdmin() {
  document.title = 'แอดมิน SaaS · บ่อกุ้ง';
  const shell = document.createElement('div');
  const view = shell.attachShadow({ mode: 'open' });
  view.innerHTML = `<style>
    :host { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #131620; color: #f8fafc; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    :host { display: flow-root; min-height: 100vh; }
    main { width: min(100% - 32px, 680px); margin: 40px auto; }
    header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
    h1 { font-size: clamp(1.5rem, 5vw, 2rem); margin: 0; }
    h2, p { margin: 0; }
    #status { color: #bec9db; margin: 16px 0; }
    #filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    label { display: grid; gap: 4px; }
    select { min-height: 44px; width: 100%; border: 1px solid #657084; border-radius: 8px; padding: 8px; background: #252e40; color: inherit; font: inherit; }
    #count { color: #bec9db; margin-top: 12px; }
    #shops { display: grid; gap: 12px; padding: 0; list-style: none; }
    li { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; padding: 16px; border-radius: 12px; border: 1px solid #343d50; background: #1d2230; }
    li h2 { font-size: 1.1rem; overflow-wrap: anywhere; }
    li p { color: #bec9db; font-size: .9rem; }
    .active { color: #89e7b4; }
    button { min-height: 44px; padding: 8px 14px; border: 1px solid #657084; border-radius: 8px; background: #252e40; color: inherit; font: inherit; cursor: pointer; }
    button[data-opening="true"] { background: #155c3c; border-color: #26875a; }
    .shop-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .shop-actions a { min-height: 44px; display: inline-flex; align-items: center; padding: 8px 14px; border: 1px solid #657084; border-radius: 8px; color: inherit; text-decoration: none; }
    button:disabled { opacity: .65; cursor: wait; }
    @media (max-width: 430px) { li { grid-template-columns: 1fr; gap: 10px; } }
  </style>
  <main>
    <header>
      <h1>แอดมิน SaaS · เปิด–ปิดร้าน</h1>
      <button id="refresh" type="button" hidden>รีเฟรชรายการ</button>
    </header>
    <p id="status" role="status">กำลังตรวจสิทธิ์แอดมินแพลตฟอร์ม…</p>
    <div id="filters" hidden>
      <label>สถานะร้าน
        <select id="shop-status">
          <option value="">ทุกสถานะ</option>
          <option value="active">เปิดบริการ</option>
          <option value="inactive">ปิดบริการ</option>
        </select>
      </label>
      <label>แพ็กเกจ
        <select id="shop-plan">
          <option value="">ทุกแพ็กเกจ</option>
          <option value="free">Free</option>
          <option value="starter">Starter</option>
          <option value="basic">Basic</option>
          <option value="pro">Pro</option>
          <option value="none">ยังไม่มีแพ็กเกจ</option>
        </select>
      </label>
    </div>
    <p id="count" role="status" hidden></p>
    <ul id="shops" aria-label="ร้านในแพลตฟอร์ม" hidden></ul>
  </main>`;
  document.body.replaceChildren(shell);

  const statusText = view.getElementById('status');
  const shops = view.getElementById('shops');
  const refresh = view.getElementById('refresh');
  const filters = view.getElementById('filters');
  const statusFilter = view.getElementById('shop-status');
  const planFilter = view.getElementById('shop-plan');
  const count = view.getElementById('count');
  let allShops = [];
  let busy = false;

  async function request(action, details = {}) {
    const token = liff.getIDToken();
    if (!token) throw new Error('LINE_AUTH_INVALID');
    const response = await fetch(APP_CONFIG.SUPABASE_URL + '/functions/v1/admin-api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: APP_CONFIG.SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ action, ...details }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.code || 'SHOP_PORTAL_UNAVAILABLE');
    return data;
  }

  function renderShops() {
    const entries = filterSaasShops(allShops, statusFilter.value, planFilter.value);
    count.textContent = entries.length
      ? `แสดง ${entries.length} จาก ${allShops.length} ร้าน`
      : allShops.length ? 'ไม่มีร้านตรงกับตัวกรอง' : 'ยังไม่มีร้านในแพลตฟอร์ม';
    shops.replaceChildren();
    for (const shop of entries) {
      const active = String(shop.status).toLowerCase() === 'active';
      const row = document.createElement('li');
      const details = document.createElement('div');
      const name = document.createElement('h2');
      name.textContent = shop.shop_name || shop.shop_id;
      const state = document.createElement('p');
      const label = document.createElement('span');
      label.textContent = active ? 'เปิดบริการ' : 'ปิดบริการ';
      label.classList.toggle('active', active);
      const planCode = shop.current_plan || shop.requested_plan;
      const planLabel = Object.hasOwn(planLabels, planCode) ? planLabels[planCode] : 'ยังไม่มีแพ็กเกจ';
      state.append(shop.shop_id + ' · ', label, ' · ' + planLabel);
      if (!shop.current_plan && ['starter', 'basic', 'pro'].includes(planCode)) state.append(' (ที่สมัคร)');
      details.append(name, state);
      const control = document.createElement('button');
      control.type = 'button';
      control.dataset.opening = String(!active);
      control.textContent = active ? 'ปิดบริการร้าน' : 'เปิดบริการร้าน';
      control.addEventListener('click', () => {
        if (busy || !confirm(control.textContent + ' ' + name.textContent + ' (' + shop.shop_id + ') ใช่ไหมครับ')) return;
        loadShops(shop, !active);
      });
      const actions = document.createElement('div');
      actions.className = 'shop-actions';
      const settings = document.createElement('a');
      settings.href = 'shop-create.html?saas_shop=' + encodeURIComponent(shop.shop_id);
      settings.textContent = 'รายละเอียดการเปิด–ปิดระบบ';
      actions.append(control, settings);
      row.append(details, actions);
      shops.append(row);
    }
    shops.hidden = false;
  }

  async function loadShops(target, enabled) {
    if (busy) return;
    busy = true;
    refresh.disabled = statusFilter.disabled = planFilter.disabled = true;
    for (const button of shops.querySelectorAll('button')) button.disabled = true;
    let resultMessage = '';
    statusText.textContent = target ? 'กำลังบันทึกสถานะของ ' + target.shop_id + '…' : 'กำลังโหลดสถานะร้าน…';
    try {
      if (target) {
        try {
          await request('platform_shop_control', {
            target_shop_id: target.shop_id, setting: 'service_enabled', enabled,
          });
          resultMessage = (enabled ? 'เปิดบริการ ' : 'ปิดบริการ ') + target.shop_id + ' แล้ว';
        } catch (error) {
          if (['PLATFORM_ADMIN_REQUIRED', 'LINE_AUTH_INVALID'].includes(error.message)) throw error;
          resultMessage = error.message === 'SHOP_OR_OA_NOT_READY'
            ? 'ร้านนี้ยังไม่พร้อมเปิดบริการ กรุณาตรวจการเชื่อมต่อ LINE OA'
            : 'ยืนยันผลการบันทึกไม่ได้ กรุณาตรวจสถานะล่าสุดก่อนทำซ้ำ';
        }
      }
      const data = await request('platform_shop_portal');
      if (data.can_invite !== true) throw new Error('PLATFORM_ADMIN_REQUIRED');
      allShops = data.platform_shops ?? [];
      renderShops();
      filters.hidden = count.hidden = false;
      statusText.textContent = resultMessage;
    } catch (error) {
      shops.replaceChildren();
      shops.hidden = filters.hidden = count.hidden = true;
      const denied = error.message === 'PLATFORM_ADMIN_REQUIRED';
      refresh.hidden = denied;
      statusText.textContent = denied ? 'บัญชี LINE นี้ไม่มีสิทธิ์แอดมินแพลตฟอร์ม'
        : error.message === 'LINE_AUTH_INVALID' ? 'กรุณาเปิดลิงก์นี้ใน LINE เพื่อเข้าสู่ระบบใหม่'
        : 'โหลดสถานะล่าสุดไม่สำเร็จ กรุณารีเฟรชรายการ';
    } finally {
      busy = false;
      refresh.disabled = statusFilter.disabled = planFilter.disabled = false;
    }
  }

  statusFilter.addEventListener('change', renderShops);
  planFilter.addEventListener('change', renderShops);
  refresh.addEventListener('click', () => loadShops());
  refresh.hidden = false;
  await loadShops();
}
