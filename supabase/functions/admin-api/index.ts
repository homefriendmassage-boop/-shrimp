// Separate from member-approval. Deploy with verify_jwt=false: LINE verifies tokens below.
// Required secrets: LINE_CHANNEL_ID_ADMIN, WEB_ORIGIN (origin only), and a Supabase server key.
import { createClient } from 'npm:@supabase/supabase-js@2';

const fields = {
  users: 'uid shop_id member_id display_name profile_pic role status credit_balance total_deposit commission_balance referrer_uid backer_share backer_water_fee backer_wallet created_at',
  tables: 'id shop_id table_no credit created_at',
  rounds: 'round_id shop_id status weight result created_at end_time_ms resolver_type',
  bets: 'bet_id shop_id round_id uid table_no bet_type amount status play_mode payout created_at',
  backer_logs: 'id shop_id round_id uid member_id share_percent gap_amount result_status pnl_amount water_fee_deducted wallet_balance_after created_at',
  transactions: 'id shop_id target_id type amount admin_name target_type created_at',
  topup_requests: 'id shop_id uid member_id display_name type amount method fee_option slip_url status admin_name created_at',
  system_settings: 'id shop_id water_margin min_bet max_bet round_duration comm_rate withdrawal_fee_mode created_at'
};
const writes = {
  users: { update: 'role status credit_balance total_deposit commission_balance backer_share backer_water_fee backer_wallet' },
  tables: { insert: 'shop_id table_no credit', update: 'credit', delete: '' },
  rounds: { insert: 'shop_id round_id status end_time_ms resolver_type', update: 'status end_time_ms resolver_type weight result' },
  bets: { update: 'status payout' },
  backer_logs: { insert: 'shop_id round_id uid member_id share_percent gap_amount result_status pnl_amount water_fee_deducted wallet_balance_after' },
  transactions: { insert: 'shop_id target_id type amount admin_name target_type' },
  topup_requests: { update: 'status admin_name' },
  system_settings: { update: 'water_margin min_bet max_bet round_duration comm_rate withdrawal_fee_mode' }
};
const identity = { users: ['uid', 'member_id'], tables: ['table_no'], rounds: ['round_id'], bets: ['bet_id'], topup_requests: ['id'] };
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };
const includes = (words, key) => words.split(' ').includes(key);
const primitive = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';

function lineProfilePicture(value) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'profile.line-scdn.net' ? url.toString() : null;
  } catch { return null; }
}

const playerTokenCache = new Map();
async function verifyLineClaims(token, clientId, fetcher, useCache) {
  let key;
  if (useCache) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientId + ':' + token));
    key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const cached = playerTokenCache.get(key);
    if (cached && cached.until > Date.now()) return cached.claims;
  }
  let verified;
  try {
    verified = await fetcher('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: token, client_id: clientId }), signal: AbortSignal.timeout(10000)
    });
  } catch { fail('LINE_VERIFY_UNAVAILABLE', 503); }
  if (!verified.ok) fail('LINE_AUTH_INVALID', 401);
  const claims = await verified.json();
  if (typeof claims.sub !== 'string' || claims.aud !== clientId || !(Number(claims.exp) * 1000 > Date.now())) {
    fail('LINE_AUTH_INVALID', 401);
  }
  if (key) {
    if (playerTokenCache.size >= 256) playerTokenCache.delete(playerTokenCache.keys().next().value);
    playerTokenCache.set(key, { claims: { sub: claims.sub }, until: Math.min(Date.now() + 60000, Number(claims.exp) * 1000) });
  }
  return claims;
}

