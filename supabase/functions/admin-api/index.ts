// Separate from member-approval. Deploy with verify_jwt=false: LINE verifies tokens below.
// Required secrets: LINE_CHANNEL_ID_ADMIN, WEB_ORIGIN (origin only), and a Supabase server key.
import { createClient } from 'npm:@supabase/supabase-js@2';

const fields = {
  users: 'uid shop_id member_id display_name profile_pic role status credit_balance total_deposit commission_balance referrer_uid backer_share backer_water_fee backer_wallet created_at',
  tables: 'id shop_id table_no credit created_at cash_limit table_name is_open is_hidden',
  rounds: 'round_id shop_id status weight result created_at end_time_ms resolver_type',
  bets: 'bet_id shop_id round_id uid table_no bet_type amount status play_mode payout created_at cash_table',
  backer_logs: 'id shop_id round_id uid member_id share_percent gap_amount result_status pnl_amount water_fee_deducted wallet_balance_after created_at',
  transactions: 'id shop_id target_id type amount admin_name target_type created_at cash_table_no',
  topup_requests: 'id shop_id uid member_id display_name type amount method fee_option slip_url status withdrawal_confirmation_id wallet_slip_id admin_name created_at',
  system_settings: 'id shop_id water_margin min_bet max_bet round_duration comm_rate withdrawal_fee_mode created_at'
};
const writes = {
  users: { update: 'backer_share backer_water_fee' },
  tables: { insert: 'shop_id table_no credit', update: 'cash_limit table_name is_open is_hidden', delete: '' },
  rounds: { insert: 'shop_id round_id status end_time_ms resolver_type', update: 'status end_time_ms resolver_type' },
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

const shopInviteIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

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

const owners = ['Admin', 'Superadmin'];
const managers = [...owners, 'Cashier'];
const tableStaff = [...managers, 'Operator'];
const playerRoles = [...owners, 'Operator', 'Promoter', 'Customer', 'Backer'];
const referralRoles = [...managers, 'Promoter'];
const staffActions = {
  Operator: ['table_overview', 'table_qr', 'table_cash_bet', 'table_cash_payment'],
  Cashier: ['table_overview', 'table_qr', 'table_cash_bet', 'table_cash_payment', 'table_bulk_create',
    'table_cash_report', 'table_send_cash_report', 'round_finalize_balanced', 'membership_summary',
    'wallet_approve_deposit', 'wallet_approve_withdrawal', 'wallet_reject', 'adjust_balance'],
  Admin: ['table_overview', 'table_qr', 'table_cash_bet', 'table_cash_payment', 'table_bulk_create',
    'table_cash_report', 'table_send_cash_report', 'round_finalize_balanced', 'membership_summary',
    'wallet_approve_deposit', 'wallet_approve_withdrawal', 'wallet_reject', 'adjust_balance',
    'role_directory', 'role_history', 'role_change', 'cancel_bill'],
};
const roleOf = row => row?.status === 'Active' ? row.role : null;
const loadMember = (db, shop, uid, columns = 'uid,shop_id,role,status,member_id,display_name') =>
  db.from('users').select(columns).eq('shop_id', shop).eq('uid', uid).maybeSingle();

export function validateQuery(input, role, shopId) {
  const { table, operation = 'select' } = input;
  if (!Object.hasOwn(fields, table)) fail('TABLE_NOT_ALLOWED', 403);
  if (!['select', 'insert', 'update', 'delete'].includes(operation)) fail('OPERATION_NOT_ALLOWED', 403);
  if (!tableStaff.includes(role)) fail('ADMIN_REQUIRED', 403);
  if (role === 'Operator' && (table !== 'tables' || operation !== 'select')) fail('ADMIN_REQUIRED', 403);
  if (role === 'Cashier' && operation !== 'select' && !['tables', 'rounds'].includes(table)) fail('ADMIN_REQUIRED', 403);
  if (role === 'Cashier' && table === 'users' && operation === 'select') {
    const reportingFields = 'uid,display_name,backer_water_fee';
    if (input.columns !== reportingFields && input.columns !== 'uid, display_name, backer_water_fee') fail('COLUMN_NOT_ALLOWED', 403);
  }
  const columns = input.columns === '*' || input.columns === undefined ? fields[table].split(' ') : String(input.columns).split(',').map(s => s.trim());
  if (!columns.length || columns.some(c => !includes(fields[table], c))) fail('COLUMN_NOT_ALLOWED', 403);
  const filters = input.filters ?? [];
  const orders = input.orders ?? [];
  if (!Array.isArray(filters) || filters.length > 16 || !Array.isArray(orders) || orders.length > 4) fail('QUERY_INVALID');
  for (const f of filters) {
    if (!f || !includes(fields[table], f.column) || !['eq', 'neq', 'gte', 'lte', 'lt', 'like', 'in'].includes(f.op)) fail('FILTER_INVALID');
    if (f.op === 'in' ? !Array.isArray(f.value) || f.value.length > 100 || f.value.some(v => !primitive(v)) : !primitive(f.value)) fail('FILTER_INVALID');
    if (f.column === 'shop_id' && (f.op !== 'eq' || f.value !== shopId)) fail('SHOP_MISMATCH', 403);
  }
  for (const o of orders) if (!o || !includes(fields[table], o.column) || typeof o.ascending !== 'boolean') fail('ORDER_INVALID');
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000)) fail('LIMIT_INVALID');
  if (operation !== 'select') {
    const allowed = writes[table]?.[operation];
    if (allowed === undefined) fail('WRITE_NOT_ALLOWED', 403);
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
          if (['backer_share','backer_water_fee'].includes(key) && (typeof value !== 'number' || value < 0 || value > 100)) fail('AMOUNT_INVALID');
          if (table === 'tables' && key === 'table_no' && (typeof value !== 'string' || !/^\d{1,8}$/.test(value))) fail('TABLE_INVALID');
          if (key === 'cash_limit' && value !== null &&
              (typeof value !== 'number' || value < 0.01 || value > 999999999)) fail('AMOUNT_INVALID');
          if (key === 'table_name' && value !== null &&
              (typeof value !== 'string' || !value.trim() || value.length > 40)) fail('TABLE_NAME_INVALID');
          if (['is_open', 'is_hidden'].includes(key) && typeof value !== 'boolean') fail('TABLE_INVALID');
          if (table === 'tables' && key === 'credit' && value !== 0) fail('AMOUNT_INVALID');
          if (table === 'rounds' && key === 'status' && !['Open', 'Closed'].includes(value)) fail('STATUS_INVALID');
          if (table === 'rounds' && key === 'resolver_type' && ![null, 'none', 'backer', 'shop'].includes(value)) fail('STATUS_INVALID');
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
    const shop = await db.from('shop_oa_runtime').select('line_oa_token,liff_id_admin,admin_group_id,line_notifications_enabled,membership_notice_recipient_uid').eq('shop_id', shopId).maybeSingle();
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
    const uri = opensQueue
      ? 'https://liff.line.me/' + adminLiff + '?shop=' + encodeURIComponent(shopId) + '&tab=pending'
      : 'https://liff.line.me/2012454809-UFGeUGbW?shop=' + encodeURIComponent(shopId);
    if (!opensQueue || /^\d+-[a-zA-Z0-9]+$/.test(adminLiff)) {
      bubble.footer = { type: 'box', layout: 'vertical', contents: [{
        type: 'button', style: 'primary', ...(rejectedDeposit ? { color: '#B91C1C' } : {}), action: {
          type: 'uri', label: opensQueue ? 'ตรวจสอบรายการ' : credited ? 'เข้าหน้าใช้งาน' : 'เปิดหน้า Player', uri,
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
  } catch { console.error('wallet LINE notification unavailable'); }
}

export function makeHandler({ env, fetcher = fetch, createDb = createClient }) {
  const entryAccounts = new Map();
  function database() {
    const url = env('SUPABASE_URL');
    const key = serverKey(env);
    if (!url || !key) fail('SUPABASE_SERVER_CONFIG_MISSING', 503);
    return createDb(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  function tableDay() {
    return new Date(Date.now() + 3600000).toISOString().slice(0, 10);
  }

  async function tableQrSignature(shop, table, day) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(serverKey(env)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(['cash-table', shop, table, day])));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function playerEntry(shopId) {
    if (!/^SHOP_[0-9]{3,24}$/.test(shopId)) fail('SHOP_INVALID');
    const db = database();
    const [shop, runtime] = await Promise.all([
      db.from('shops').select('shop_name,status,line_oa_bot_uid').eq('shop_id', shopId).maybeSingle(),
      db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', shopId).maybeSingle(),
    ]);
    if (shop.error || runtime.error) fail('DATABASE_ERROR', 500);
    if (shop.data?.status !== 'active') fail('SHOP_NOT_AVAILABLE', 404);
    const details = { ok: true, shop_name: shop.data.shop_name, add_friend_url: null };
    const token = runtime.data?.line_oa_token?.trim();
    if (!token) return details;

    const bot = shop.data.line_oa_bot_uid;
    const cached = entryAccounts.get(shopId);
    if (cached && cached.bot === bot && cached.until > Date.now()) {
      return { ...details, add_friend_url: cached.url };
    }
    try {
      const response = await fetcher('https://api.line.me/v2/bot/info', {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) return details;
      const info = await response.json();
      if ((bot && info.userId !== bot) || typeof info.basicId !== 'string' ||
          !/^@[a-zA-Z0-9._-]{1,40}$/.test(info.basicId)) return details;
      const url = 'https://line.me/R/ti/p/' + encodeURIComponent(info.basicId);
      if (entryAccounts.size >= 256) entryAccounts.delete(entryAccounts.keys().next().value);
      entryAccounts.set(shopId, { bot, url, until: Date.now() + 60000 });
      return { ...details, add_friend_url: url };
    } catch {
      return details;
    }
  }

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
      const shopId = typeof input.shop_id === 'string' ? input.shop_id.trim() : '';
      if (input.action === 'player_entry') return reply(await playerEntry(shopId));
      if (!['access', 'query', 'membership_summary', 'referral_profile', 'backer_profile', 'commission_request', 'role_directory', 'role_history', 'role_change', 'cancel_bill', 'adjust_balance', 'wallet_reject', 'table_overview', 'player_profile', 'player_state', 'player_place_bet', 'player_cancel_bet', 'player_bet_history', 'wallet_request', 'wallet_approve_deposit', 'wallet_approve_withdrawal', 'round_finalize_balanced', 'table_bulk_create', 'table_qr', 'table_cash_payment', 'table_cash_report', 'table_cash_bet', 'table_send_cash_report', 'platform_issue_shop_invite', 'platform_redeem_shop', 'platform_shop_invite_details', 'platform_shop_portal', 'platform_shop_control', 'platform_save_shop_oa', 'platform_save_notice_recipient', 'platform_capture_notice'].includes(input.action)) fail('INVALID_ACTION');
      if (!['platform_issue_shop_invite', 'platform_redeem_shop', 'platform_shop_invite_details', 'platform_shop_portal', 'platform_shop_control', 'platform_save_shop_oa', 'platform_save_notice_recipient', 'platform_capture_notice'].includes(input.action) && !/^[\w-]{1,80}$/.test(shopId)) fail('SHOP_INVALID');
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const playerRequest = ['player_profile', 'player_state', 'player_place_bet', 'player_cancel_bet', 'player_bet_history', 'wallet_request'].includes(input.action);
      const channelKey = (playerRequest || ['referral_profile', 'backer_profile', 'commission_request'].includes(input.action)) ? 'LINE_CHANNEL_ID_PLAYER' : 'LINE_CHANNEL_ID_ADMIN';
      const shopLogin = input.shop_login === true;
      if (shopLogin && (!playerRequest || shopId !== 'SHOP_001')) fail('SHOP_LOGIN_NOT_ALLOWED', 403);
      const clientId = shopLogin ? '2009043114' : env(channelKey);
      if (!clientId) fail(channelKey + '_MISSING', 503);
      if (!token || token.length > 16000) fail('LINE_AUTH_INVALID', 401);
      const identity = await verifyLineClaims(token, clientId, fetcher, input.action === 'player_state');
      const db = database();
      let claims = identity;
      if (shopLogin) {
        if (!/^U[0-9a-f]{32}$/i.test(identity.sub)) fail('LINE_AUTH_INVALID', 401);
        const mapping = await db.rpc('resolve_shop_oa_member', { p_shop: shopId, p_oa_uid: identity.sub });
        if (mapping.error) fail('DATABASE_ERROR', 500);
        if (!mapping.data) fail('OA_ACCOUNT_NOT_LINKED', 403);
        claims = { ...identity, sub: mapping.data };
      }
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
            .select('member_id,shop:shops!users_shop_id_fkey(shop_id,shop_name,status,line_oa_token,line_oa_bot_uid)')
            .eq('uid', claims.sub).eq('status', 'Active').in('role', ['Admin', 'Superadmin'])
            .order('shop_id'),
          canCreateShop(),
        ]);
        if (membership.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        if (!canInvite && !membership.data?.length) fail('ACCESS_DENIED', 403);
        const shops = (membership.data ?? []).flatMap(({ shop, member_id }) => shop ? [{
          shop_id: shop.shop_id, shop_name: shop.shop_name, status: shop.status,
          oa_configured: Boolean(shop.line_oa_bot_uid || shop.line_oa_token?.trim()),
          can_manage_billing: member_id === 'M0000' && shop.shop_id !== 'SHOP_000',
          can_refer_shop: member_id === 'M0000' && String(shop.status).toLowerCase() === 'active',
        }] : []);
        let planQuery = db.from('platform_shop_plan_requests')
          .select('shop_id,plan_code,trial_started_at,trial_ends_at');
        if (!canInvite && shops.length) planQuery = planQuery.in('shop_id', shops.map(shop => shop.shop_id));
        let billingQuery = db.from('platform_billing_state').select('shop_id,plan_code,paid_until');
        if (!canInvite && shops.length) billingQuery = billingQuery.in('shop_id', shops.map(shop => shop.shop_id));
        const [planRequests, paidPlans] = (canInvite || shops.length)
          ? await Promise.all([planQuery, billingQuery]) : [{ data: [] }, { data: [] }];
        if (planRequests.error || paidPlans.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        const plansByShop = new Map((planRequests.data ?? []).map(row => [row.shop_id, row]));
        const paidByShop = new Map((paidPlans.data ?? []).map(row => [row.shop_id, row]));
        const now = Date.now();
        const planDetails = shopId => {
          const plan = plansByShop.get(shopId);
          const trialEnd = plan?.trial_ends_at ?? null;
          const paid = paidByShop.get(shopId);
          return {
            current_plan: paid?.plan_code ?? null,
            paid_until: paid?.paid_until ?? null,
            requested_plan: plan?.plan_code ?? null,
            trial_ends_at: trialEnd,
            trial_state: plan?.plan_code !== 'free' ? null :
              trialEnd ? (Date.parse(trialEnd) > now ? 'active' : 'expired') : 'pending',
          };
        };
        let invitations = [];
        let platformShops = [];
        if (canInvite || shops.some(shop => shop.can_refer_shop)) {
          const issued = await db.from('platform_shop_invites')
            .select('expires_at,shop_id,referrer_shop_id,shop:shops!platform_shop_invites_shop_id_fkey(shop_name,status)')
            .eq('created_by', claims.sub).order('expires_at', { ascending: false }).limit(50);
          if (issued.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
          invitations = issued.data ?? [];
        }
        if (canInvite) {
          const managed = await db.from('shops').select('shop_id,shop_name,status,line_oa_token,line_oa_bot_uid,live_enabled,line_notifications_enabled,membership_notice_recipient_uid,admin_group_id').order('shop_id');
          if (managed.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
          platformShops = (managed.data ?? []).map(({ line_oa_token, line_oa_bot_uid, ...shop }) => ({
            ...shop, oa_configured: Boolean(line_oa_bot_uid || line_oa_token?.trim()),
            ...planDetails(shop.shop_id),
          }));
        }
        return reply({
          ok: true, shops: shops.map(shop => ({ ...shop, ...planDetails(shop.shop_id) })),
          can_invite: canInvite, invitations, platform_shops: platformShops
        });
      }
      if (['platform_capture_notice', 'platform_save_notice_recipient'].includes(input.action)) {
        if (!await canCreateShop()) fail('PLATFORM_ADMIN_REQUIRED', 403);
        const target = input.target_shop_id;
        if (typeof target !== 'string' || !/^SHOP_[0-9]{3,24}$/.test(target)) fail('SHOP_INVALID');

        if (input.action === 'platform_capture_notice') {
          if (!['owner', 'group'].includes(input.kind)) fail('NOTICE_RECIPIENT_INVALID');
          if (input.code !== undefined) {
            if (!shopInviteIdPattern.test(input.code)) fail('NOTICE_RECIPIENT_INVALID');
            const capture = await db.from('shop_notice_capture').select('recipient_id,expires_at')
              .eq('code', input.code).eq('shop_id', target).eq('created_by', claims.sub).eq('kind', input.kind).maybeSingle();
            if (capture.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
            if (!capture.data || Date.parse(capture.data.expires_at) <= Date.now()) fail('NOTICE_CAPTURE_EXPIRED', 409);
            return reply({ ok: true, recipient_id: capture.data.recipient_id });
          }
          const runtime = await db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', target).maybeSingle();
          if (runtime.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
          if (!runtime.data?.line_oa_token) fail('SHOP_OA_NOT_READY', 409);
          const code = crypto.randomUUID();
          const capture = await db.from('shop_notice_capture').upsert({
            code, shop_id: target, created_by: claims.sub, kind: input.kind, recipient_id: null,
            expires_at: new Date(Date.now() + 600000).toISOString(),
          }, { onConflict: 'shop_id,created_by,kind' });
          if (capture.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
          return reply({ ok: true, code });
        }

        const recipient = typeof input.recipient_uid === 'string' ? input.recipient_uid.trim() : null;
        const group = typeof input.group_id === 'string' ? input.group_id.trim() : null;
        if (recipient === null || (recipient && !/^U[0-9a-f]{32}$/.test(recipient)) ||
            (group && !/^C[0-9a-f]{32}$/.test(group))) fail('NOTICE_RECIPIENT_INVALID');
        const runtime = await db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', target).maybeSingle();
        if (runtime.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        if ((recipient || group) && !runtime.data?.line_oa_token) fail('SHOP_OA_NOT_READY', 409);
        for (const [id, path, error] of [
          [recipient, 'profile/' + recipient, 'NOTICE_RECIPIENT_NOT_FOUND'],
          [group, 'group/' + group + '/summary', 'NOTICE_GROUP_NOT_FOUND'],
        ]) {
          if (!id) continue;
          let verified;
          try {
            verified = await fetcher('https://api.line.me/v2/bot/' + path, {
              headers: { Authorization: 'Bearer ' + runtime.data.line_oa_token }, signal: AbortSignal.timeout(5000),
            });
          } catch { fail('OA_VERIFY_UNAVAILABLE', 503); }
          if (verified.status === 400 || verified.status === 404 || (id === group && verified.status === 403)) fail(error, 422);
          if (verified.status === 401 || verified.status === 403) fail('OA_TOKEN_INVALID', 422);
          if (!verified.ok) fail('OA_VERIFY_UNAVAILABLE', 503);
        }
        const values = { membership_notice_recipient_uid: recipient || null };
        if (group !== null) values.admin_group_id = group || null;
        const saved = await db.from('shops').update(values).eq('shop_id', target).select('shop_id').maybeSingle();
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
          const plan = await db.from('platform_shop_plan_requests').select('plan_code')
            .eq('shop_id', target).maybeSingle();
          if (plan.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
          if (plan.data?.plan_code !== 'free') {
            update = update.or('line_oa_bot_uid.not.is.null,and(line_oa_token.not.is.null,line_oa_token.neq.)');
          }
        }
        const saved = await update.select('shop_id').maybeSingle();
        if (saved.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        if (!saved.data) fail('SHOP_OR_OA_NOT_READY', 409);
        return reply({ ok: true });
      }
      if (input.action === 'platform_issue_shop_invite') {
        const referrer = typeof input.referrer_shop_id === 'string' ? input.referrer_shop_id.trim().toUpperCase() : '';
        if (!/^SHOP_[A-Z0-9]{3,24}$/.test(referrer)) fail('REFERRER_INVALID');
        const [shop, owner] = await Promise.all([
          db.from('shops').select('status').eq('shop_id', referrer).maybeSingle(),
          db.from('users').select('uid').eq('shop_id', referrer).eq('uid', claims.sub)
            .eq('member_id', 'M0000').eq('status', 'Active').in('role', ['Admin', 'Superadmin']).maybeSingle(),
        ]);
        if (shop.error || owner.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
        if (!owner.data || String(shop.data?.status).toLowerCase() !== 'active') fail('REFERRER_INVALID', 403);
        const invite = await db.from('platform_shop_invites').insert({
          created_by: claims.sub, referrer_shop_id: referrer, referral_tier: 'standard',
        })
          .select('invite_id,expires_at').single();
        if (invite.error || !invite.data) fail('INVITE_CREATE_FAILED', 500);
        return reply({ ok: true, invite_id: invite.data.invite_id, expires_at: invite.data.expires_at });
      }
      if (input.action === 'platform_shop_invite_details') {
        const inviteId = input.invite_id;
        if (typeof inviteId !== 'string' || !shopInviteIdPattern.test(inviteId)) fail('INVITE_INVALID');
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
        if (!shopInviteIdPattern.test(invite)) fail('INVITE_INVALID');
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
      if (['referral_profile', 'backer_profile', 'commission_request'].includes(input.action)) {
        const [profile, shop] = await Promise.all([
          loadMember(db, shopId, claims.sub, 'uid,member_id,display_name,profile_pic,role,status,commission_balance,backer_wallet,backer_share,backer_water_fee'),
          db.from('shops').select('status').eq('shop_id', shopId).maybeSingle(),
        ]);
        if (profile.error || shop.error) fail('DATABASE_ERROR', 500);
        const role = roleOf(profile.data);
        const allowed = input.action === 'backer_profile' ? role === 'Backer' : referralRoles.includes(role);
        if (!allowed || String(shop.data?.status).toLowerCase() !== 'active') fail('ACCESS_DENIED', 403);
        const { member_id, display_name, commission_balance } = profile.data;
        if (input.action === 'referral_profile') return reply({ ok: true, profile: { member_id, display_name, commission_balance, role } });
        if (input.action === 'commission_request') {
          if (!shopInviteIdPattern.test(input.request_id) || !['cash','credit'].includes(input.type) ||
              !/^\d{1,9}(?:\.\d{1,2})?$/.test(input.amount || '')) fail('AMOUNT_INVALID');
          const result = await db.rpc('request_promoter_commission', { p_shop: shopId, p_uid: claims.sub,
            p_id: input.request_id, p_type: input.type, p_amount: input.amount });
          if (result.error) fail('WALLET_REQUEST_UNAVAILABLE', 500);
          if (result.data !== 'QUEUED') fail(result.data, 409);
          return reply({ ok: true });
        }
        const logs = await db.from('backer_logs').select(fields.backer_logs.split(' ').join(','))
          .eq('shop_id', shopId).eq('uid', claims.sub).order('created_at', { ascending: false }).limit(20);
        if (logs.error) fail('DATABASE_ERROR', 500);
        return reply({ ok: true, profile: profile.data, logs: logs.data });
      }
      if (input.action === 'player_state') {
        const profile = await loadMember(db, shopId, claims.sub, 'role,status');
        if (profile.error) fail('DATABASE_ERROR', 500);
        if (!playerRoles.includes(roleOf(profile.data))) fail('ACCESS_DENIED', 403);
        const table = input.table_no;
        if (table != null && (typeof table !== 'string' || table.length > 40)) fail('TABLE_INVALID');
        const validTable = table && input.table_day === tableDay() &&
          input.table_token === await tableQrSignature(shopId, table, input.table_day);
        const result = await db.rpc('read_player_live_state', {
          p_shop: shopId, p_uid: claims.sub, p_table: validTable ? table : null, p_results: input.include_results === true
        });
        if (result.data && validTable) {
          const [desk, total] = await Promise.all([
            db.from('tables').select('table_name,is_open,is_hidden,cash_limit')
              .eq('shop_id', shopId).eq('table_no', table).maybeSingle(),
            result.data.round?.round_id
              ? db.rpc('cash_table_round_total', { p_shop: shopId, p_table: table, p_round: result.data.round.round_id })
              : { data: 0 },
          ]);
          if (desk.error || total.error) fail('PLAYER_STATE_UNAVAILABLE', 500);
          result.data.table_round_total = total.data;
          result.data.table_name = desk.data?.table_name ?? null;
          result.data.table_open = Boolean(desk.data?.is_open && !desk.data?.is_hidden && desk.data?.cash_limit);
        }
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
        if (profile.data && !playerRoles.includes(roleOf(profile.data))) fail('ACCESS_DENIED', 403);
        const staff = [...owners,'Operator'].includes(roleOf(profile.data));
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
          const params = {
            p_shop: shopId, p_uid: claims.sub, p_round: input.round_id, p_id: id, p_type: input.bet_type, p_amount: input.amount,
          };
          const table = input.table_no;
          if (table !== undefined) {
            if (typeof table !== 'string' || !/^\d{1,8}$/.test(table)) fail('BET_INVALID');
            if (input.table_day !== tableDay()) fail('TABLE_QR_EXPIRED', 409);
            if (input.table_token !== await tableQrSignature(shopId, table, input.table_day)) fail('TABLE_QR_INVALID', 403);
          }
          const result = table === undefined
            ? await db.rpc('place_player_private_bet', params)
            : await db.rpc('place_player_cash_table_bet', { ...params, p_table: table, p_day: input.table_day, p_staff: false });
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
          if (transfer) {
            const prefix = new URL('/storage/v1/object/public/slips/slips/', env('SUPABASE_URL')).href + shopId + '_' + claims.sub + '_';
            if (typeof slip !== 'string' || !slip.startsWith(prefix) ||
                !/^\d{13}\.[a-z0-9]{1,12}$/i.test(slip.slice(prefix.length))) fail('WALLET_SLIP_INVALID');
          }
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
      const staff = await loadMember(db, shopId, claims.sub);
      if (staff.error) fail('DATABASE_ERROR', 500);
      const role = roleOf(staff.data);
      if (![...tableStaff, 'Promoter'].includes(role)) fail('ADMIN_REQUIRED', 403);
      const shop = await db.from('shops').select('shop_id,status').eq('shop_id', shopId).maybeSingle();
      if (shop.error) fail('DATABASE_ERROR', 500);
      if (String(shop.data?.status).toLowerCase() !== 'active') fail('SHOP_NOT_AVAILABLE', 403);
      if (input.action === 'access') {
        return reply({ ok: true, staff: staff.data, can_create_shop: await canCreateShop() });
      }
      const allowed = staffActions[role === 'Superadmin' ? 'Admin' : role];
      if (!(allowed?.includes(input.action) || (input.action === 'query' && tableStaff.includes(role)))) fail('ADMIN_REQUIRED', 403);

      if (input.action === 'role_directory' || input.action === 'role_history') {
        const page = input.page ?? 0;
        if (!Number.isInteger(page) || page < 0 || page > 10000) fail('PAGE_INVALID');
        const history = input.action === 'role_history';
        const result = await db.from(history ? 'shop_role_audit' : 'users')
          .select(history ? 'uid,actor_uid,old_role,new_role,old_status,new_status,created_at' : 'uid,member_id,display_name,role,status')
          .eq('shop_id', shopId).order(history ? 'id' : 'uid', { ascending: !history })
          .range(page * 50, page * 50 + 49);
        if (result.error) fail('DATABASE_ERROR', 500);
        return reply({ ok: true, data: result.data });
      }
      if (input.action === 'role_change') {
        if (typeof input.target_uid !== 'string' || !input.target_uid || input.target_uid.length > 100 ||
            (input.role != null && !['Admin','Cashier','Operator','Promoter','Customer','Backer'].includes(input.role)) ||
            (input.status != null && !['Active','Inactive'].includes(input.status)) ||
            (input.role == null && input.status == null)) fail('ROLE_INVALID');
        const result = await db.rpc('set_shop_member_access', { p_shop: shopId, p_actor: claims.sub,
          p_uid: input.target_uid, p_role: input.role ?? null, p_status: input.status ?? null });
        if (result.error) fail('ROLE_CHANGE_UNAVAILABLE', 500);
        if (result.data !== 'SAVED') fail(result.data, 409);
        return reply({ ok: true });
      }
      if (input.action === 'cancel_bill') {
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        if (!shopInviteIdPattern.test(input.bet_id) || !reason || reason.length > 300) fail('BILL_INVALID');
        const result = await db.rpc('cancel_shop_bill', { p_shop: shopId, p_actor: claims.sub, p_id: input.bet_id, p_reason: reason });
        if (result.error) fail('BILL_CANCEL_UNAVAILABLE', 500);
        if (result.data !== 'CANCELLED') fail(result.data, 409);
        return reply({ ok: true });
      }
      if (input.action === 'adjust_balance') {
        const target = input.target;
        if (!['table','user'].includes(input.target_type) || typeof target !== 'string' || !target || target.length > 80 ||
            !shopInviteIdPattern.test(input.request_id) || !['deposit','withdraw'].includes(input.type) ||
            !/^\d{1,9}(?:\.\d{1,2})?$/.test(input.amount || '')) fail('AMOUNT_INVALID');
        if (role === 'Cashier' && (input.target_type !== 'table' || input.type !== 'deposit')) fail('ADMIN_REQUIRED', 403);
        const result = await db.rpc('adjust_shop_balance', { p_shop: shopId, p_actor: claims.sub,
          p_id: input.request_id, p_target: target, p_target_type: input.target_type, p_type: input.type, p_amount: input.amount });
        if (result.error) fail('WALLET_REQUEST_UNAVAILABLE', 500);
        if (result.data?.code !== 'RECORDED') fail(result.data?.code || 'WALLET_REQUEST_UNAVAILABLE', 409);
        return reply({ ok: true, balance: result.data.balance });
      }
      if (input.action === 'wallet_reject') {
        const id = String(input.request_id ?? '');
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        if (!/^\d{1,20}$/.test(id) || !reason || reason.length > 300) fail('WALLET_REQUEST_INVALID');
        const result = await db.rpc('reject_shop_wallet_request', { p_shop: shopId, p_actor: claims.sub, p_request: id, p_reason: reason });
        if (result.error) fail('WALLET_REQUEST_UNAVAILABLE', 500);
        if (result.data?.code !== 'REJECTED') fail(result.data?.code || 'WALLET_REQUEST_UNAVAILABLE', 409);
        await notifyWalletPlayer(db, fetcher, env, shopId, result.data);
        return reply({ ok: true });
      }
      if (input.action === 'table_overview') {
        const round = await db.from('rounds').select('round_id,status,end_time_ms').eq('shop_id', shopId)
          .order('created_at', { ascending: false }).order('round_id', { ascending: false }).limit(1);
        if (round.error) fail('DATABASE_ERROR', 500);
        if (!round.data?.length) return reply({ ok: true, round: null, bets: [] });
        const current = round.data[0];
        const bets = await db.from('bets').select('table_no,amount,cash_table,status').eq('shop_id', shopId)
          .eq('round_id', current.round_id).eq('play_mode', 'table').neq('status', 'Cancelled');
        if (bets.error) fail('DATABASE_ERROR', 500);
        return reply({ ok: true, round: current, bets: bets.data });
      }
      if (['table_cash_report', 'table_send_cash_report'].includes(input.action)) {
        if (typeof input.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)) fail('TABLE_DATE_INVALID');
        const result = await db.rpc('cash_table_daily_report', { p_shop: shopId, p_day: input.day });
        if (result.error) fail('TABLE_REPORT_UNAVAILABLE', 500);
        if (input.action === 'table_cash_report') return reply({ ok: true, tables: result.data });
        const runtime = await db.from('shop_oa_runtime').select('line_oa_token,admin_group_id,membership_notice_recipient_uid,line_notifications_enabled')
          .eq('shop_id', shopId).maybeSingle();
        if (runtime.error) fail('TABLE_REPORT_UNAVAILABLE', 500);
        const settings = runtime.data;
        const recipient = settings?.admin_group_id || settings?.membership_notice_recipient_uid;
        if (!settings?.line_oa_token || settings.line_notifications_enabled === false ||
            !/^[CU][0-9a-f]{32}$/.test(recipient || '')) fail('TABLE_REPORT_LINE_NOT_READY', 409);
        const amount = value => Number(value).toLocaleString('th-TH', { maximumFractionDigits: 2 });
        const lines = (result.data ?? []).map(row => 'โต๊ะ ' + row.table_no + ' · ลง ฿' + amount(row.played) +
          ' · ชนะ ฿' + amount(row.won) + ' · รับสด ฿' + amount(row.received) + ' · จ่ายสด ฿' + amount(row.paid));
        const report = ['รายงานเงินสด ' + shopId, 'วันที่บัญชี ' + input.day + ' · 06:00 ถึงก่อน 06:00 วันถัดไป',
          ...(lines.length ? lines : ['ไม่มีรายการเงินสด'])].join('\n');
        if (report.length > 5000) fail('TABLE_REPORT_TOO_LONG', 409);
        if (typeof input.delivery_id !== 'string' || !shopInviteIdPattern.test(input.delivery_id)) fail('TABLE_REPORT_UNAVAILABLE', 400);
        const sent = await fetcher('https://api.line.me/v2/bot/message/push', {
          method: 'POST', headers: { Authorization: 'Bearer ' + settings.line_oa_token,
            'Content-Type': 'application/json', 'X-Line-Retry-Key': input.delivery_id },
          body: JSON.stringify({ to: recipient, messages: [{ type: 'text', text: report }] }),
          signal: AbortSignal.timeout(8000),
        });
        if (!sent.ok && !(sent.status === 409 && sent.headers.has('x-line-accepted-request-id'))) fail('TABLE_REPORT_LINE_FAILED', 502);
        return reply({ ok: true });
      }
      if (input.action === 'table_cash_bet') {
        if (typeof input.table_no !== 'string' || !/^\d{1,8}$/.test(input.table_no) ||
            typeof input.round_id !== 'string' || !input.round_id || input.round_id.length > 100 ||
            !shopInviteIdPattern.test(input.bet_id) || !['คู่','คี่'].includes(input.bet_type) ||
            typeof input.amount !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(input.amount)) fail('BET_INVALID');
        const result = await db.rpc('place_player_cash_table_bet', {
          p_shop: shopId, p_uid: claims.sub, p_round: input.round_id, p_id: input.bet_id, p_type: input.bet_type,
          p_amount: input.amount, p_table: input.table_no, p_day: tableDay(), p_staff: true,
        });
        if (result.error) fail('BET_UNAVAILABLE', 500);
        if (result.data?.code !== 'PLACED') fail(result.data?.code || 'BET_UNAVAILABLE', 409);
        return reply({ ok: true, bet_id: result.data.bet_id });
      }
      if (input.action === 'table_bulk_create') {
        if (!Number.isInteger(input.count) || input.count < 1 || input.count > 100 ||
            typeof input.cash_limit !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(input.cash_limit) ||
            Number(input.cash_limit) <= 0 || Number(input.cash_limit) > 999999999) fail('TABLE_RANGE_INVALID');
        const result = await db.rpc('create_cash_table_range', {
          p_shop: shopId, p_count: input.count, p_limit: input.cash_limit,
        });
        if (result.error) fail('TABLE_CREATE_FAILED', 500);
        return reply({ ok: true, added: result.data });
      }
      if (['table_qr', 'table_cash_payment'].includes(input.action)) {
        const table = input.table_no;
        if (typeof table !== 'string' || !/^\d{1,8}$/.test(table)) fail('TABLE_INVALID');
        if (input.action === 'table_qr') {
          const desk = await db.from('tables').select('cash_limit,is_open,is_hidden').eq('shop_id', shopId).eq('table_no', table).maybeSingle();
          if (desk.error) fail('DATABASE_ERROR', 500);
          if (desk.data && (!desk.data.is_open || desk.data.is_hidden)) fail('TABLE_CLOSED', 409);
          if (!desk.data?.cash_limit) fail('CASH_TABLE_REQUIRED', 409);
          const day = tableDay();
          return reply({ ok: true, day, token: await tableQrSignature(shopId, table, day) });
        }
        if (!shopInviteIdPattern.test(input.entry_id) || !['deposit','withdraw'].includes(input.type) ||
            typeof input.amount !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(input.amount)) fail('AMOUNT_INVALID');
        if (role === 'Operator' && input.type !== 'deposit') fail('ADMIN_REQUIRED', 403);
        const result = await db.rpc('record_cash_table_payment', {
          p_shop: shopId, p_table: table, p_id: input.entry_id, p_type: input.type,
          p_amount: input.amount, p_staff: claims.sub,
        });
        if (result.error) fail('TABLE_PAYMENT_UNAVAILABLE', 500);
        if (result.data?.code !== 'RECORDED') fail(result.data?.code || 'TABLE_PAYMENT_UNAVAILABLE', 409);
        return reply({ ok: true, balance: result.data.balance });
      }
      if (input.action === 'round_finalize_balanced') {
        if (typeof input.round_id !== 'string' || !input.round_id || input.round_id.length > 100 ||
            !Number.isFinite(input.weight) || input.weight <= 0 || input.weight > 1000000) fail('ROUND_WEIGHT_INVALID');
        const result = await db.rpc('finalize_shop_round', {
          p_shop: shopId, p_round: input.round_id, p_weight: input.weight, p_actor: claims.sub,
        });
        if (result.error?.message === 'BACKER_INSUFFICIENT_BALANCE') fail('BACKER_INSUFFICIENT_BALANCE', 409);
        if (result.error) fail('ROUND_FINALIZE_UNAVAILABLE', 500);
        if (!['ENDED', 'RECOVERED'].includes(result.data)) fail(result.data || 'ROUND_FINALIZE_UNAVAILABLE', 409);
        return reply({ ok: true, recovered: result.data === 'RECOVERED' });
      }
      if (['wallet_approve_deposit', 'wallet_approve_withdrawal'].includes(input.action)) {
        const id = String(input.request_id ?? '');
        if (!/^(?:\d{1,20}|[a-f0-9-]{36})$/i.test(id)) fail('WALLET_REQUEST_INVALID');
        const rpc = input.action === 'wallet_approve_deposit' ? 'approve_wallet_deposit' : 'approve_wallet_withdrawal';
        const approval = await db.rpc(rpc, {
          p_shop: shopId, p_request: id, p_staff: claims.sub,
        });
        if (approval.error) fail('WALLET_REQUEST_UNAVAILABLE', 500);
        if (approval.data?.code !== 'APPROVED') fail(approval.data?.code || 'WALLET_REQUEST_UNAVAILABLE', 409);
        await notifyWalletPlayer(db, fetcher, env, shopId, approval.data);
        return reply({ ok: true });
      }
      if (input.action === 'membership_summary') {
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
      if (spec.table === 'tables' && spec.operation === 'delete') query = query.eq('credit', 0);
      if (spec.table === 'rounds' && spec.operation === 'update') query = query.neq('status', 'Ended');
      if (spec.table === 'users' && spec.operation === 'update') query = query.eq('role', 'Backer');
      if (spec.operation !== 'select' && input.returning) query = query.select(spec.columns);
      for (const o of spec.orders) query = query.order(o.column, { ascending: o.ascending });
      if (spec.operation === 'select') query = query.limit(input.limit ?? 1000);
      if (input.single) query = query.single();
      const result = await query;
      if (result.error) {
        if (result.error.message === 'CASH_TABLE_OPEN_BALANCE') fail('CASH_TABLE_OPEN_BALANCE', 409);
        if (spec.table === 'tables' && spec.operation === 'insert' && result.error.code === '23505') fail('TABLE_ALREADY_EXISTS', 409);
        console.error('admin-api database error', spec.table, spec.operation, result.error.code);
        fail('ADMIN_DATABASE_ERROR', 500);
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
      return reply({ ok: true, data: result.data });
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
