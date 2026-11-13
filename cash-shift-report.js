const cashShiftLabels = {
  opening_cash: 'เงินสดตั้งต้น', cash_received: 'รับเงินสด', cash_paid: 'จ่ายเงินสด',
  transfer_received: 'รับทางโอน', transfer_paid: 'จ่ายทางโอน', bank_withdrawal: 'เบิกจากธนาคารเข้าลิ้นชัก',
  bank_deposit: 'นำเงินสดฝากธนาคาร', counted_cash: 'เงินสดนับจริง',
};
const cashShiftForm = document.getElementById('cashShiftForm');
const cashShiftPanel = document.getElementById('cashShiftPanel');
const walletPanel = document.getElementById('walletReconciliationPanel');
const shiftStatus = cashShiftPanel.querySelector('[data-shift-status]');
const walletSummary = walletPanel.querySelector('[data-wallet-summary]');
const walletMovements = walletPanel.querySelector('[data-wallet-movements]');
const walletPages = walletPanel.querySelector('[data-wallet-pages]');
const shiftDate = document.getElementById('repDateSelector');
const baht = value => new Intl.NumberFormat('th-TH', {
  style: 'currency', currency: 'THB',
}).format(value);
const bangkokTime = value => new Date(value).toLocaleString('th-TH', {
  timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'medium',
});
let cashShiftDraft;
let cashShiftPage = 0;
let cashShiftRequest = 0;