export function validateQuery(input, role, shopId) {
  const { table, operation = 'select' } = input;
  if (!Object.hasOwn(fields, table)) fail('TABLE_NOT_ALLOWED', 403);
  if (!['select', 'insert', 'update', 'delete'].includes(operation)) fail('OPERATION_NOT_ALLOWED', 403);
  if (!['Admin', 'Superadmin', 'Operator'].includes(role)) fail('ADMIN_REQUIRED', 403);
  if (role === 'Operator' && operation === 'select' && ['transactions', 'backer_logs'].includes(table)) fail('ADMIN_REQUIRED', 403);
  const columns = input.columns === '*' || input.columns === undefined ? fields[table].split(' ') : String(input.columns).split(',').map(s => s.trim());
  if (!columns.length || columns.some(c => !includes(fields[table], c))) fail('COLUMN_NOT_ALLOWED', 403);
  const filters = input.filters ?? [];
  const orders = input.orders ?? [];
  if (!Array.isArray(filters) || filters.length > 16 || !Array.isArray(orders) || orders.length > 4) fail('QUERY_INVALID');
  for (const f of filters) {
    if (!f || !includes(fields[table], f.column) || !['eq', 'neq', 'gte', 'lte', 'like', 'in'].includes(f.op)) fail('FILTER_INVALID');
    if (f.op === 'in' ? !Array.isArray(f.value) || f.value.length > 100 || f.value.some(v => !primitive(v)) : !primitive(f.value)) fail('FILTER_INVALID');
    if (f.column === 'shop_id' && (f.op !== 'eq' || f.value !== shopId)) fail('SHOP_MISMATCH', 403);
  }
  for (const o of orders) if (!o || !includes(fields[table], o.column) || typeof o.ascending !== 'boolean') fail('ORDER_INVALID');
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)) fail('LIMIT_INVALID');
  if (operation !== 'select') {
    const allowed = writes[table]?.[operation];
    if (allowed === undefined) fail('WRITE_NOT_ALLOWED', 403);
    if (role === 'Operator' && (table === 'system_settings' || (table === 'users' && Object.keys(input.values ?? {}).some(k => !['credit_balance', 'total_deposit', 'commission_balance', 'backer_wallet'].includes(k))))) fail('ADMIN_REQUIRED', 403);
    if (operation === 'update' || operation === 'delete') {
      // The shop predicate is added by the server; never accept an unbounded mutation.
      if (table !== 'system_settings' && !(identity[table] ?? []).some(c => filters.some(f => f.op === 'eq' && f.column === c && String(f.value).length > 0))) fail('TARGET_REQUIRED');
    }
    if (operation !== 'delete') {
      if (operation === 'update' && Array.isArray(input.values)) fail('VALUES_INVALID');
      const rows = Array.isArray(input.values) ? input.values : [input.values];
      if (!rows.length || rows.length > 100 || (operation === 'update' && rows.length !== 1)) fail('VALUES_INVALID');
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || !Object.keys(row).length) fail('VALUES_INVALID');
        for (const [key, value] of Object.entries(row)) {
          if (!includes(allowed, key) || (!primitive(value) && value !== null)) fail('VALUE_NOT_ALLOWED', 403);
          if (key === 'shop_id' && value !== shopId) fail('SHOP_MISMATCH', 403);
          if (['credit_balance', 'total_deposit', 'commission_balance', 'backer_wallet', 'credit', 'payout', 'amount'].includes(key) && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) fail('AMOUNT_INVALID');
          if (key === 'role' && !['Customer', 'Promoter', 'Backer', 'Operator', 'Admin'].includes(String(value))) fail('ROLE_INVALID');
          if (table === 'users' && key === 'status' && !['Active', 'Inactive'].includes(String(value))) fail('STATUS_INVALID');
        }
      }
    }
  }
  return { table, operation, columns: columns.join(','), filters, orders };
}

function serverKey(env) {
  try {
    const parsed = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}');
    if (typeof parsed.default === 'string' && parsed.default.startsWith('sb_secret_')) return parsed.default;
  } catch (_) { /* allow legacy fallback */ }
  return env('SUPABASE_SERVICE_ROLE_KEY') || null;
}

