import { createClient } from 'npm:@supabase/supabase-js@2';

const origin = Deno.env.get('WEB_ORIGIN') || 'https://homefriendmassage-boop.github.io';
const cors = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Vary': 'Origin'
};
const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
const error = (code, status = 400) => reply({ ok: false, code }, status);

function getPrivilegedKey() {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    if (typeof keys.default === 'string' && keys.default.startsWith('sb_secret_')) return keys.default;
  } catch { /* Legacy projects may use the service role key. */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}

async function verifyToken(token, channel) {
  const clientId = Deno.env.get('LINE_CHANNEL_ID_' + channel);
  if (!clientId || !token) return null;
  let response;
  try {
    response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: token, client_id: clientId }),
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new Error('LINE_VERIFY_UNAVAILABLE');
  }
  if (!response.ok) return null;
  const claims = await response.json();
  return typeof claims.sub === 'string' && claims.aud === clientId && Number(claims.exp) * 1000 > Date.now()
    ? claims.sub : null;
}

function membershipFlex(shop, application, kind) {
  const submitted = kind === 'submitted';
  const title = submitted ? 'มีผู้สมัครสมาชิกใหม่' : 'อนุมัติสมาชิกแล้ว';
  const label = submitted ? 'ไปหน้าอนุมัติสมาชิก' : 'เข้าใช้งาน';
  const liffId = submitted
    ? (shop.liff_id_admin || Deno.env.get('MEMBERSHIP_LIFF_ID_ADMIN') || '2012454809-41EMnP1K')
    : (shop.liff_id_player || Deno.env.get('MEMBERSHIP_LIFF_ID_PLAYER') || '2012454809-UFGeUGbW');
  if (!/^\d+-[A-Za-z0-9]+$/.test(liffId)) throw new Error('MEMBERSHIP_LIFF_ID_INVALID');
  const url = new URL('https://liff.line.me/' + liffId);
  url.searchParams.set('shop', shop.shop_id);
  if (submitted) url.searchParams.set('tab', 'pending');
  const details = [
    shop.shop_name || 'บ่อตกกุ้ง',
    'สมาชิก: ' + (application.display_name || 'สมาชิก'),
    'รหัสสมาชิก: ' + (application.member_id || '—')
  ];
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'lg', color: '#087E54', wrap: true },
          ...details.map(text => ({ type: 'text', text: String(text).slice(0, 180), size: 'sm', wrap: true }))
        ]
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'button', style: 'primary', action: { type: 'uri', label, uri: url.toString() } }]
      }
    }
  };
}

async function deliverNotification(db, shop, application, kind) {
  if (!application?.id) return;
  try {
    const { data: job, error: readError } = await db.from('membership_notification_outbox')
      .select('id,first_attempt_at').eq('application_id', application.id).eq('kind', kind).is('sent_at', null).maybeSingle();
    if (readError) throw new Error('OUTBOX_READ_FAILED');
    if (!job) return;
    const owners = kind === 'submitted' ? JSON.parse(Deno.env.get('MEMBERSHIP_OWNER_UIDS') || '{}') : null;
    const to = kind === 'submitted' ? owners[shop.shop_id] : application.line_uid;
    const token = shop.line_oa_token;
    if (typeof to !== 'string' || !/^U[0-9a-f]{32}$/i.test(to) || !token) {
      throw new Error('MEMBERSHIP_LINE_CONFIGURATION_MISSING');
    }
    const message = membershipFlex(shop, application, kind);
    let firstAttempt = job.first_attempt_at;
    if (!firstAttempt) {
      const claimed = await db.from('membership_notification_outbox').update({ first_attempt_at: new Date().toISOString() })
        .eq('id', job.id).is('first_attempt_at', null).select('first_attempt_at').maybeSingle();
      if (claimed.error) throw new Error('OUTBOX_CLAIM_FAILED');
      if (!claimed.data) return;
      firstAttempt = claimed.data.first_attempt_at;
    }
    // LINE keeps retry keys for 24 hours. Keep a margin to avoid late duplicates.
    if (Date.now() - Date.parse(firstAttempt) >= 23 * 60 * 60 * 1000) {
      throw new Error('MEMBERSHIP_NOTIFICATION_RETRY_EXPIRED');
    }
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Line-Retry-Key': job.id
      },
      body: JSON.stringify({ to, messages: [message] }),
      signal: AbortSignal.timeout(4000)
    });
    const alreadyAccepted = response.status === 409 && response.headers.has('x-line-accepted-request-id');
    if (!response.ok && !alreadyAccepted) throw new Error('LINE_PUSH_HTTP_' + response.status);
    const saved = await db.from('membership_notification_outbox').update({ sent_at: new Date().toISOString() }).eq('id', job.id);
    if (saved.error) throw new Error('OUTBOX_MARK_SENT_FAILED');
  } catch (failure) {
    console.error('membership notification', kind, failure instanceof Error ? failure.message : 'UNKNOWN_ERROR');
  }
}

