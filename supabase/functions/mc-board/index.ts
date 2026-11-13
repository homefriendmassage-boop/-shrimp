import { createClient } from 'npm:@supabase/supabase-js@2';

const fail = (code, status) => { throw Object.assign(new Error(code), { status }); };
const revisionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function serverKey(env) {
  try {
    const parsed = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
    if (typeof parsed.default === 'string' && parsed.default.startsWith('sb_secret_')) return parsed.default;
  } catch (_) { /* allow legacy fallback */ }
  return env('SUPABASE_SERVICE_ROLE_KEY') || null;
}

export function makeBoardHandler({ env, fetcher = fetch, createDb = createClient }) {
  function database() {
    const url = env('SUPABASE_URL');
    const key = serverKey(env);
    if (!url || !key) fail('BOARD_UNAVAILABLE', 503);
    return createDb(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
  const unhex = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
  const encoder = new TextEncoder();

  async function boardPasswordHash(password, salt) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    return hex(await crypto.subtle.deriveBits({
      name: 'PBKDF2', salt: unhex(salt), iterations: 600000, hash: 'SHA-256',
    }, key, 256));
  }

  async function boardSessionSignature(shop, revision, expires) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(serverKey(env)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(['mc-board', shop, revision, expires]))));
  }

  function equalHex(first, second) {
    if (first.length !== second.length) return false;
    let difference = 0;
    for (let i = 0; i < first.length; i++) difference |= first.charCodeAt(i) ^ second.charCodeAt(i);
    return difference === 0;
  }

  async function readBoard(input, shopId) {
    const db = database();
    if (input.action === 'unlock') {
      if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128) {
        fail('BOARD_PASSWORD_INVALID', 400);
      }
      const access = await db.rpc('reserve_mc_board_attempt', { p_shop: shopId });
      if (access.error) fail('BOARD_UNAVAILABLE', 500);
      const row = access.data?.[0];
      if (!row) {
        const setting = await db.from('mc_board_access').select('revision,shops!inner(status)')
          .eq('shop_id', shopId).eq('shops.status', 'active').maybeSingle();
        if (setting.error) fail('BOARD_UNAVAILABLE', 500);
        if (!setting.data) fail('BOARD_SETUP_REQUIRED', 403);
        fail('BOARD_TRY_LATER', 429);
      }
      if (!equalHex(await boardPasswordHash(input.password, row.salt), row.password_hash)) fail('BOARD_PASSWORD_INCORRECT', 401);
      const expires = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
      const signature = await boardSessionSignature(shopId, row.revision, expires);
      return { ok: true, session: [row.revision, expires, signature].join('.') };
    }
    const session = typeof input.board_session === 'string'
      ? /^([a-f0-9-]{36})[.]([0-9]{10})[.]([a-f0-9]{64})$/.exec(input.board_session) : null;
    if (!session || !revisionPattern.test(session[1]) || Number(session[2]) <= Math.floor(Date.now() / 1000) ||
        !equalHex(session[3], await boardSessionSignature(shopId, session[1], Number(session[2])))) {
      fail('BOARD_PASSWORD_REQUIRED', 401);
    }
    const result = await db.rpc('read_mc_board', { p_shop: shopId, p_revision: session[1] });
    if (result.error) fail('BOARD_UNAVAILABLE', 500);
    if (!result.data) fail('BOARD_PASSWORD_REQUIRED', 401);
    return { ok: true, board: result.data };
  }

  return async req => {
    const origin = env('WEB_ORIGIN') || 'https://homefriendmassage-boop.github.io';
    const headers = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
      'Vary': 'Origin', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    };
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (req.method === 'OPTIONS') return new Response(null, { headers });
    try {
      if (req.method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
      if (req.headers.get('origin') && req.headers.get('origin') !== origin) fail('ORIGIN_NOT_ALLOWED', 403);
      if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) fail('INVALID_JSON', 415);
      if (Number(req.headers.get('content-length')) > 4096) fail('INVALID_JSON', 413);
      const raw = await req.text();
      if (raw.length > 4096) fail('INVALID_JSON', 413);
      let input;
      try { input = JSON.parse(raw); } catch { fail('INVALID_JSON', 400); }
      const shopId = input?.shop_id;
      if (typeof shopId !== 'string' || !/^SHOP_[0-9]{3,24}$/.test(shopId)) fail('SHOP_INVALID', 400);
      if (['read', 'unlock'].includes(input.action)) return reply(await readBoard(input, shopId));
      if (input.action === 'set_password') {
        const token = req.headers.get('authorization')?.match(/^Bearer ([^ ]+)$/i)?.[1];
        if (!token || token.length > 16000) fail('LINE_AUTH_INVALID', 401);
        const clientId = env('LINE_CHANNEL_ID_ADMIN');
        if (!clientId) fail('BOARD_UNAVAILABLE', 503);
        const verified = await fetcher('https://api.line.me/oauth2/v2.1/verify', {
          method: 'POST',
          body: new URLSearchParams({ id_token: token, client_id: clientId }),
          signal: AbortSignal.timeout(8000),
        });
        if (!verified.ok) fail('LINE_AUTH_INVALID', 401);
        const claims = await verified.json();
        if (typeof claims.sub !== 'string' || claims.aud !== clientId ||
            !(Number(claims.exp) * 1000 > Date.now())) fail('LINE_AUTH_INVALID', 401);
        const db = database();
        const [staff, shop] = await Promise.all([
          db.from('users').select('role,status').eq('shop_id', shopId).eq('uid', claims.sub).maybeSingle(),
          db.from('shops').select('status').eq('shop_id', shopId).maybeSingle(),
        ]);
        if (staff.error || shop.error) fail('BOARD_UNAVAILABLE', 500);
        if (staff.data?.status !== 'Active' || !['Admin', 'Superadmin'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
        if (shop.data?.status !== 'active') fail('SHOP_NOT_AVAILABLE', 403);
        if (typeof input.password !== 'string' || input.password.length < 8 || input.password.length > 128 ||
            !input.password.trim()) fail('BOARD_PASSWORD_INVALID', 400);
        const salt = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
        const saved = await db.from('mc_board_access').upsert({
          shop_id: shopId, salt, password_hash: await boardPasswordHash(input.password, salt),
          revision: crypto.randomUUID(), attempt_window: new Date().toISOString(), attempt_count: 0,
        }, { onConflict: 'shop_id' });
        if (saved.error) fail('BOARD_PASSWORD_SAVE_FAILED', 500);
        return reply({ ok: true });
      }
      fail('INVALID_ACTION', 400);
    } catch (error) {
      return reply({ ok: false, code: error.status ? error.message : 'BOARD_UNAVAILABLE' }, error.status || 500);
    }
  };
}

Deno.serve(makeBoardHandler({ env: name => Deno.env.get(name) }));