async function notifyWalletPlayer(db, fetcher, env, shopId, request) {
  if (!/^U[0-9a-f]{32}$/i.test(request.uid) || !['ฝากเงิน', 'ถอนเงิน'].includes(request.type)) return;
  try {
    const shop = await db.from('shop_oa_runtime').select('line_oa_token,liff_id_player,liff_id_admin,admin_group_id,line_notifications_enabled,membership_notice_recipient_uid').eq('shop_id', shopId).maybeSingle();
    const token = shop.data?.line_oa_token;
    if (!token || shop.data?.line_notifications_enabled === false) return;
    const credited = request.status === 'Approved' && request.type === 'ฝากเงิน';
    const rejectedDeposit = request.status === 'Rejected' && request.type === 'ฝากเงิน';
    const profile = credited && request.member_id ? null : await db.from('users').select('display_name,member_id,profile_pic')
      .eq('shop_id', shopId).eq('uid', request.uid).maybeSingle();
    const name = String(request.display_name || profile?.data?.display_name || 'สมาชิก').slice(0, 100);
    const member = formatMemberCode(shopId, request.member_id || profile?.data?.member_id);
    const picture = lineProfilePicture(request.profile_pic || profile?.data?.profile_pic);
    const titles = { Pending: 'ได้รับคำขอ', Approved: 'ทำรายการสำเร็จ', Rejected: 'คำขอถูกปฏิเสธ' };
    const title = credited ? '🎉 เติมเครดิตสำเร็จ' : rejectedDeposit ? '❌ เติมเงินไม่สำเร็จ' : titles[request.status] + ' · ' + request.type;
    const adminLiff = shop.data?.liff_id_admin || env('MEMBERSHIP_LIFF_ID_ADMIN') || '2012454809-41EMnP1K';
    const opensQueue = request.status === 'Pending' && request.staff_recipient === true;
    const playerLiff = shop.data?.liff_id_player || env('MEMBERSHIP_LIFF_ID_PLAYER') || '2012454809-UFGeUGbW';
    const bubble = { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: title, weight: 'bold', wrap: true,
        ...(rejectedDeposit ? { color: '#B91C1C', size: 'lg' } : {}) },
      ...(!credited && !rejectedDeposit && picture ? [{ type: 'image', url: picture, size: 'sm', aspectRatio: '1:1', aspectMode: 'cover', align: 'start' }] : []),
      ...(credited ? (member ? [{ type: 'text', text: 'สมาชิก ' + member, wrap: true }] : [])
        : [{ type: 'text', text: name + (member ? ' · สมาชิก ' + member : ''), wrap: true }]),
      { type: 'text', text: (credited ? 'ยอดที่เติม ฿' : 'ยอดรายการ ฿') + Number(request.amount).toLocaleString('th-TH', { maximumFractionDigits: 2 }),
        ...(credited ? { size: 'xl', weight: 'bold', color: '#047857' } : {}), wrap: true },
      ...(rejectedDeposit ? [{ type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: '12px',
        backgroundColor: '#FEE2E2', cornerRadius: 'md', contents: [
          { type: 'text', text: 'เหตุผลที่แอดมินปฏิเสธ', color: '#991B1B', weight: 'bold', wrap: true },
          { type: 'text', text: request.rejection_reason || 'แอดมินไม่ได้ระบุเหตุผล', color: '#991B1B', wrap: true },
        ] }] : []),
    ] } };
    const liff = opensQueue ? adminLiff : playerLiff;
    if (/^\d+-[a-zA-Z0-9]+$/.test(liff)) {
      bubble.footer = { type: 'box', layout: 'vertical', contents: [{
        type: 'button', style: 'primary', ...(rejectedDeposit ? { color: '#B91C1C' } : {}), action: {
          type: 'uri', label: opensQueue ? 'ตรวจสอบรายการ' : credited ? 'เข้าหน้าใช้งาน' : 'เปิดหน้า Player', uri: 'https://liff.line.me/' + liff + '?shop=' + encodeURIComponent(shopId) + (opensQueue ? '&tab=pending' : ''),
        },
      }] };
    }
    const target = await db.rpc('resolve_shop_oa_recipient', { p_shop: shopId, p_member: request.uid });
    if (target.error) console.error('wallet LINE recipient lookup failed');
    if (target.data) {
      try {
        const result = await fetcher('https://api.line.me/v2/bot/message/push', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: target.data, messages: [{ type: 'flex', altText: title, contents: bubble }] }),
          signal: AbortSignal.timeout(3000),
        });
        if (!result.ok) console.error('wallet LINE notification rejected', result.status);
      } catch { console.error('wallet LINE notification unavailable'); }
    }
    const group = shop.data?.admin_group_id || shop.data?.membership_notice_recipient_uid;
    if (request.status === 'Pending' && /^[CUR][0-9a-f]{32}$/i.test(group || '') && group !== target.data &&
        /^\d+-[a-zA-Z0-9]+$/.test(adminLiff)) {
      const adminBubble = { ...bubble, footer: { type: 'box', layout: 'vertical', contents: [{
        type: 'button', style: 'primary', action: {
          type: 'uri', label: 'ตรวจสอบรายการ',
          uri: 'https://liff.line.me/' + adminLiff + '?shop=' + encodeURIComponent(shopId) + '&tab=pending',
        },
      }] } };
      const notice = await fetcher('https://api.line.me/v2/bot/message/push', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: group, messages: [{ type: 'flex', altText: title, contents: adminBubble }] }),
        signal: AbortSignal.timeout(3000),
      });
      if (!notice.ok) console.error('wallet admin LINE notification rejected', notice.status);
    }
  } catch { console.error('wallet LINE notification unavailable'); }
}

