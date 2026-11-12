import { createClient } from 'npm:@supabase/supabase-js@2';

export function makeShopReferralHandler({ env, fetcher = fetch, createDb = createClient }) {
  const origin = env('WEB_ORIGIN') || 'https://homefriendmassage-boop.github.io';
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
  };
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
  const fail = (code, status) => reply({ ok: false, code }, status);

  return async function issueReferral(request) {
    const requestOrigin = request.headers.get('origin');
    if (requestOrigin && requestOrigin !== origin) return fail('ORIGIN_INVALID', 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
    const token = request.headers.get('authorization')?.match(/^Bearer (\S{1,16000})$/i)?.[1];
    if (!token) return fail('LINE_AUTH_INVALID', 401);
    const channel = env('LINE_CHANNEL_ID_ADMIN');
    const url = env('SUPABASE_URL');
    const key = env('SUPABASE_SERVICE_ROLE_KEY');
    if (!channel || !url || !key) return fail('INVITE_CREATE_FAILED', 503);
    if (Number(request.headers.get('content-length')) > 1024) return fail('REFERRER_INVALID', 400);
    let shopId;
    try {
      const body = await request.text();
      if (body.length > 1024) return fail('REFERRER_INVALID', 400);
      shopId = JSON.parse(body)?.referrer_shop_id;
    } catch { return fail('REFERRER_INVALID', 400); }
    if (typeof shopId !== 'string' || !/^SHOP_[A-Z0-9]{3,24}$/.test(shopId)) return fail('REFERRER_INVALID', 400);

    try {
      const verified = await fetcher('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        body: new URLSearchParams({ id_token: token, client_id: channel }),
        signal: AbortSignal.timeout(10000),
      });
      if (!verified.ok) return fail('LINE_AUTH_INVALID', 401);
      const claims = await verified.json();
      if (typeof claims.sub !== 'string' || !/^U[0-9a-f]{32}$/i.test(claims.sub) ||
          claims.aud !== channel || !(Number(claims.exp) * 1000 > Date.now())) return fail('LINE_AUTH_INVALID', 401);
      const db = createDb(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const [shop, owner] = await Promise.all([
        db.from('shops').select('status').eq('shop_id', shopId).maybeSingle(),
        db.from('users').select('uid').eq('shop_id', shopId).eq('uid', claims.sub)
          .eq('member_id', 'M0000').eq('status', 'Active').in('role', ['Admin', 'Superadmin']).maybeSingle(),
      ]);
      if (shop.error || owner.error) return fail('INVITE_CREATE_FAILED', 503);
      if (!owner.data || String(shop.data?.status).toLowerCase() !== 'active') return fail('REFERRER_INVALID', 403);
      const issued = await db.from('platform_shop_invites').insert({
        created_by: claims.sub, referrer_shop_id: shopId, referral_tier: 'standard',
      }).select('invite_id,expires_at').single();
      if (issued.error || !issued.data) return fail('INVITE_CREATE_FAILED', 503);
      return reply({ ok: true, invite_id: issued.data.invite_id, expires_at: issued.data.expires_at });
    } catch {
      return fail('INVITE_CREATE_FAILED', 503);
    }
  };
}

Deno.serve(makeShopReferralHandler({ env: name => Deno.env.get(name) }));