// Membership approval and notification only. No access to player credit.
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return error('METHOD_NOT_ALLOWED', 405);
  if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) return error('UNSUPPORTED_CONTENT_TYPE', 415);
  let input;
  try { input = await req.json(); } catch { return error('INVALID_JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return error('INVALID_JSON');
  const action = input.action;
  if (!['apply', 'status', 'queue', 'decide', 'shop'].includes(action)) return error('INVALID_ACTION');
  const shopId = typeof input.shop_id === 'string' ? input.shop_id.trim() : '';
  if (!/^[\w-]{1,80}$/.test(shopId)) return error('SHOP_INVALID');
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  try {
    const isAdmin = action === 'queue' || action === 'decide';
    const uid = await verifyToken(token, isAdmin ? 'ADMIN' : 'PLAYER');
    if (!uid) return error('LINE_AUTH_INVALID', 401);
    const dbUrl = Deno.env.get('SUPABASE_URL');
    if (!dbUrl) return error('SUPABASE_URL_MISSING', 503);
    const key = getPrivilegedKey();
    if (!key) return error('SUPABASE_SERVER_KEY_MISSING', 503);
    const db = createClient(dbUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: shop, error: shopError } = await db.from('shops').select('*').eq('shop_id', shopId).maybeSingle();
    if (shopError) return error('DATABASE_ERROR', 500);
    if (!shop) return error('SHOP_NOT_AVAILABLE', 404);
    if (action === 'shop') {
      const names = ['shop_name', 'name', 'business_name', 'store_name', 'display_name', 'title'];
      const label = names.map(k => shop[k]).find(v => typeof v === 'string' && v.trim().length > 0);
      return reply({ ok: true, shop_name: label?.trim() ?? null });
    }
    if (isAdmin) {
      const staff = await db.from('users').select('role,status').eq('uid', uid).eq('shop_id', shopId).maybeSingle();
      if (staff.error) return error('DATABASE_ERROR', 500);
      const legacyAdmin = staff.data?.status === 'Active' && ['Admin', 'Superadmin'].includes(staff.data.role);
      const grant = await db.from('membership_admins').select('line_uid').eq('shop_id', shopId).eq('line_uid', uid).maybeSingle();
      if (grant.error) return error('ADMIN_GRANTS_UNAVAILABLE', 503);
      if (!legacyAdmin && !grant.data) return error('ADMIN_REQUIRED', 403);
      if (action === 'queue') {
        const result = await db.from('membership_applications').select('id,member_id,display_name,state,requested_at,decided_at,reason')
          .eq('shop_id', shopId).order('requested_at', { ascending: false }).limit(100);
        if (result.error) return error('DATABASE_ERROR', 500);
        return reply({ ok: true, entries: result.data ?? [] });
      }
      const id = typeof input.id === 'string' ? input.id : '';
      const decision = input.decision;
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !['Approved', 'Rejected'].includes(decision)) {
        return error('INVALID_DECISION');
      }
      const result = await db.from('membership_applications').update({
        state: decision, decided_by: uid, decided_at: new Date().toISOString()
      }).eq('id', id).eq('shop_id', shopId).eq('state', 'Pending')
        .select('id,member_id,state,line_uid,display_name').maybeSingle();
      if (result.error) return error('DATABASE_ERROR', 500);
      if (!result.data) return error('ALREADY_PROCESSED', 409);
      const { line_uid, display_name, ...application } = result.data;
      if (decision === 'Approved') await deliverNotification(db, shop, result.data, 'approved');
      return reply({ ok: true, application });
    }
    const ownApplication = () => db.from('membership_applications')
      .select('id,member_id,state,requested_at,decided_at,line_uid,display_name')
      .eq('shop_id', shopId).eq('line_uid', uid).maybeSingle();
    if (action === 'apply') {
      const displayName = typeof input.display_name === 'string' ? input.display_name.trim().slice(0, 80) : '';
      const result = await db.from('membership_applications').upsert({
        shop_id: shopId, line_uid: uid, display_name: displayName, state: 'Pending'
      }, { onConflict: 'shop_id,line_uid', ignoreDuplicates: true });
      if (result.error) return error('DATABASE_ERROR', 500);
    }
    const result = await ownApplication();
    if (result.error) return error('DATABASE_ERROR', 500);
    if (!result.data) return reply({ ok: true, application: null });
    if (result.data.state === 'Pending') await deliverNotification(db, shop, result.data, 'submitted');
    if (result.data.state === 'Approved') await deliverNotification(db, shop, result.data, 'approved');
    const { line_uid, display_name, ...application } = result.data;
    return reply({ ok: true, application });
  } catch (failure) {
    if (failure instanceof Error && failure.message === 'LINE_VERIFY_UNAVAILABLE') return error('LINE_VERIFY_UNAVAILABLE', 503);
    console.error('member-approval failure', action, failure instanceof Error ? failure.name : 'UNKNOWN_ERROR');
    return error('SERVER_ERROR', 500);
  }
});