export function makeHandler({ env, fetcher = fetch, createDb = createClient }) {
  return async function handle(req) {
    const origin = env('WEB_ORIGIN') || 'https://homefriendmassage-boop.github.io';
    const headers = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Vary': 'Origin', 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'
    };
    const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (req.method === 'OPTIONS') return new Response(null, { headers });
    try {
      if (req.method !== 'POST') fail('METHOD_NOT_ALLOWED', 405);
      if (req.headers.get('origin') && req.headers.get('origin') !== origin) fail('ORIGIN_NOT_ALLOWED', 403);
      if (!(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) fail('UNSUPPORTED_CONTENT_TYPE', 415);
      const raw = await req.text();
      if (raw.length > 65536) fail('REQUEST_TOO_LARGE', 413);
      let input;
      try { input = JSON.parse(raw); } catch (_) { fail('INVALID_JSON'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_JSON');
      if (!['access', 'query', 'membership_summary', 'player_profile', 'player_state', 'player_place_bet', 'player_cancel_bet', 'player_bet_history', 'wallet_request', 'wallet_approve_deposit', 'round_finalize_balanced', 'platform_issue_shop_invite', 'platform_redeem_shop', 'platform_shop_invite_details', 'platform_shop_portal', 'platform_shop_control', 'platform_save_shop_oa', 'platform_save_notice_recipient'].includes(input.action)) fail('INVALID_ACTION');
      const shopId = typeof input.shop_id === 'string' ? input.shop_id.trim() : '';
      if (!['platform_issue_shop_invite', 'platform_redeem_shop', 'platform_shop_invite_details', 'platform_shop_portal', 'platform_shop_control', 'platform_save_shop_oa', 'platform_save_notice_recipient'].includes(input.action) && !/^[\w-]{1,80}$/.test(shopId)) fail('SHOP_INVALID');
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const playerRequest = ['player_profile', 'player_state', 'player_place_bet', 'player_cancel_bet', 'player_bet_history', 'wallet_request'].includes(input.action);
      const channelKey = playerRequest ? 'LINE_CHANNEL_ID_PLAYER' : 'LINE_CHANNEL_ID_ADMIN';
      const clientId = env(channelKey);
      if (!clientId) fail(channelKey + '_MISSING', 503);
      if (!token || token.length > 16000) fail('LINE_AUTH_INVALID', 401);
      const claims = await verifyLineClaims(token, clientId, fetcher, input.action === 'player_state');
      const url = env('SUPABASE_URL');
      const key = serverKey(env);
      if (!url || !key) fail('SUPABASE_SERVER_CONFIG_MISSING', 503);
      const db = createDb(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      const canCreateShop = async () => {
        const configured = (env('SAAS_PLATFORM_ADMIN_UIDS') || '')
          .split(',').some(uid => uid.trim() === claims.sub);
        if (configured) return true;
        const grant = await db.from('platform_shop_admins').select('line_uid')
          .eq('line_uid', claims.sub).maybeSingle();
        return !grant.error && grant.data?.line_uid === claims.sub;
      };
      if (input.action === 'platform_shop_portal') {
        const [membership, canInvite] = await Promise.all([
          db.from('users')
            .select('shop:shops!users_shop_id_fkey(shop_id,shop_name,status,line_oa_token,line_oa_bot_uid)')
            .eq('uid', claims.sub).eq('status', 'Active').in('role', ['Admin', 'Superadmin'])
            .order('shop_id'),
          canCreateShop(),
        ]);
        if (membership.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        const shops = (membership.data ?? []).flatMap(({ shop }) => shop ? [{
          shop_id: shop.shop_id, shop_name: shop.shop_name, status: shop.status,
          oa_configured: Boolean(shop.line_oa_bot_uid || shop.line_oa_token?.trim()),
        }] : []);
        let invitations = [];
        let platformShops = [];
        if (canInvite) {
          const issued = await db.from('platform_shop_invites')
            .select('expires_at,shop_id,referrer_shop_id,shop:shops!platform_shop_invites_shop_id_fkey(shop_name,status)')
            .eq('created_by', claims.sub).order('expires_at', { ascending: false }).limit(50);
          if (issued.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
          invitations = issued.data ?? [];
          const managed = await db.from('shops').select('shop_id,shop_name,status,line_oa_token,line_oa_bot_uid,live_enabled,line_notifications_enabled,membership_notice_recipient_uid').order('shop_id');
          const planRequests = await db.from('platform_shop_plan_requests').select('shop_id,plan_code');
          if (managed.error || planRequests.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
          const plansByShop = new Map((planRequests.data ?? []).map(row => [row.shop_id, row.plan_code]));
          platformShops = (managed.data ?? []).map(({ line_oa_token, line_oa_bot_uid, ...shop }) => ({
            ...shop, oa_configured: Boolean(line_oa_bot_uid || line_oa_token?.trim()),
            requested_plan: plansByShop.get(shop.shop_id) ?? null,
          }));
        }
        return reply({ ok: true, shops, can_invite: canInvite, invitations, platform_shops: platformShops });
      }
      if (input.action === 'platform_save_notice_recipient') {
        if (!await canCreateShop()) fail('PLATFORM_ADMIN_REQUIRED', 403);
        const target = input.target_shop_id;
        const recipient = typeof input.recipient_uid === 'string' ? input.recipient_uid.trim() : '';
        if (typeof target !== 'string' || !/^[\w-]{1,80}$/.test(target) ||
            !/^U[0-9a-f]{32}$/.test(recipient)) fail('NOTICE_RECIPIENT_INVALID');
        const shop = await db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', target).maybeSingle();
        if (shop.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        if (!shop.data?.line_oa_token) fail('SHOP_OA_NOT_READY', 409);
        let profile;
        try {
          profile = await fetcher('https://api.line.me/v2/bot/profile/' + recipient, {
            headers: { Authorization: 'Bearer ' + shop.data.line_oa_token }, signal: AbortSignal.timeout(5000),
          });
        } catch { fail('OA_VERIFY_UNAVAILABLE', 503); }
        if (profile.status === 400 || profile.status === 404) fail('NOTICE_RECIPIENT_NOT_FOUND', 422);
        if (profile.status === 401 || profile.status === 403) fail('OA_TOKEN_INVALID', 422);
        if (!profile.ok) fail('OA_VERIFY_UNAVAILABLE', 503);
        const saved = await db.from('shops').update({ membership_notice_recipient_uid: recipient })
          .eq('shop_id', target).select('shop_id').maybeSingle();
        if (saved.error || !saved.data) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        return reply({ ok: true });
      }
      if (input.action === 'platform_save_shop_oa') {
        if (!await canCreateShop()) fail('PLATFORM_ADMIN_REQUIRED', 403);
        const target = input.target_shop_id;
        const accessToken = typeof input.channel_access_token === 'string' ? input.channel_access_token.trim() : '';
        const secret = typeof input.channel_secret === 'string' ? input.channel_secret.trim() : '';
        if (typeof target !== 'string' || !/^SHOP_[0-9]{3,}$/.test(target) ||
            accessToken.length < 20 || accessToken.length > 4096 || !/^[\x21-\x7e]+$/.test(accessToken) ||
            !/^[0-9a-fA-F]{32}$/.test(secret)) fail('OA_DETAILS_INVALID');
        let response;
        try {
          response = await fetcher('https://api.line.me/v2/bot/info', {
            headers: { Authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(5000),
          });
        } catch { fail('OA_VERIFY_UNAVAILABLE', 503); }
        if (response.status === 401 || response.status === 403) fail('OA_TOKEN_INVALID', 422);
        if (!response.ok) fail('OA_VERIFY_UNAVAILABLE', 503);
        const bot = await response.json();
        if (typeof bot.userId !== 'string' || !/^U[0-9a-f]{32}$/.test(bot.userId)) fail('OA_TOKEN_INVALID', 422);
        const saved = await db.rpc('save_shop_oa', {
          p_shop: target, p_bot: bot.userId, p_token: accessToken, p_secret: secret,
        });
        if (saved.error) fail('OA_SAVE_FAILED', 500);
        if (['OA_ALREADY_LINKED', 'SHOP_NOT_FOUND', 'OA_DETAILS_INVALID'].includes(saved.data)) fail(saved.data, 409);
        if (saved.data !== 'SAVED') fail('OA_SAVE_FAILED', 500);
        return reply({ ok: true });
      }
      if (input.action === 'platform_shop_control') {
        if (!await canCreateShop()) fail('PLATFORM_ADMIN_REQUIRED', 403);
        const target = input.target_shop_id;
        if (typeof target !== 'string' || !/^[\w-]{1,80}$/.test(target)) fail('SHOP_INVALID');
        let values;
        if (input.setting === 'live_enabled' && typeof input.enabled === 'boolean') {
          values = { live_enabled: input.enabled };
        } else if (input.setting === 'line_notifications_enabled' && typeof input.enabled === 'boolean') {
          values = { line_notifications_enabled: input.enabled };
        } else if (input.setting === 'service_enabled' && typeof input.enabled === 'boolean') {
          values = { status: input.enabled ? 'active' : 'Inactive' };
        } else {
          fail('SHOP_SETTING_INVALID');
        }
        let update = db.from('shops').update(values).eq('shop_id', target);
        if (input.setting === 'service_enabled' && input.enabled) {
          update = update.or('line_oa_bot_uid.not.is.null,and(line_oa_token.not.is.null,line_oa_token.neq.)');
        }
        const saved = await update.select('shop_id').maybeSingle();
        if (saved.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        if (!saved.data) fail('SHOP_OR_OA_NOT_READY', 409);
        return reply({ ok: true });
      }
      if (input.action === 'platform_issue_shop_invite') {
        if (!await canCreateShop()) fail('PLATFORM_ADMIN_REQUIRED', 403);

        const referrer = typeof input.referrer_shop_id === 'string' ? input.referrer_shop_id.trim().toUpperCase() : '';
        if (referrer) {
          if (!/^SHOP_[A-Z0-9]{3,24}$/.test(referrer)) {
            fail('REFERRER_INVALID');
          }
          const shop = await db.from('shops').select('shop_id,status').eq('shop_id', referrer).maybeSingle();
          if (shop.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
          if (shop.data?.status?.toLowerCase() !== 'active') fail('REFERRER_INVALID');
        }
        const invite = await db.from('platform_shop_invites').insert({
          created_by: claims.sub, referrer_shop_id: referrer || null,
        })
          .select('invite_id,expires_at').single();
        if (invite.error || !invite.data) fail('INVITE_CREATE_FAILED', 500);
        return reply({ ok: true, invite_id: invite.data.invite_id, expires_at: invite.data.expires_at });
      }
      if (input.action === 'platform_shop_invite_details') {
        const inviteId = input.invite_id;
        if (typeof inviteId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(inviteId)) fail('INVITE_INVALID');
        const invite = await db.from('platform_shop_invites')
          .select('referrer_shop_id,expires_at,shop_id,redeemed_by').eq('invite_id', inviteId).maybeSingle();
        if (invite.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        if (!invite.data) fail('INVITE_INVALID', 404);
        if (invite.data.shop_id && invite.data.redeemed_by !== claims.sub) fail('INVITE_USED', 409);
        if (!invite.data.shop_id && Date.parse(invite.data.expires_at) <= Date.now()) fail('INVITE_EXPIRED', 409);
        return reply({ ok: true, referrer_shop_id: invite.data.referrer_shop_id });
      }
      if (input.action === 'platform_redeem_shop') {
        const invite = typeof input.invite_id === 'string' ? input.invite_id : '';
        const shopName = typeof input.shop_name === 'string' ? input.shop_name.trim() : '';
        const ownerName = typeof input.owner_name === 'string' ? input.owner_name.trim() : '';
        const phone = typeof input.owner_phone === 'string' ? input.owner_phone.replace(/[\s()-]/g, '') : '';
        if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(invite)) fail('INVITE_INVALID');
        if (!shopName || shopName.length > 100 || !ownerName || ownerName.length > 100 ||
            !/^\+?[0-9]{8,15}$/.test(phone) || !/^U[0-9a-f]{32}$/.test(claims.sub)) {
          fail('SHOP_DETAILS_INVALID');
        }
        const plan = input.plan_code;
        const hasPlan = plan !== undefined;
        if (hasPlan && !['free', 'starter', 'basic', 'pro'].includes(plan)) fail('PLAN_INVALID');
        const result = await db.rpc(hasPlan ? 'redeem_platform_shop_invite_with_plan' : 'redeem_platform_shop_invite', {
          p_invite: invite, p_name: shopName, p_owner: claims.sub, p_owner_name: ownerName, p_phone: phone,
          ...(hasPlan ? { p_plan: plan } : {}),
        });
        if (result.error) fail('SHOP_CREATE_FAILED', 500);
        if (['INVITE_INVALID', 'INVITE_EXPIRED', 'INVITE_USED'].includes(result.data?.code)) fail(result.data.code, 409);
        if (result.data?.code !== 'CREATED') fail('SHOP_CREATE_FAILED', 500);
        return reply({ ok: true, shop_id: result.data.shop_id, status: 'Inactive', plan_code: result.data.plan_code });
      }
      if (input.action === 'player_state') {
        const table = input.table_no;
        if (table != null && (typeof table !== 'string' || table.length > 40)) fail('TABLE_INVALID');
        const result = await db.rpc('read_player_live_state', {
          p_shop: shopId, p_uid: claims.sub, p_table: table || null, p_results: input.include_results === true
        });
        if (result.error) fail('PLAYER_STATE_UNAVAILABLE', 500);
        if (!result.data) fail('PLAYER_ACCESS_REQUIRED', 403);
        return reply({ ok: true, snapshot: result.data });
      }
      if (playerRequest) {
        const shop = await db.from('shops').select('status,live_enabled').eq('shop_id', shopId).maybeSingle();
        if (shop.error) fail('DATABASE_ERROR', 500);
        if (String(shop.data?.status).toLowerCase() !== 'active') fail('SHOP_NOT_AVAILABLE', 403);

        const profile = await db.from('users').select(input.action === 'wallet_request' ? 'uid,role,status,member_id,credit_balance,display_name' : 'uid,role,status,member_id,credit_balance')
          .eq('uid', claims.sub).eq('shop_id', shopId).maybeSingle();
        if (profile.error) fail('DATABASE_ERROR', 500);
        const staff = profile.data?.status === 'Active' && ['Admin', 'Superadmin'].includes(profile.data.role);
        const application = await db.from('membership_applications').select('state,member_id')
          .eq('line_uid', claims.sub).eq('shop_id', shopId).maybeSingle();
        if (application.error) fail('DATABASE_ERROR', 500);
        if (application.data?.state !== 'Approved') {
          if (input.action !== 'player_profile') fail('PLAYER_ACCESS_REQUIRED', 403);
          return reply({ ok: true, staff, state: application.data?.state ?? 'NotApplied', member_id: application.data?.member_id ?? null });
        }
        const code = application.data.member_id;
        if (!profile.data || profile.data.member_id !== code || !/^M(0[0-9]{3}|[1-9][0-9]{3,})$/.test(code)) {
          fail('MEMBER_PROFILE_NOT_LINKED', 409);
        }
        if (['player_place_bet', 'player_cancel_bet', 'player_bet_history'].includes(input.action)) {
          if (profile.data.status !== 'Active') fail('PLAYER_ACCESS_REQUIRED', 403);
          if (input.action === 'player_bet_history') {
            const history = await db.from('bets').select('bet_id,round_id,bet_type,amount,payout,status,play_mode,table_no,created_at')
              .eq('shop_id', shopId).eq('uid', claims.sub).order('created_at', { ascending: false }).limit(20);
            if (history.error) fail('BET_HISTORY_UNAVAILABLE', 500);
            return reply({ ok: true, bets: history.data ?? [] });
          }
          const id = input.bet_id;
          if (typeof id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) fail('BET_INVALID');
          if (input.action === 'player_cancel_bet') {
            const result = await db.rpc('cancel_player_private_bet', { p_shop: shopId, p_uid: claims.sub, p_id: id });
            if (result.error) fail('BET_UNAVAILABLE', 500);
            if (result.data !== 'CANCELLED') fail(result.data || 'BET_UNAVAILABLE', 409);
            return reply({ ok: true });
          }
          if (typeof input.round_id !== 'string' || !input.round_id || input.round_id.length > 100 ||
            typeof input.amount !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(input.amount) ||
            !['คู่', 'คี่'].includes(input.bet_type)) fail('BET_INVALID');
          const result = await db.rpc('place_player_private_bet', {
            p_shop: shopId, p_uid: claims.sub, p_round: input.round_id, p_id: id, p_type: input.bet_type, p_amount: input.amount,
          });
          if (result.error) fail('BET_UNAVAILABLE', 500);
          if (result.data?.code === 'BET_LIMIT') return reply({ ok: false, ...result.data }, 409);
          if (result.data?.code !== 'PLACED') fail(result.data?.code || 'BET_UNAVAILABLE', 409);
          return reply({ ok: true, bet_id: result.data.bet_id });
        }
        if (input.action === 'wallet_request') {
          if (profile.data.status !== 'Active') fail('PLAYER_ACCESS_REQUIRED', 403);
          const { type, method, amount, slip_url: slip } = input;
          if (!['ฝากเงิน', 'ถอนเงิน'].includes(type) ||
              !['เงินสด', 'โอนเงิน'].includes(method) || (type === 'ถอนเงิน' && method !== 'โอนเงิน') ||
              typeof amount !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
            fail('WALLET_REQUEST_INVALID');
          }
          const transfer = type === 'ฝากเงิน' && method === 'โอนเงิน';
          const prefix = new URL('/storage/v1/object/public/slips/slips/', url).href + shopId + '_' + claims.sub + '_';
          if (transfer && (typeof slip !== 'string' || !slip.startsWith(prefix) ||
              !/^\d{13}\.[a-z0-9]{1,12}$/i.test(slip.slice(prefix.length)))) fail('WALLET_SLIP_INVALID');
          let feeOption = '-';
          if (type === 'ถอนเงิน') {
            const settings = await db.from('system_settings').select('withdrawal_fee_mode')
              .eq('shop_id', shopId).order('id', { ascending: false }).limit(1).maybeSingle();
            if (settings.error) fail('WALLET_SETTINGS_UNAVAILABLE', 500);
            feeOption = settings.data?.withdrawal_fee_mode === 'none' ? 'ไม่หักค่าน้ำ' : 'หักค่าน้ำ';
          }
          const result = await db.from('topup_requests').insert({
            shop_id: shopId, uid: claims.sub, member_id: code,
            display_name: String(profile.data.display_name || code).replace(/[<>&"']/g, ''),
            type, amount: Number(amount), method, fee_option: feeOption,
            slip_url: transfer ? slip : '', status: 'Pending',
          });
          if (result.error) {
            if (result.error.message === 'WALLET_TRANSFER_REQUIRES_VERIFICATION') fail(result.error.message, 409);
            console.error('wallet request insert error', result.error.code);
            fail('WALLET_REQUEST_UNAVAILABLE', 500);
          }
          await notifyWalletPlayer(db, fetcher, env, shopId, { uid: claims.sub, type, amount, status: 'Pending', member_id: code, display_name: claims.name, profile_pic: claims.picture,
            staff_recipient: ['Admin', 'Superadmin', 'Operator'].includes(profile.data.role) });
          return reply({ ok: true, status: 'Pending' });
        }
        if (input.include_wallet_requests === true) {
          if (profile.data.status !== 'Active') fail('PLAYER_ACCESS_REQUIRED', 403);
          const [requests, credits] = await Promise.all([
            db.from('topup_requests').select('type,amount,status,created_at')
              .eq('shop_id', shopId).eq('uid', claims.sub)
              .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(10),
            db.from('wallet_slip_credits').select('amount,credited_at')
              .eq('shop_id', shopId).eq('uid', claims.sub)
              .order('credited_at', { ascending: false }).order('transaction_ref', { ascending: false }).limit(10),
          ]);
          if (requests.error || credits.error) fail('WALLET_REQUESTS_UNAVAILABLE', 500);
          const automatic = credits.data.map(entry => ({
            type: 'ฝากเงิน', amount: entry.amount, status: 'Approved', created_at: entry.credited_at,
          }));
          const history = [...requests.data, ...automatic]
            .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)).slice(0, 10);
          return reply({ ok: true, wallet_requests: history });
        }
        return reply({ ok: true, staff, state: 'Approved', player: profile.data, live_enabled: shop.data.live_enabled === true });
      }

      // Identity always comes from LINE verification, never from input.uid/role.
      const staff = await db.from('users').select('uid,shop_id,role,status,member_id,display_name').eq('uid', claims.sub).eq('shop_id', shopId).maybeSingle();
      if (staff.error) fail('DATABASE_ERROR', 500);
      if (!staff.data || staff.data.status !== 'Active' || !['Admin', 'Superadmin', 'Operator'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
      const shop = await db.from('shops').select('shop_id,status').eq('shop_id', shopId).maybeSingle();
      if (shop.error) fail('DATABASE_ERROR', 500);
      if (!shop.data || String(shop.data.status).toLowerCase() !== 'active') fail('SHOP_NOT_AVAILABLE', 403);
      if (input.action === 'access') {
        const picture = lineProfilePicture(claims.picture);
        if (picture) await db.from('users').update({ profile_pic: picture }).eq('shop_id', shopId).eq('uid', claims.sub);
        return reply({ ok: true, staff: staff.data, can_create_shop: await canCreateShop() });
      }
      if (input.action === 'round_finalize_balanced') {
        if (typeof input.round_id !== 'string' || !input.round_id || input.round_id.length > 100 ||
            !Number.isFinite(input.weight) || input.weight <= 0 || input.weight > 1000000) fail('ROUND_WEIGHT_INVALID');
        const result = await db.rpc('finalize_balanced_round', {
          p_shop: shopId, p_round: input.round_id, p_weight: input.weight,
        });
        if (result.error) fail('ROUND_FINALIZE_UNAVAILABLE', 500);
        if (!['ENDED', 'RECOVERED'].includes(result.data)) fail(result.data || 'ROUND_FINALIZE_UNAVAILABLE', 409);
        return reply({ ok: true, recovered: result.data === 'RECOVERED' });
      }
      if (input.action === 'wallet_approve_deposit') {
        const id = String(input.request_id ?? '');
        if (!/^(?:\d{1,20}|[a-f0-9-]{36})$/i.test(id)) fail('WALLET_REQUEST_INVALID');
        const approval = await db.rpc('approve_wallet_deposit', {
          p_shop: shopId, p_request: id, p_staff: claims.sub,
        });
        if (approval.error) fail('WALLET_REQUEST_UNAVAILABLE', 500);
        if (approval.data?.code !== 'APPROVED') fail(approval.data?.code || 'WALLET_REQUEST_UNAVAILABLE', 409);
        await notifyWalletPlayer(db, fetcher, env, shopId, approval.data);
        return reply({ ok: true });
      }
      if (input.action === 'membership_summary') {
        if (!['Admin', 'Superadmin'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
        const states = ['Approved', 'Pending', 'Rejected'];
        const results = await Promise.all(states.map(state =>
          db.from('membership_applications').select('id', { count: 'exact', head: true })
            .eq('shop_id', shopId).eq('state', state)
        ));
        if (results.some(result => result.error || typeof result.count !== 'number')) fail('DATABASE_ERROR', 500);
        const counts = Object.fromEntries(states.map((state, index) => [state, results[index].count]));
        counts.Total = counts.Approved + counts.Pending + counts.Rejected;
        return reply({ ok: true, counts });
      }
      const spec = validateQuery(input, staff.data.role, shopId);
      let query = db.from(spec.table);
      if (spec.operation === 'select') query = query.select(spec.columns);
      else if (spec.operation === 'insert') {
        const rows = (Array.isArray(input.values) ? input.values : [input.values]).map(r => ({ ...r, shop_id: shopId }));
        // Reject cross-shop foreign keys, which the current schema does not constrain as composite keys.
        for (const row of rows) {
          for (const [column, table] of [['uid', 'users'], ['round_id', 'rounds']]) {
            if (row[column] && !(spec.table === 'rounds' && column === 'round_id')) {
              const linked = await db.from(table).select(column).eq('shop_id', shopId).eq(column, row[column]).maybeSingle();
              if (linked.error) fail('DATABASE_ERROR', 500);
              if (!linked.data) fail('LINKED_RECORD_NOT_FOUND');
            }
          }
        }
        query = query.insert(rows);
      } else if (spec.operation === 'update') query = query.update(input.values);
      else query = query.delete();
      if (spec.operation !== 'insert') query = query.eq('shop_id', shopId);
      for (const f of spec.filters) query = query[f.op](f.column, f.value);
      const walletDecision = spec.table === 'topup_requests' && spec.operation === 'update' &&
        ['Approved', 'Rejected'].includes(input.values?.status);
      if (walletDecision) query = query.eq('status', 'Pending').select(input.returning ? spec.columns : 'uid,type,amount,status');
      else if (spec.operation !== 'select' && input.returning) query = query.select(spec.columns);
      for (const o of spec.orders) query = query.order(o.column, { ascending: o.ascending });
      if (spec.operation === 'select') query = query.limit(input.limit ?? 1000);
      if (input.single) query = query.single();
      const result = await query;
      if (result.error) {
        if (spec.table === 'tables' && spec.operation === 'insert' && result.error.code === '23505') fail('TABLE_ALREADY_EXISTS', 409);
        console.error('admin-api database error', spec.table, spec.operation, result.error.code);
        fail('ADMIN_DATABASE_ERROR', 500);
      }
      if (walletDecision) {
        const rejectionReason = input.values.status === 'Rejected' && typeof input.rejection_reason === 'string'
          ? input.rejection_reason.trim().slice(0, 300) : '';
        for (const request of result.data ?? []) {
          await notifyWalletPlayer(db, fetcher, env, shopId, { ...request, rejection_reason: rejectionReason });
        }
      }
      const profileLookup = spec.table === 'users' && spec.operation === 'select' && input.limit === 2 &&
        spec.filters.some(filter => filter.op === 'eq' && ['uid', 'member_id'].includes(filter.column));
      if (profileLookup && Array.isArray(result.data) && result.data.length === 1 &&
          !result.data[0].profile_pic && /^U[0-9a-f]{32}$/i.test(result.data[0].uid)) {
        const user = result.data[0];
        const credential = await db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', shopId).maybeSingle();
        if (credential.data?.line_oa_token) {
          try {
            const response = await fetcher('https://api.line.me/v2/bot/profile/' + user.uid, {
              headers: { Authorization: 'Bearer ' + credential.data.line_oa_token },
              signal: AbortSignal.timeout(3000)
            });
            const picture = response.ok ? lineProfilePicture((await response.json()).pictureUrl) : null;
            if (picture) {
              user.profile_pic = picture;
              await db.from('users').update({ profile_pic: picture }).eq('shop_id', shopId).eq('uid', user.uid);
            }
          } catch { /* A missing OA profile must not block member search. */ }
        }
      }
      return reply({ ok: true, data: walletDecision && !input.returning ? null : result.data });
    } catch (e) {
      if (!e.status) console.error('admin-api unexpected error', e.name);
      return reply({ ok: false, code: e.status ? e.message : 'SERVER_ERROR' }, e.status || 500);
    }
  };
}

Deno.serve(makeHandler({ env: name => Deno.env.get(name) }));

function formatMemberCode(shopId, memberId) {
  const shop = /^SHOP_([0-9]{3,})$/.exec(String(shopId ?? ''));
  const member = /^M([0-9]{4,})$/.exec(String(memberId ?? ''));
  if (!shop || !member) return memberId;
  return 'M' + (shop[1] === '000' ? '' : shop[1]) + '-' + member[1];
}