function shiftElement(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function cashShiftAmount(name, label, value) {
  const wrapper = shiftElement('label', label);
  const input = shiftElement('input');
  Object.assign(input, { name, className: 'form-control', type: 'text', inputMode: 'decimal',
    required: true, value, pattern: '[0-9]{1,10}(\\.[0-9]{1,2})?' });
  wrapper.append(input);
  return wrapper;
}

for (const [key, label] of Object.entries(cashShiftLabels)) {
  cashShiftForm.querySelector('[data-shift-amounts]').append(
    cashShiftAmount(key, label, ['opening_cash', 'counted_cash'].includes(key) ? '' : '0')
  );
}

cashShiftForm.querySelector('[data-add-expense]').onclick = () => {
  const list = cashShiftForm.querySelector('[data-shift-expenses]');
  if (list.children.length >= 30) return;
  const row = shiftElement('fieldset');
  row.style.cssText = 'display:grid;gap:8px;border:1px solid var(--card-border);border-radius:8px';
  row.append(shiftElement('legend', 'รายการค่าใช้จ่าย'));
  for (const [name, title, maxLength] of [
    ['description', 'รายละเอียด', 120], ['evidence', 'เลขที่ใบเสร็จหรือ URL หลักฐาน', 500],
  ]) {
    const label = shiftElement('label', title);
    const input = shiftElement('input');
    Object.assign(input, { name, maxLength, className: 'form-control', required: true });
    label.append(input);
    row.append(label);
  }
  const channel = shiftElement('select');
  channel.name = 'channel';
  channel.className = 'form-control';
  channel.setAttribute('aria-label', 'ช่องทางจ่ายค่าใช้จ่าย');
  channel.add(new Option('จ่ายเงินสด', 'cash'));
  channel.add(new Option('จ่ายทางโอน', 'transfer'));
  const remove = shiftElement('button', 'ลบรายการ');
  Object.assign(remove, { type: 'button', className: 'btn btn-outline' });
  remove.onclick = () => { row.remove(); previewCashShift(); };
  row.append(channel, cashShiftAmount('amount', 'จำนวนเงิน', ''), remove);
  list.append(row);
  row.elements.description.focus();
};

function readCashShift() {
  return {
    ...Object.fromEntries(Object.keys(cashShiftLabels).map(key => [key, cashShiftForm.elements[key].value])),
    shift_name: cashShiftForm.elements.shift_name.value,
    note: cashShiftForm.elements.note.value,
    expenses: Array.from(cashShiftForm.querySelectorAll('fieldset'), row =>
      Object.fromEntries(['description', 'evidence', 'amount', 'channel'].map(key => [key, row.elements[key].value]))),
  };
}

function previewCashShift() {
  const input = readCashShift();
  const cents = value => Math.round(Number(value) * 100);
  const expenses = input.expenses.reduce((sum, item) => sum + (item.channel === 'cash' ? cents(item.amount) : 0), 0);
  const expected = (cents(input.opening_cash) + cents(input.cash_received) - cents(input.cash_paid)
    + cents(input.bank_withdrawal) - cents(input.bank_deposit) - expenses) / 100;
  const difference = (cents(input.counted_cash) - cents(expected)) / 100;
  cashShiftForm.querySelector('[data-shift-preview]').textContent = !input.opening_cash || !input.counted_cash || !Number.isFinite(difference)
    ? '' : 'เงินสดตามระบบ ' + baht(expected) + ' · ผลต่าง ' + baht(difference);
}
cashShiftForm.addEventListener('input', previewCashShift);
cashShiftForm.addEventListener('change', previewCashShift);

cashShiftForm.onsubmit = async event => {
  event.preventDefault();
  const day = shiftDate.value;
  const button = cashShiftForm.querySelector('[type="submit"]');
  if (!day || button.disabled) return;
  const data = readCashShift();
  const key = currentShopId + '/' + day;
  if (cashShiftDraft?.key !== key) cashShiftDraft = { key, id: crypto.randomUUID(), data };
  button.disabled = true;
  shiftStatus.textContent = 'กำลังบันทึกใบปิดกะ…';
  try {
    await _supabase.closeCashShift(day, { ...cashShiftDraft.data, shift_id: cashShiftDraft.id });
    cashShiftDraft = null;
    cashShiftForm.reset();
    cashShiftForm.querySelector('[data-shift-expenses]').replaceChildren();
    previewCashShift();
    if (shiftDate.value === day) await loadCashShiftReport(day, 0, 'บันทึกใบปิดกะแล้ว');
  } catch (error) {
    if (['CASH_SHIFT_INVALID', 'TABLE_DATE_INVALID', 'ADMIN_REQUIRED'].includes(error.message)) cashShiftDraft = null;
    shiftStatus.textContent = ({
      CASH_SHIFT_INVALID: 'กรุณาตรวจยอดเงิน ชื่อกะ และหลักฐานค่าใช้จ่าย',
      TABLE_DATE_INVALID: 'กรุณาเลือกวันที่บัญชีปัจจุบันหรือย้อนหลัง',
      ADMIN_REQUIRED: 'คุณไม่มีสิทธิ์เข้าถึงหน้านี้ กรุณาติดต่อเจ้าของร้าน',
    })[error.message] || 'ยังยืนยันผลบันทึกไม่ได้ กดบันทึกอีกครั้งเพื่อตรวจรายการเดิม';
  } finally {
    button.disabled = false;
  }
};

function renderSavedShifts(shifts) {
  const list = cashShiftPanel.querySelector('[data-saved-shifts]');
  list.replaceChildren();
  for (const shift of shifts) {
    const item = shiftElement('details');
    item.append(shiftElement('summary', shift.shift_name + ' · ผลต่าง ' + baht(shift.cash_difference)));
    const lines = Object.entries(cashShiftLabels).map(([key, label]) => label + ' ' + baht(shift[key]));
    lines.push('ค่าใช้จ่ายเงินสด ' + baht(shift.cash_expenses), 'ค่าใช้จ่ายทางโอน ' + baht(shift.transfer_expenses),
      'เงินสดตามระบบ ' + baht(shift.expected_cash), 'บันทึกเมื่อ ' + bangkokTime(shift.closed_at));
    if (shift.note) lines.push(shift.note);
    for (const line of lines) item.append(shiftElement('div', line));
    for (const expense of shift.expenses) {
      item.append(shiftElement('div', expense.description + ' · ' + baht(expense.amount) + ' · '
        + (expense.channel === 'cash' ? 'เงินสด' : 'โอน') + ' · หลักฐาน ' + expense.evidence));
    }
    list.append(item);
  }
}

function renderWalletReconciliation(wallet, page) {
  walletSummary.replaceChildren(shiftElement('p', 'เครดิตลูกค้าคงเหลือปัจจุบัน (หนี้สินร้าน) ' + baht(wallet.current_balance)));
  walletMovements.replaceChildren();
  walletPages.hidden = true;
  if (wallet.opening === null) {
    walletSummary.append(shiftElement('p', 'ไม่มีข้อมูลกระทบยอดสำหรับวันที่เลือก'));
    return;
  }
  const opening = wallet.coverage === 'partial' ? 'ยอดเมื่อเริ่มเก็บข้อมูล ' : 'ยอดต้นวัน ';
  const closing = wallet.is_open_day ? 'ยอดถึงเวลารายงาน ' : 'ยอดปลายวัน ';
  for (const line of [
    opening + baht(wallet.opening) + ' · ' + bangkokTime(wallet.opening_at),
    'เพิ่มเครดิต ' + baht(wallet.increases), 'ลดเครดิต ' + baht(wallet.decreases),
    closing + baht(wallet.closing) + ' · ' + bangkokTime(wallet.closing_at),
  ]) walletSummary.append(shiftElement('div', line));
  if (!wallet.entries.length) return;
  const table = shiftElement('table');
  table.style.cssText = 'width:100%;margin-top:12px;text-align:left;white-space:nowrap';
  const header = table.createTHead().insertRow();
  for (const label of ['เวลา', 'สมาชิก', 'ยอดก่อน', 'เปลี่ยนแปลง', 'ยอดหลัง']) header.append(shiftElement('th', label));
  const body = table.createTBody();
  for (const entry of wallet.entries) {
    const row = body.insertRow();
    for (const value of [bangkokTime(entry.recorded_at), entry.member_id || '—', baht(entry.before_balance),
      (Number(entry.delta) > 0 ? '+' : '') + baht(entry.delta), baht(entry.after_balance)]) {
      row.insertCell().textContent = value;
    }
  }
  walletMovements.append(table);
  const lastPage = Math.ceil(wallet.movement_count / 50);
  walletPages.hidden = lastPage <= 1;
  walletPages.querySelector('[data-page]').textContent = (page + 1) + ' / ' + lastPage;
  walletPages.querySelector('[data-prev]').disabled = page === 0;
  walletPages.querySelector('[data-next]').disabled = page + 1 >= lastPage;
}
walletPages.querySelector('[data-prev]').onclick = () => loadCashShiftReport(shiftDate.value, cashShiftPage - 1);
walletPages.querySelector('[data-next]').onclick = () => loadCashShiftReport(shiftDate.value, cashShiftPage + 1);

async function loadCashShiftReport(day, page = 0, message = '') {
  const request = ++cashShiftRequest;
  shiftStatus.textContent = 'กำลังโหลดใบปิดกะ…';
  walletSummary.textContent = 'กำลังโหลดรายการ Wallet…';
  walletMovements.replaceChildren();
  walletPages.hidden = true;
  cashShiftPanel.querySelector('[data-saved-shifts]').replaceChildren();
  try {
    const { shifts, wallet } = await _supabase.cashShiftReport(day, page);
    if (request !== cashShiftRequest || shiftDate.value !== day) return;
    cashShiftPage = page;
    shiftStatus.textContent = message || (shifts.length ? '' : 'ยังไม่มีใบปิดกะสำหรับวันนี้');
    renderSavedShifts(shifts);
    renderWalletReconciliation(wallet, page);
  } catch {
    if (request !== cashShiftRequest) return;
    shiftStatus.textContent = 'โหลดใบปิดกะไม่สำเร็จ';
    walletSummary.textContent = 'โหลดรายการกระทบยอด Wallet ไม่สำเร็จ';
  }
}
