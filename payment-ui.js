function promptPayPayload(identifier, amount) {
  const id = String(identifier ?? '').replace(/[ -]/g, '');
  const price = String(amount ?? '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(price) || Number(price) <= 0) return '';
  const tlv = (tag, value) => tag + String(value.length).padStart(2, '0') + value;
  let account;
  if (/^0\d{9}$/.test(id)) account = tlv('01', '0066' + id.slice(1));
  else if (/^\d{13}$/.test(id)) account = tlv('02', id);
  else if (/^\d{15}$/.test(id)) account = tlv('03', id);
  else return '';
  const data = '000201010212' + tlv('29', tlv('00', 'A000000677010111') + account)
    + '5802TH5303764' + tlv('54', Number(price).toFixed(2)) + '6304';
  let crc = 0xffff;
  for (const character of data) {
    crc ^= character.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return data + crc.toString(16).toUpperCase().padStart(4, '0');
}

function showPromptPayQr(container, identifier, amount) {
  container.replaceChildren();
  const payload = promptPayPayload(identifier, amount);
  container.hidden = !payload || typeof QRCode !== 'function';
  if (!container.hidden) new QRCode(container, { text: payload, width: 192, height: 192 });
}

function previewPaymentSlip(input, image) {
  if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
  image.removeAttribute('src');
  const file = input.files[0];
  image.hidden = !file;
  if (file) image.src = URL.createObjectURL(file);
}

async function copyPaymentNumber(input) {
  try { await navigator.clipboard.writeText(input.value); }
  catch { input.focus(); input.select(); }
}

const paymentBanks = {
  '002': 'กรุงเทพ', '004': 'กสิกรไทย', '006': 'กรุงไทย', '011': 'ทหารไทยธนชาต',
  '014': 'ไทยพาณิชย์', '017': 'ซิตี้แบงก์', '020': 'สแตนดาร์ดชาร์เตอร์ด',
  '022': 'ซีไอเอ็มบี ไทย', '024': 'ยูโอบี', '025': 'กรุงศรีอยุธยา',
  '030': 'ออมสิน', '033': 'อาคารสงเคราะห์', '034': 'ธ.ก.ส.',
  '065': 'เกียรตินาคินภัทร', '066': 'ไอซีบีซี (ไทย)', '067': 'ทิสโก้',
  '069': 'แลนด์ แอนด์ เฮ้าส์', '071': 'ไทยเครดิต',
};
function fillPaymentBanks(select) {
  if (select.options.length > 1) return;
  for (const [code, name] of Object.entries(paymentBanks)) select.add(new Option(name, code));
}
function paymentBankName(code) {
  return paymentBanks[code] || code;
}
async function shopPaymentRequest(shopId, action, details = {}) {
  const token = liff.getIDToken();
  if (!token) throw new Error('LINE_AUTH_INVALID');
  const response = await fetch(APP_CONFIG.SUPABASE_URL + '/functions/v1/shop-payments', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, apikey: APP_CONFIG.SUPABASE_ANON_KEY },
    body: JSON.stringify({ ...details, shop_id: shopId, action }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.code || 'PAYMENTS_UNAVAILABLE');
  return result;
}
