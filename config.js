const APP_CONFIG = {
  SUPABASE_URL: "https://hduyehkjiguwndnigtva.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_CHr7rRRJadvzKjBzPiBDvA_JWMs7jN9",
  LIFF_ID_PLAYER: "2012454809-UFGeUGbW", // LIFF ID ฝั่งผู้เล่นเดิมของคุณ
  LIFF_ID_ADMIN: "2012454809-41EMnP1K" // (ถ้ามี)
};

function playerEntryUrl(shopId, context = {}) {
  const url = new URL('https://liff.line.me/' + APP_CONFIG.LIFF_ID_PLAYER);
  url.searchParams.set('shop', shopId);
  for (const key of ['table', 'd', 'table_token', 'ref', 'wallet']) {
    const value = context[key];
    if (value != null && value !== '') url.searchParams.set(key, value);
  }
  return url.href;
}

function formatMemberCode(shopId, memberId) {
  const shop = /^SHOP_([0-9]{3,})$/.exec(String(shopId ?? ''));
  const member = /^M([0-9]{4,})$/.exec(String(memberId ?? ''));
  if (!shop || !member) return memberId;
  return 'M' + (shop[1] === '000' ? '' : shop[1]) + '-' + member[1];
}

function parseMemberCode(shopId, input) {
  const value = String(input ?? '').trim().toUpperCase();
  if (/^M[0-9]{4,}$/.test(value)) return value;
  const code = /^M[0-9]*-([0-9]{4,})$/.exec(value);
  if (!code) return null;
  const canonical = 'M' + code[1];
  return formatMemberCode(shopId, canonical) === value ? canonical : null;
}
