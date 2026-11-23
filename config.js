const APP_CONFIG = {
  SUPABASE_URL: "https://hduyehkjiguwndnigtva.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_CHr7rRRJadvzKjBzPiBDvA_JWMs7jN9",
  LIFF_ID_PLAYER: "2012454809-UFGeUGbW", // LIFF ID ฝั่งผู้เล่นเดิมของคุณ
  LIFF_ID_ADMIN: "2012454809-41EMnP1K" // (ถ้ามี)
};

function playerEntryUrl(shopId, context = {}, shopLiffId = null) {
  const url = new URL('https://liff.line.me/' + (shopLiffId || APP_CONFIG.LIFF_ID_PLAYER));
  url.searchParams.set('shop', shopId);
  if (shopLiffId) url.searchParams.set('shop_login', '1');
  for (const key of ['table', 'd', 'table_token', 'ref']) {
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


function formatRoundName(roundId) {
  return String(roundId ?? '').replace(/^R-([0-9]{6})-([0-9]+)-SHOP_([0-9]{3,24})$/, 'R-$1-$3-$2');
}

async function fetchPlayerEntry(shopId, signal) {
  const response = await fetch(APP_CONFIG.SUPABASE_URL + '/functions/v1/admin-api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: APP_CONFIG.SUPABASE_ANON_KEY },
    body: JSON.stringify({ action: 'player_entry', shop_id: shopId }),
    signal
  });
  if (!response.ok) return null;
  const entry = await response.json();
  if (!entry.ok) return null;
  if (!/^\d+-[A-Za-z0-9]+$/.test(entry.player_liff_id || '')) entry.player_liff_id = null;
  return entry;
}

async function configuredPlayerEntryUrl(shopId, context) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const entry = await fetchPlayerEntry(shopId, controller.signal);
    return playerEntryUrl(shopId, context, entry?.player_liff_id);
  } catch {
    return playerEntryUrl(shopId, context);
  } finally {
    clearTimeout(timeout);
  }
}
