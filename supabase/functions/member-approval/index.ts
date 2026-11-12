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
    ? { uid: claims.sub, picture: linePicture(claims.picture) } : null;
}

function linePicture(value) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'profile.line-scdn.net' ? url.toString() : null;
  } catch { return null; }
}
async function readOaPicture(db, shop, uid) {
  const target = await db.rpc('resolve_shop_oa_recipient', { p_shop: shop.shop_id, p_member: uid });
  if (target.error || !target.data) return null;
  uid = target.data;
  if (!shop.line_oa_token || !/^U[0-9a-f]{32}$/i.test(uid)) return null;
  try {
    const response = await fetch('https://api.line.me/v2/bot/profile/' + uid, {
      headers: { Authorization: 'Bearer ' + shop.line_oa_token },
      signal: AbortSignal.timeout(3000)
    });
    return response.ok ? linePicture((await response.json()).pictureUrl) : null;
  } catch { return null; }
}

function membershipFlex(shop, application, kind) {
  const submitted = kind === 'submitted';
  const title = submitted ? 'มีผู้สมัครสมาชิกใหม่' : 'อนุมัติสมาชิกแล้ว';
  const label = submitted ? 'ไปหน้าอนุมัติสมาชิก' : 'เข้าใช้งาน';
  const liffId = submitted
    ? (shop.liff_id_admin || Deno.env.get('MEMBERSHIP_LIFF_ID_ADMIN') || '2012454809-41EMnP1K')
    : '2012454809-UFGeUGbW';
  if (!/^\d+-[A-Za-z0-9]+$/.test(liffId)) throw new Error('MEMBERSHIP_LIFF_ID_INVALID');
  const url = new URL('https://liff.line.me/' + liffId);
  url.searchParams.set('shop', shop.shop_id);
  if (submitted) url.searchParams.set('tab', 'pending');
  const details = [
    shop.shop_name || 'บ่อตกกุ้ง',
    'สมาชิก: ' + (application.display_name || 'สมาชิก'),
    'รหัสสมาชิก: ' + (formatMemberCode(shop.shop_id, application.member_id) || '—')
  ];
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      ...(submitted && linePicture(application.profile_pic) ? { hero: { type: 'image', url: linePicture(application.profile_pic), size: 'full', aspectRatio: '2:1', aspectMode: 'cover' } } : {}),
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

async function noticeWindow(db, applicationId) {
  const result = await db.from('membership_notification_outbox').select('last_attempt_at,sent_at')
    .eq('application_id', applicationId).eq('kind', 'submitted').maybeSingle();
  if (result.error || !result.data) return null;
  return {
    retry_at: result.data.last_attempt_at
      ? new Date(Date.parse(result.data.last_attempt_at) + 30 * 60 * 1000).toISOString() : null,
    accepted: !!result.data.sent_at
  };
}
async function deliverNotification(db, shop, application, kind, manual = false) {
  if (!application?.id) return { status: 'failed', code: 'APPLICATION_NOT_FOUND' };
  if (shop.line_notifications_enabled === false) return { status: 'disabled' };
  try {
    let to;
    if (kind !== 'submitted') {
      const target = await db.rpc('resolve_shop_oa_recipient', { p_shop: shop.shop_id, p_member: application.line_uid });
      if (target.error) throw new Error('OA_RECIPIENT_LOOKUP_FAILED');
      if (!target.data) return { status: 'failed', code: 'OA_ACCOUNT_NOT_LINKED' };
      to = target.data;
    }
    if (kind === 'submitted') {
      to = shop.membership_notice_recipient_uid;
      if (!to) try {
        const owners = JSON.parse(Deno.env.get('MEMBERSHIP_OWNER_UIDS') || '{}');
        to = owners?.[shop.shop_id];
      } catch { throw new Error('MEMBERSHIP_OWNER_UIDS_INVALID'); }
    }
    const token = shop.line_oa_token?.trim();
    if (typeof to !== 'string' || !/^U[0-9a-f]{32}$/i.test(to)) throw new Error('MEMBERSHIP_OWNER_UID_MISSING');
    if (!token) throw new Error('SHOP_OA_TOKEN_MISSING');
    const claim = await db.rpc('claim_membership_notice', {
      p_application: application.id, p_kind: kind, p_manual: manual
    });
    if (claim.error) throw new Error('OUTBOX_CLAIM_FAILED');
    const [job] = claim.data ?? [];
    if (!job) return { status: 'waiting' };

    const message = membershipFlex(shop, application, kind);
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Line-Retry-Key': job.retry_key
      },
      body: JSON.stringify({ to, messages: [message] }),
      signal: AbortSignal.timeout(4000)
    });
    const alreadyAccepted = response.status === 409 && response.headers.has('x-line-accepted-request-id');
    if (!response.ok && !alreadyAccepted) throw new Error('LINE_PUSH_HTTP_' + response.status);
    const saved = await db.from('membership_notification_outbox').update({ sent_at: new Date().toISOString() })
      .eq('id', job.id).eq('retry_key', job.retry_key);
    if (saved.error) throw new Error('OUTBOX_MARK_SENT_FAILED');
    return { status: 'accepted' };
  } catch (failure) {
    console.error('membership notification', kind, failure instanceof Error ? failure.message : 'UNKNOWN_ERROR');
    const message = failure instanceof Error ? failure.message : '';
    const allowed = [
      'MEMBERSHIP_OWNER_UIDS_INVALID', 'MEMBERSHIP_LINE_CONFIGURATION_MISSING',
      'OUTBOX_CLAIM_FAILED', 'OUTBOX_MARK_SENT_FAILED', 'MEMBERSHIP_LIFF_ID_INVALID',
      'MEMBERSHIP_OWNER_UID_MISSING', 'SHOP_OA_TOKEN_MISSING'
    ];
    const code = allowed.includes(message) || /^LINE_PUSH_HTTP_[0-9]{3}$/.test(message)
      ? message : 'NOTIFICATION_SEND_FAILED';
    return { status: 'failed', code };
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
  if (!['apply', 'status', 'retry_notice', 'queue', 'decide', 'shop'].includes(action)) return error('INVALID_ACTION');
  const shopId = typeof input.shop_id === 'string' ? input.shop_id.trim() : '';
  if (!/^[\w-]{1,80}$/.test(shopId)) return error('SHOP_INVALID');
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  try {
    const isAdmin = action === 'queue' || action === 'decide';
    const identity = await verifyToken(token, isAdmin ? 'ADMIN' : 'PLAYER');
    if (!identity) return error('LINE_AUTH_INVALID', 401);
    const { uid, picture } = identity;
    const dbUrl = Deno.env.get('SUPABASE_URL');
    if (!dbUrl) return error('SUPABASE_URL_MISSING', 503);
    const key = getPrivilegedKey();
    if (!key) return error('SUPABASE_SERVER_KEY_MISSING', 503);
    const db = createClient(dbUrl, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: shop, error: shopError } = await db.from('shop_oa_runtime').select('shop_id,shop_name,status,line_oa_token,liff_id_admin,line_notifications_enabled,membership_notice_recipient_uid').eq('shop_id', shopId).maybeSingle();
    if (shopError) return error('DATABASE_ERROR', 500);
    if (!shop || String(shop.status).toLowerCase() !== 'active') return error('SHOP_NOT_AVAILABLE', 404);
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
        const result = await db.from('membership_applications').select('id,member_id,display_name,state,requested_at,decided_at,reason,profile_pic,line_uid')
          .eq('shop_id', shopId).order('requested_at', { ascending: false }).limit(100);
        if (result.error) return error('DATABASE_ERROR', 500);
        const entries = result.data ?? [];
        const missing = entries.filter(item => item.state === 'Pending' && !item.profile_pic).slice(0, 10);
        await Promise.all(missing.map(async item => {
          const image = await readOaPicture(db, shop, item.line_uid);
          if (!image) return;
          item.profile_pic = image;
          await db.from('membership_applications').update({ profile_pic: image }).eq('shop_id', shopId).eq('id', item.id);
        }));
        return reply({ ok: true, entries: entries.map(({ line_uid, ...item }) => item) });
      }
      const id = typeof input.id === 'string' ? input.id : '';
      const decision = input.decision;
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) || !['Approved', 'Rejected'].includes(decision)) {
        return error('INVALID_DECISION');
      }
      const result = await db.from('membership_applications').update({
        state: decision, decided_by: uid, decided_at: new Date().toISOString()
      }).eq('id', id).eq('shop_id', shopId).eq('state', 'Pending')
        .select('id,member_id,state,line_uid,display_name,profile_pic').maybeSingle();
      if (result.error) return error('DATABASE_ERROR', 500);
      if (!result.data) return error('ALREADY_PROCESSED', 409);
      const { line_uid, display_name, ...application } = result.data;
      if (decision === 'Approved') await deliverNotification(db, shop, result.data, 'approved');
      return reply({ ok: true, application });
    }
    const ownApplication = () => db.from('membership_applications')
      .select('id,member_id,state,requested_at,decided_at,line_uid,display_name,profile_pic')
      .eq('shop_id', shopId).eq('line_uid', uid).maybeSingle();
    if (action === 'apply') {
      const displayName = typeof input.display_name === 'string' ? input.display_name.trim().slice(0, 80) : '';
      const result = await db.from('membership_applications').upsert({
        shop_id: shopId, line_uid: uid, display_name: displayName, profile_pic: picture, state: 'Pending'
      }, { onConflict: 'shop_id,line_uid', ignoreDuplicates: true });
      if (result.error) return error('DATABASE_ERROR', 500);
    }
    const result = await ownApplication();
    if (result.error) return error('DATABASE_ERROR', 500);
    if (!result.data) return reply({ ok: true, application: null });
    const own = result.data;
    if (!own.profile_pic && (picture || input.action === 'retry_notice' || input.action === 'apply')) {
      const image = picture || await readOaPicture(db, shop, uid);
      if (image) {
        own.profile_pic = image;
        await db.from('membership_applications').update({ profile_pic: image }).eq('id', own.id).eq('shop_id', shopId);
      }
    }
    let delivery;
    if (own.state === 'Pending' && ['apply', 'retry_notice'].includes(input.action)) {
      delivery = await deliverNotification(db, shop, own, 'submitted', input.action === 'retry_notice');
    }
    if (own.state === 'Approved' && input.action === 'status' && shop.shop_id !== 'SHOP_000') {
      const pending = await db.from('membership_notification_outbox').select('sent_at')
        .eq('application_id', own.id).eq('kind', 'approved').maybeSingle();
      if (pending.data && !pending.data.sent_at) delivery = await deliverNotification(db, shop, own, 'approved', true);
    }
    const { line_uid, display_name, ...application } = own;
    const notice = own.state === 'Pending' ? await noticeWindow(db, own.id) : null;
    return reply({ ok: true, application, notice, delivery: delivery?.status, delivery_code: delivery?.code });
  } catch (failure) {
    if (failure instanceof Error && failure.message === 'LINE_VERIFY_UNAVAILABLE') return error('LINE_VERIFY_UNAVAILABLE', 503);
    console.error('member-approval failure', action, failure instanceof Error ? failure.name : 'UNKNOWN_ERROR');
    return error('SERVER_ERROR', 500);
  }
});

function formatMemberCode(shopId, memberId) {
  const shop = /^SHOP_([0-9]{3,})$/.exec(String(shopId ?? ''));
  const member = /^M([0-9]{4,})$/.exec(String(memberId ?? ''));
  if (!shop || !member) return memberId;
  return 'M' + (shop[1] === '000' ? '' : shop[1]) + '-' + member[1];
}
