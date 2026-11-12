function createPlatformBilling(dialog, onPaid) {
  const byId = id => document.getElementById(id);
  const catalog = byId('billing-catalog');
  const catalogStatus = byId('billing-inline-status');
  const dialogCatalog = catalog.parentNode;
  const formatMoney = amount => '฿' + Number(amount).toLocaleString('th-TH');
  const formatDate = date => new Date(date).toLocaleString('th-TH', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
  });
  const messages = {
    AMOUNT_MISMATCH: 'ยอดในสลิปไม่ตรงกับยอดที่ต้องชำระ',
    BILLING_NOT_CONFIGURED: 'ยังไม่เปิดรับชำระเงิน กรุณาติดต่อผู้ดูแลแพลตฟอร์ม',
    DUPLICATE_SLIP: 'สลิปนี้ถูกใช้ชำระรายการอื่นแล้ว',
    IMAGE_INVALID: 'กรุณาเลือกรูป JPG, PNG, GIF หรือ WebP ขนาดไม่เกิน 4 MB',
    LINE_AUTH_INVALID: 'กรุณาเปิดหน้าจัดการร้านค้าใน LINE ใหม่',
    OWNER_REQUIRED: 'เฉพาะบัญชีเจ้าของร้านที่ชำระแพ็กเกจได้',
    RECEIVER_MISMATCH: 'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีแพลตฟอร์ม',
    SLIP_INVALID: 'เวลาในสลิปไม่ตรงกับรายการ กรุณาติดต่อผู้ดูแลแพลตฟอร์ม',
    SLIP_NOT_VERIFIED: 'ตรวจสลิปไม่สำเร็จ กรุณาตรวจรูปหรือส่งอีกครั้ง',
  };
  const checkout = byId('billing-checkout');
  const form = byId('billing-slip-form');
  const feedback = byId('billing-feedback');
  const close = byId('billing-close');
  let shop;
  let order;
  let busy = false;

  function working(value) {
    busy = value;
    close.disabled = value;
    document.querySelectorAll('[data-purchase], #billing-copy, #billing-submit, #billing-back')
      .forEach(button => button.disabled = value || button.dataset.unavailable === 'true');
  }

  async function request(action, details = {}) {
    const token = liff.getIDToken();
    if (!token) throw new Error('LINE_AUTH_INVALID');
    const headers = { apikey: APP_CONFIG.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
    let body;
    if (action === 'pay') {
      body = new FormData(form);
      body.set('shop_id', shop.shop_id);
      body.set('action', action);
      body.set('order_id', order.id);
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ shop_id: shop.shop_id, action, ...details });
    }
    const response = await fetch(APP_CONFIG.SUPABASE_URL + '/functions/v1/platform-billing', {
      method: 'POST', headers, body, signal: AbortSignal.timeout(35000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.code || 'BILLING_UNAVAILABLE');
    return result;
  }

  function feedbackError(error) {
    feedback.textContent = messages[error.message] || 'ยืนยันผลไม่ได้ กรุณาตรวจสถานะแล้วลองอีกครั้ง';
  }

  function productCard(product, data, preferred) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.purchase = '';
    button.dataset.unavailable = String(!data.available);
    button.disabled = !data.available;
    button.className = 'billing-product secondary';
    const title = document.createElement('strong');
    title.textContent = product.label;
    const price = document.createElement('span');
    price.textContent = formatMoney(product.amount) + (product.kind === 'plan' ? '/เดือน' : '');
    button.append(title, price);
    if (product.kind === 'slips') {
      const detail = document.createElement('small');
      detail.textContent = product.slip_credits.toLocaleString('th-TH') + ' สลิป · ฿' +
        (product.amount / product.slip_credits).toFixed(2) + '/สลิป';
      button.append(detail);
    }
    const hint = document.createElement('small');
    hint.textContent = data.orders.some(item => item.sku === product.sku && !item.paid_at) ? 'มีรายการรอชำระ'
      : product.sku === preferred ? 'แพ็กเกจที่สมัคร' : product.sku === data.current_plan ? 'แพ็กเกจปัจจุบัน' : '';
    if (hint.textContent) button.append(hint);
    button.addEventListener('click', () => start(product));
    return button;
  }

  async function load(preferred) {
    checkout.hidden = true;
    byId('billing-catalog').hidden = true;
    const data = await request('summary');
    const products = new Map(data.products.map(product => [product.sku, product]));
    const plan = products.get(data.current_plan);
    byId('billing-plan').textContent = plan
      ? plan.label + ' · ' + (Date.parse(data.paid_until) > Date.now() ? 'ใช้ได้ถึง ' : 'ครบกำหนด ') + formatDate(data.paid_until)
      : data.requested_plan === 'free' ? 'แพ็กเกจ Free' : 'เลือกแพ็กเกจรายเดือน';
    const balance = 'โควตาซื้อเพิ่มคงเหลือ ' + Number(data.slip_balance).toLocaleString('th-TH') + ' ครั้ง';
    byId('billing-balance').textContent = balance + (data.trial_slips ? ' · โควตาทดลองเหลือ ' + data.trial_slips + ' ครั้ง' : '');
    for (const kind of ['plan', 'slips']) {
      byId('billing-products-' + kind).replaceChildren(...data.products
        .filter(product => product.kind === kind)
        .map(product => productCard(product, data, preferred || data.requested_plan)));
    }
    const history = data.orders.filter(item => item.paid_at);
    byId('billing-history').replaceChildren(...history.map(item => {
      const row = document.createElement('li');
      row.textContent = (products.get(item.sku)?.label || item.sku) + ' · ' + formatMoney(item.amount) + ' · ' + formatDate(item.paid_at);
      return row;
    }));
    byId('billing-history-panel').hidden = !history.length;
    byId('billing-catalog').hidden = false;
    if (!data.available) (dialog.open ? feedback : catalogStatus).textContent = messages.BILLING_NOT_CONFIGURED;
    else if (preferred && products.has(preferred)) await start(products.get(preferred), true);
  }

  async function start(product, fromLoad = false) {
    if (busy && !fromLoad) return;
    if (!dialog.open) {
      checkout.hidden = true;
      dialog.showModal();
    }
    byId('billing-back').hidden = catalog.parentNode !== dialogCatalog;
    working(true);
    feedback.textContent = 'กำลังเตรียมรายการชำระเงิน…';
    try {
      const data = await request('create', { sku: product.sku });
      order = data.order;
      form.reset();
      const receiver = data.receiver;
      byId('billing-order').textContent = product.label + ' · ' + formatMoney(order.amount);
      byId('billing-method').textContent = receiver.method === 'promptpay'
        ? 'พร้อมเพย์' + (receiver.bank ? ' · ' + receiver.bank : '') : receiver.bank;
      byId('billing-number').value = receiver.number;
      byId('billing-name').textContent = receiver.name;
      if (catalog.parentNode === dialogCatalog) catalog.hidden = true;
      checkout.hidden = false;
      feedback.textContent = '';
    } catch (error) {
      feedbackError(error);
    } finally {
      working(false);
    }
  }

  byId('billing-copy').addEventListener('click', async () => {
    const field = byId('billing-number');
    try {
      await navigator.clipboard.writeText(field.value);
      feedback.textContent = 'คัดลอกเลขสำหรับโอนแล้ว';
    } catch {
      field.focus();
      field.select();
      feedback.textContent = 'แตะค้างที่เลขเพื่อคัดลอก';
    }
  });
  byId('billing-back').addEventListener('click', () => {
    form.reset();
    checkout.hidden = true;
    byId('billing-catalog').hidden = false;
    feedback.textContent = '';
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !order) return;
    const image = form.elements.image.files[0];
    if (!image || image.size > 4_194_304) {
      feedback.textContent = messages.IMAGE_INVALID;
      return;
    }
    working(true);
    feedback.textContent = 'กำลังตรวจยอดเงินและบัญชีผู้รับ…';
    try {
      const result = await request('pay');
      form.reset();
      checkout.hidden = true;
      feedback.textContent = result.code === 'ALREADY_PAID' ? 'รายการนี้ชำระสำเร็จแล้ว'
        : order.slip_credits ? 'ชำระสำเร็จ เพิ่มโควตาแล้ว' : 'ชำระสำเร็จ อัปเดตแพ็กเกจแล้ว';
      const refresh = await Promise.allSettled([load(), onPaid()]);
      if (refresh.some(result => result.status === 'rejected')) {
        feedback.textContent += ' · ปิดแล้วเปิดหน้าอีกครั้งเพื่อดูยอดล่าสุด';
      }
    } catch (error) {
      feedbackError(error);
    } finally {
      working(false);
    }
  });

  return {
    async showCatalog(selectedShop) {
      if (busy || dialog.open) return;
      shop = selectedShop;
      order = null;
      byId('billing-title').textContent = 'ชำระค่าบริการ · ' + (shop.shop_name || shop.shop_id);
      byId('billing-inline').append(catalog);
      catalogStatus.textContent = 'กำลังโหลดแพ็กเกจ…';
      working(true);
      try {
        catalogStatus.textContent = '';
        await load();
      } catch (error) {
        catalogStatus.textContent = messages[error.message] || 'โหลดแพ็กเกจไม่สำเร็จ กรุณาเปิดหน้าใหม่';
      } finally {
        working(false);
      }
    },
    async open(selectedShop, preferred) {
      if (busy || dialog.open) return;
      dialogCatalog.insertBefore(catalog, checkout);
      shop = selectedShop;
      order = null;
      byId('billing-title').textContent = 'แพ็กเกจและโควตาตรวจสลิป · ' + (shop.shop_name || shop.shop_id);
      checkout.hidden = byId('billing-catalog').hidden = true;
      feedback.textContent = 'กำลังโหลดแพ็กเกจ…';
      dialog.showModal();
      working(true);
      try {
        feedback.textContent = '';
        await load(preferred);
      } catch (error) {
        feedbackError(error);
      } finally {
        working(false);
      }
    },
  };
}
