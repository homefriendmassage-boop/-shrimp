import { createClient } from 'npm:@supabase/supabase-js@2';

const origin = Deno.env.get('WEB_ORIGIN') || 'https://homefriendmassage-boop.github.io';
const headers = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Vary': 'Origin'
};
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const fail = (code, status = 400) => reply({ ok: false, code }, status);
const uidPattern = /^U[0-9a-f]{32}$/i;

function serverKey() {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    if (typeof keys.default === 'string' && keys.default.startsWith('sb_secret_')) return keys.default;
  } catch { /* Older projects may have a service role key. */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
  if (req.headers.get('origin') && req.headers.get('origin') !== origin) return fail('ORIGIN_NOT_ALLOWED', 403);
  try {
    const raw = await req.text();
    if (raw.length > 8192) return fail('REQUEST_TOO_LARGE', 413);
    let input;
    try { input = JSON.parse(raw); } catch { return fail('INVALID_JSON'); }
    if (!input || input.shop_id !== 'SHOP_000' || !['status', 'apply', 'queue', 'activate'].includes(input.action)) {
      return fail('DEMO_ONLY', 403);
    }
    const channel = Deno.env.get('LINE_CHANNEL_ID_ADMIN');
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const url = Deno.env.get('SUPABASE_URL');
    const key = serverKey();
    if (!channel || !key || !url) return fail('SERVER_CONFIGURATION_MISSING', 503);
    if (!token) return fail('LINE_AUTH_INVALID', 401);
    const verified = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST', body: new URLSearchParams({ id_token: token, client_id: channel }),
      signal: AbortSignal.timeout(8000)
    });
    if (!verified.ok) return fail('LINE_AUTH_INVALID', 401);
    const claims = await verified.json();
    if (!uidPattern.test(claims.sub) || claims.aud !== channel || !(Number(claims.exp) * 1000 > Date.now())) {
      return fail('LINE_AUTH_INVALID', 401);
    }
    const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const platformOwner = claims.sub === Deno.env.get('MERCHANT_PLATFORM_OWNER_UID');
    const fields = 'shop_id,shop_name,state,requested_at,activated_at';
    if (input.action === 'queue' || input.action === 'activate') {
      if (!platformOwner) return fail('PLATFORM_OWNER_REQUIRED', 403);
      if (input.action === 'queue') {
        const result = await db.from('merchant_shop_requests').select(fields).order('requested_at', { ascending: true }).limit(100);
        if (result.error) return fail('DATABASE_ERROR', 500);
        return reply({ ok: true, requests: result.data });
      }
      if (typeof input.requested_shop !== 'string' || !/^SHOP_[0-9]{3,}$/.test(input.requested_shop)) {
        return fail('SHOP_INVALID');
      }
      const result = await db.rpc('activate_merchant_shop', { p_shop: input.requested_shop });
      if (result.error) {
        const known = result.error.message === 'SHOP_REQUEST_NOT_FOUND';
        return fail(known ? result.error.message : 'DATABASE_ERROR', known ? 409 : 500);
      }
      return reply({ ok: true, request: result.data });
    }
    const own = await db.from('merchant_shop_requests').select(fields).eq('owner_line_uid', claims.sub).maybeSingle();
    if (own.error) return fail('DATABASE_ERROR', 500);
    if (input.action === 'status' || own.data) {
      return reply({ ok: true, owner_uid: claims.sub, platform_owner: platformOwner, request: own.data });
    }
    const name = typeof input.shop_name === 'string' ? input.shop_name.trim() : '';
    const oaToken = typeof input.channel_access_token === 'string' ? input.channel_access_token.trim() : '';
    if (!name || name.length > 80 || input.owner_uid !== claims.sub || !oaToken || oaToken.length > 2048) {
      return fail('INVALID_SHOP_REQUEST');
    }
    const oaHeaders = { Authorization: 'Bearer ' + oaToken };
    const botResponse = await fetch('https://api.line.me/v2/bot/info', { headers: oaHeaders, signal: AbortSignal.timeout(8000) });
    if (!botResponse.ok) return fail('LINE_OA_TOKEN_INVALID', 422);
    const bot = await botResponse.json();
    if (!uidPattern.test(bot.userId)) return fail('LINE_OA_TOKEN_INVALID', 422);
    // Check that the OA can resolve the verified owner UID before accepting it.
    const ownerResponse = await fetch('https://api.line.me/v2/bot/profile/' + claims.sub, {
      headers: oaHeaders, signal: AbortSignal.timeout(8000)
    });
    if (!ownerResponse.ok) return fail('LINE_OA_OWNER_NOT_REACHABLE', 422);
    const result = await db.rpc('register_merchant_shop', {
      p_name: name, p_owner: claims.sub, p_bot: bot.userId, p_token: oaToken
    });
    if (result.error) {
      const duplicate = result.error.message === 'OA_ALREADY_REGISTERED';
      return fail(duplicate ? 'OA_ALREADY_REGISTERED' : 'DATABASE_ERROR', duplicate ? 409 : 500);
    }
    return reply({ ok: true, request: result.data });
  } catch {
    console.error('merchant-onboarding request failed');
    return fail('SERVER_ERROR', 500);
  }
});
