// Separate from member-approval. Deploy with verify_jwt=false: LINE verifies tokens below.
// Required secrets: LINE_CHANNEL_ID_ADMIN, WEB_ORIGIN (origin only), and a Supabase server key.
import { createClient } from 'npm:@supabase/supabase-js@2';

const fields = {
  users: 'uid shop_id member_id display_name profile_pic role status credit_balance total_deposit commission_balance referrer_uid backer_share backer_water_fee backer_wallet created_at',
  tables: 'id shop_id table_no credit created_at cash_limit table_name is_open is_hidden',
  rounds: 'round_id shop_id status weight result created_at end_time_ms resolver_type settlement_weight',
  bets: 'bet_id shop_id round_id uid table_no bet_type amount status play_mode payout created_at cash_table',
  backer_logs: 'id shop_id round_id uid member_id share_percent gap_amount result_status pnl_amount water_fee_deducted wallet_balance_after created_at',
  transactions: 'id shop_id target_id type amount admin_name target_type created_at cash_table_no',
  topup_requests: 'id shop_id uid member_id display_name type amount method fee_option slip_url status admin_name created_at',
  system_settings: 'id shop_id water_margin min_bet max_bet round_duration comm_rate withdrawal_fee_mode created_at'
};
const writes = {
  users: { update: 'role status credit_balance total_deposit commission_balance backer_share backer_water_fee backer_wallet' },
  tables: { insert: 'shop_id table_no credit', update: 'credit cash_limit table_name is_open is_hidden' },
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

export function validateQuery(input, role, shopId) {
  const { table, operation = 'select' } = input;
  if (!Object.hasOwn(fields, table)) fail('TABLE_NOT_ALLOWED', 403);
  if (!['select', 'insert', 'update', 'delete'].includes(operation)) fail('OPERATION_NOT_ALLOWED', 403);
  if (role === 'Cashier') {
    if (operation === 'select' && !['tables','rounds','bets'].includes(table)) fail('ADMIN_REQUIRED', 403);
    if (operation !== 'select' && !(table === 'tables' && operation === 'update' &&
      Object.keys(input.values ?? {}).length === 1 && Object.hasOwn(input.values, 'is_open'))) fail('ADMIN_REQUIRED', 403);
  }
  if (!['Admin', 'Superadmin', 'Operator', 'Cashier'].includes(role)) fail('ADMIN_REQUIRED', 403);
  if (role === 'Operator' && operation === 'select' && ['transactions', 'backer_logs'].includes(table)) fail('ADMIN_REQUIRED', 403);
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
          if (key === 'cash_limit' && value !== null &&
              (typeof value !== 'number' || value < 0.01 || value > 999999999)) fail('AMOUNT_INVALID');
          if (key === 'table_name' && value !== null &&
              (typeof value !== 'string' || !value.trim() || value.length > 40)) fail('TABLE_NAME_INVALID');
          if (['is_open', 'is_hidden'].includes(key) && typeof value !== 'boolean') fail('TABLE_INVALID');
          if (key === 'role' && !['Customer', 'Promoter', 'Backer', 'Operator', 'Cashier', 'Admin'].includes(String(value))) fail('ROLE_INVALID');
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

export function dailyFinanceFlex(day, shopName, data, preparedBy) {
  const color = {
    white: '#F8FAFC', muted: '#ADB9CE', blue: '#80B3FF', green: '#50D8A7',
    red: '#FF838A', amber: '#FFD18A', border: '#343C4D',
  };
  const money = amount => '฿' + Number(amount).toLocaleString('th-TH', { maximumFractionDigits: 2 });
  const signedMoney = amount => (amount < 0 ? '−' : amount > 0 ? '+' : '') + money(Math.abs(amount));
  const movementColor = amount => amount < 0 ? color.red : amount > 0 ? color.green : color.white;
  const count = (value, unit) => Number(value).toLocaleString('th-TH') + ' ' + unit;
  const text = (value, extra = {}) => ({ type: 'text', text: String(value), wrap: true, color: color.white, size: 'sm', ...extra });
  const row = (label, value, valueColor = color.white, emphasis = false) => ({
    type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
      text(label, { flex: 5, color: emphasis ? color.white : color.muted, weight: emphasis ? 'bold' : 'regular' }),
      text(value, { flex: 3, align: 'end', color: valueColor, weight: emphasis ? 'bold' : 'regular', size: emphasis ? 'md' : 'sm' }),
    ],
  });
  const section = (title, rows) => ({
    type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      text(title, { weight: 'bold', color: color.blue, size: 'md' }), ...rows,
    ],
  });
  const snapshot = new Date(data.wallet_as_of).toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short',
  });
  const margin = Number(data.settled_stake) - Number(data.payout) - Number(data.pnl);
  const referral = Number(data.referral_commission ?? 0);
  const bonusFee = Number(data.bonus_fee_revenue ?? 0);
  const netCash = Number(data.cash_in) - Number(data.cash_out);
  const title = 'รายงานสรุปยอดประจำวัน';
  const sections = [
    section('กำไรค่าน้ำ', [
      row('ยอดเล่นที่ตัดผล', money(data.settled_stake)),
      row('จ่ายผู้ชนะ', signedMoney(-Number(data.payout)), movementColor(-Number(data.payout))),
      row('ผลสุทธิผู้รับจบ', signedMoney(-Number(data.pnl)), movementColor(-Number(data.pnl))),
      row('ค่าน้ำสุทธิก่อนค่าคอมและค่าใช้จ่าย', signedMoney(margin), movementColor(margin)),
      row('ค่าแนะนำที่เข้าโบนัส', signedMoney(-referral), movementColor(-referral)),
      row('ค่าน้ำหลังหักค่าแนะนำ ก่อนค่าใช้จ่าย', signedMoney(margin - referral), movementColor(margin - referral), true),
    ]),
    section('การเงินบ่อ', [
      row('รับเงินสดจากโต๊ะ', signedMoney(Number(data.cash_in)), color.green),
      row('จ่ายเงินสดให้โต๊ะ', signedMoney(-Number(data.cash_out)), color.red),
      row('ค่าบริการถอนโบนัส (รายได้ร้าน)', signedMoney(bonusFee), movementColor(bonusFee)),
      row('โอนจ่ายโบนัส', money(data.bonus_withdrawn ?? 0)),
      row('เงินสดสุทธิจากโต๊ะ', signedMoney(netCash), movementColor(netCash), true),
      row('เพิ่มเครดิตสมาชิก', signedMoney(Number(data.credit_in)), color.green),
      row('ลดเครดิตสมาชิก', signedMoney(-Number(data.credit_out)), color.red),
      row('เพิ่ม / ลดเครดิตโต๊ะเดิม', money(data.table_credit_in) + ' / ' + money(data.table_credit_out)),
    ]),
    section('ยอดคงเหลือใน Wallet', [
      row('เครดิตลูกค้าคงเหลือ (หนี้สินร้าน)', money(data.customer_wallet_liability), color.amber, true),
      row('โบนัสลูกค้าคงเหลือ (หนี้สินร้าน)', money(data.bonus_wallet_liability ?? 0), color.amber),
      text('ยอดปัจจุบัน ณ ' + snapshot + ' น.', { color: color.muted, size: 'xs' }),
    ]),
    section('สถิติยอดออนไลน์', [
      row('ยอดเล่นส่วนตัวที่ตัดผล', money(data.online_stake)),
      row('ยอดจ่ายผู้ชนะ', money(data.online_payout)),
      row('จำนวนบิลที่ตัดผล', count(data.online_bills, 'บิล')),
    ]),
    section('สถิติบนโต๊ะ', [
      row('ยอดเล่นบนโต๊ะที่ตัดผล', money(data.table_stake)),
      row('ในนั้นเป็นโต๊ะเงินสด', money(data.cash_stake)),
      row('ยอดจ่ายผู้ชนะ', money(data.table_payout)),
      row('จำนวนบิลที่ตัดผล', count(data.table_bills, 'บิล')),
    ]),
    section('สถิติรอบ', [
      row('เปิดทั้งหมด', count(data.rounds, 'รอบ')),
      row('ตัดผลแล้ว', count(data.ended, 'รอบ')),
      row('ออกคู่', count(data.even, 'รอบ'), color.blue),
      row('ออกคี่', count(data.odd, 'รอบ'), color.red),
      row('บิลรอตัดผล', count(data.pending, 'บิล'), color.amber),
      row('ยอดบิลยกเลิก', money(data.cancelled)),
    ]),
  ];
  if (Number(data.unclassified_bills) > 0) {
    sections[5].contents.push(row('บิลเดิมที่ไม่ระบุช่องทาง', count(data.unclassified_bills, 'บิล'), color.amber));
  }
  return { type: 'flex', altText: (title + ' · ' + shopName + ' · ' + day).slice(0, 300), contents: {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: '#202433', spacing: 'sm', paddingAll: 'lg', contents: [
      text('📊 ' + title, { size: 'lg', weight: 'bold' }),
      text(shopName, { weight: 'bold' }),
      text('วันที่บัญชี ' + day + ' · 06:00 ถึงก่อน 06:00 วันถัดไป', { color: color.muted, size: 'xs' }),
      ...(preparedBy ? [text('สรุปโดย ' + preparedBy, { color: color.muted, size: 'xs' })] : []),
    ] },
    body: { type: 'box', layout: 'vertical', backgroundColor: '#141720', spacing: 'lg', paddingAll: 'lg',
      contents: sections.flatMap((item, index) => index ? [{ type: 'separator', color: color.border }, item] : [item]),
    },
  } };
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
      if (input.action === 'public_cash_board') {
        if (!/^SHOP_[0-9]{3,24}$/.test(shopId)) fail('SHOP_INVALID');
        const result = await database().rpc('read_public_cash_board', { p_shop: shopId });
        if (result.error) fail('BOARD_UNAVAILABLE', 500);
        if (!result.data) fail('SHOP_NOT_AVAILABLE', 404);
        return reply({ ok: true, board: result.data });
      }
      if (input.action === 'player_entry') return reply(await playerEntry(shopId));
      if (!['access', 'query', 'membership_summary', 'promoter_profile', 'player_profile', 'player_state', 'player_place_bet', 'player_cancel_bet', 'player_bet_history', 'wallet_request', 'wallet_approve_deposit', 'wallet_approve_withdrawal', 'round_finalize_balanced', 'table_bulk_create', 'table_qr', 'table_cash_payment', 'table_cash_report', 'daily_referral_commission', 'table_cash_bet', 'table_correct_bet', 'round_begin_settlement', 'table_send_cash_report', 'platform_issue_shop_invite', 'platform_redeem_shop', 'platform_shop_invite_details', 'platform_shop_portal', 'platform_shop_control', 'platform_save_shop_oa', 'platform_save_notice_recipient', 'platform_capture_notice'].includes(input.action)) fail('INVALID_ACTION');
      if (!['platform_issue_shop_invite', 'platform_redeem_shop', 'platform_shop_invite_details', 'platform_shop_portal', 'platform_shop_control', 'platform_save_shop_oa', 'platform_save_notice_recipient', 'platform_capture_notice'].includes(input.action) && !/^[\w-]{1,80}$/.test(shopId)) fail('SHOP_INVALID');
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const playerRequest = ['promoter_profile', 'player_profile', 'player_state', 'player_place_bet', 'player_cancel_bet', 'player_bet_history', 'wallet_request'].includes(input.action);
      const channelKey = playerRequest ? 'LINE_CHANNEL_ID_PLAYER' : 'LINE_CHANNEL_ID_ADMIN';
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
      if (input.action === 'player_state') {
        const member = await db.from('users').select('role,status').eq('shop_id', shopId).eq('uid', claims.sub).maybeSingle();
        if (member.error) fail('PLAYER_STATE_UNAVAILABLE', 500);
        if (member.data?.role === 'Cashier') {
          if (member.data.status === 'Active') fail('CASHIER_ADMIN_REQUIRED', 403);
          fail('PLAYER_ACCESS_REQUIRED', 403);
        }
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
        const shop = await db.from('shops').select('status,live_enabled,shop_name').eq('shop_id', shopId).maybeSingle();
        if (shop.error) fail('DATABASE_ERROR', 500);
        if (String(shop.data?.status).toLowerCase() !== 'active') fail('SHOP_NOT_AVAILABLE', 403);

        if (input.action === 'promoter_profile') {
          const promoter = await db.from('users').select('uid,member_id,display_name,credit_balance,commission_balance')
            .eq('shop_id', shopId).eq('uid', claims.sub).eq('role', 'Promoter').eq('status', 'Active').maybeSingle();
          if (promoter.error) fail('DATABASE_ERROR', 500);
          if (!promoter.data) fail('PLAYER_ACCESS_REQUIRED', 403);
          return reply({ ok: true, promoter: promoter.data, shop_name: shop.data.shop_name });
        }

        const profile = await db.from('users').select(input.action === 'wallet_request' ? 'uid,role,status,member_id,credit_balance,commission_balance,display_name' : 'uid,role,status,member_id,credit_balance,commission_balance')
          .eq('uid', claims.sub).eq('shop_id', shopId).maybeSingle();
        if (profile.error) fail('DATABASE_ERROR', 500);
        if (profile.data?.role === 'Cashier') {
          if (input.action === 'player_profile' && input.include_wallet_requests !== true && profile.data.status === 'Active') {
            return reply({ ok: true, destination: 'admin_tables', shop_id: shopId });
          }
          fail('PLAYER_ACCESS_REQUIRED', 403);
        }

        if (input.action === 'player_profile' && typeof input.referral_member_id === 'string'
            && /^M[0-9]{4,19}$/.test(input.referral_member_id)) {
          const referral = await db.rpc('claim_daily_player_referral', {
            p_shop: shopId, p_player: claims.sub, p_member: input.referral_member_id,
          });
          if (referral.error) fail('REFERRAL_UNAVAILABLE', 503);
        }

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
          if (result.error?.message === 'BET_MINIMUM') return reply({ ok: false, code: 'BET_MINIMUM' }, 409);
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
              typeof amount !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(amount) || Number(amount) < 100) {
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
          const [requests, credits, referrals] = await Promise.all([
            db.from('topup_requests').select('type,amount,status,created_at')
              .eq('shop_id', shopId).eq('uid', claims.sub)
              .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(10),
            db.from('wallet_slip_credits').select('amount,credited_at')
              .eq('shop_id', shopId).eq('uid', claims.sub)
              .order('credited_at', { ascending: false }).order('transaction_ref', { ascending: false }).limit(10),
            profile.data.role === 'Promoter'
              ? db.from('referral_commission_credits').select('amount,credited_at')
                .eq('shop_id', shopId).eq('referrer_uid', claims.sub)
                .order('credited_at', { ascending: false }).order('bet_id').limit(10)
              : { data: [] },
          ]);
          if (requests.error || credits.error || referrals.error) fail('WALLET_REQUESTS_UNAVAILABLE', 500);
          const automatic = credits.data.map(entry => ({
            type: 'ฝากเงิน', amount: entry.amount, status: 'Approved', created_at: entry.credited_at,
          }));
          const commission = referrals.data.map(entry => ({
            type: 'ค่าแนะนำ', amount: entry.amount, status: 'Approved', created_at: entry.credited_at,
          }));
          const history = [...requests.data, ...automatic, ...commission]
            .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)).slice(0, 10);
          return reply({ ok: true, wallet_requests: history, bonus_balance: profile.data.commission_balance });
        }
        return reply({ ok: true, staff, state: 'Approved', player: profile.data, live_enabled: shop.data.live_enabled === true });
      }

      // Identity always comes from LINE verification, never from input.uid/role.
      const staff = await db.from('users').select('uid,shop_id,role,status,member_id,display_name').eq('uid', claims.sub).eq('shop_id', shopId).maybeSingle();
      if (staff.error) fail('DATABASE_ERROR', 500);
      if (!staff.data || staff.data.status !== 'Active' || !['Admin', 'Superadmin', 'Operator', 'Cashier'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
      const shop = await db.from('shops').select('shop_id,status').eq('shop_id', shopId).maybeSingle();
      if (shop.error) fail('DATABASE_ERROR', 500);
      if (!shop.data || String(shop.data.status).toLowerCase() !== 'active') fail('SHOP_NOT_AVAILABLE', 403);
      if (staff.data.role === 'Cashier' && !['access','query','table_qr','table_cash_payment','table_cash_bet','table_correct_bet'].includes(input.action)) {
        fail('ADMIN_REQUIRED', 403);
      }
      if (input.action === 'table_correct_bet') {
        if (!['Admin','Superadmin','Cashier'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
        const { operation, request_id, bet_id, table_no, round_id, reason, side, amount, expected_side, expected_amount } = input;
        const validSide = value => ['คู่','คี่'].includes(value);
        const validAmount = value => typeof value === 'string' && /^\d{1,9}(?:\.\d{1,2})?$/.test(value);
        if (!['add','edit','remove'].includes(operation) || !shopInviteIdPattern.test(request_id) ||
            !shopInviteIdPattern.test(bet_id) || typeof table_no !== 'string' || !/^\d{1,8}$/.test(table_no) ||
            typeof round_id !== 'string' || !round_id || round_id.length > 100 ||
            typeof reason !== 'string' || !reason.trim() || reason.trim().length > 300 ||
            (operation !== 'remove' && (!validSide(side) || !validAmount(amount))) ||
            (operation !== 'add' && (!validSide(expected_side) || !validAmount(expected_amount)))) fail('BET_INVALID');
        const result = await db.rpc('correct_cash_table_bet', {
          p_shop: shopId, p_actor: claims.sub, p_round: round_id, p_table: table_no, p_request: request_id,
          p_bet: bet_id, p_operation: operation, p_reason: reason.trim(),
          p_side: operation === 'remove' ? null : side, p_amount: operation === 'remove' ? null : amount,
          p_expected_side: operation === 'add' ? null : expected_side,
          p_expected_amount: operation === 'add' ? null : expected_amount,
        });
        if (result.error) fail('BET_UNAVAILABLE', 500);
        if (result.data !== 'RECORDED') fail(result.data || 'BET_UNAVAILABLE', result.data === 'ADMIN_REQUIRED' ? 403 : 409);
        return reply({ ok: true });
      }
      if (input.action === 'round_begin_settlement') {
        if (typeof input.round_id !== 'string' || !input.round_id || input.round_id.length > 100 ||
            !Number.isFinite(input.weight) || !['none','shop','backer'].includes(input.resolver)) fail('ROUND_WEIGHT_INVALID');
        const result = await db.rpc('begin_round_settlement', {
          p_shop: shopId, p_round: input.round_id, p_weight: input.weight, p_resolver: input.resolver,
        });
        if (result.error) fail('ROUND_FINALIZE_UNAVAILABLE', 500);
        if (result.data !== 'READY') fail(result.data || 'ROUND_FINALIZE_UNAVAILABLE', 409);
        return reply({ ok: true });
      }
      if (input.action === 'access') {
        const picture = lineProfilePicture(claims.picture);
        if (picture) await db.from('users').update({ profile_pic: picture }).eq('shop_id', shopId).eq('uid', claims.sub);
        return reply({ ok: true, staff: staff.data, can_create_shop: await canCreateShop() });
      }
      if (['table_cash_report', 'table_send_cash_report', 'daily_referral_commission'].includes(input.action)) {
        if (staff.data.role === 'Operator') fail('ADMIN_REQUIRED', 403);
        if (typeof input.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)) fail('TABLE_DATE_INVALID');
        const date = new Date(input.day + 'T00:00:00Z');
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.day) fail('TABLE_DATE_INVALID');
        if (input.action === 'daily_referral_commission') {
          const result = await db.rpc('daily_referral_commission', { p_shop: shopId, p_day: input.day });
          if (result.error) fail('TABLE_REPORT_UNAVAILABLE', 500);
          return reply({ ok: true, ...result.data });
        }
        if (input.action === 'table_cash_report') {
          const result = await db.rpc('cash_table_daily_report', { p_shop: shopId, p_day: input.day });
          if (result.error) fail('TABLE_REPORT_UNAVAILABLE', 500);
          return reply({ ok: true, tables: result.data });
        }
        const runtime = await db.from('shop_oa_runtime').select('shop_name,line_oa_token,admin_group_id,membership_notice_recipient_uid,line_notifications_enabled')
          .eq('shop_id', shopId).maybeSingle();
        if (runtime.error) fail('TABLE_REPORT_UNAVAILABLE', 500);
        const settings = runtime.data;
        const groupId = settings?.admin_group_id?.trim() || '';
        const ownerId = settings?.membership_notice_recipient_uid?.trim() || '';
        const recipient = groupId || ownerId;
        const recipientType = groupId ? 'group' : 'owner';
        const validRecipient = groupId ? /^C[0-9a-f]{32}$/i.test(groupId) : /^U[0-9a-f]{32}$/i.test(ownerId);
        if (!settings?.line_oa_token || settings.line_notifications_enabled === false || !validRecipient) {
          fail('TABLE_REPORT_LINE_NOT_READY', 409);
        }
        const result = await db.rpc('daily_group_finance_report', { p_shop: shopId, p_day: input.day });
        if (result.error || !result.data) fail('TABLE_REPORT_UNAVAILABLE', 500);
        const report = dailyFinanceFlex(input.day, settings.shop_name || shopId, result.data, staff.data.display_name);
        if (typeof input.delivery_id !== 'string' || !shopInviteIdPattern.test(input.delivery_id)) fail('TABLE_REPORT_UNAVAILABLE', 400);
        const sent = await fetcher('https://api.line.me/v2/bot/message/push', {
          method: 'POST', headers: { Authorization: 'Bearer ' + settings.line_oa_token,
            'Content-Type': 'application/json', 'X-Line-Retry-Key': input.delivery_id },
          body: JSON.stringify({ to: recipient, messages: [report] }),
          signal: AbortSignal.timeout(8000),
        });
        if (!sent.ok && !(sent.status === 409 && sent.headers.has('x-line-accepted-request-id'))) fail('TABLE_REPORT_LINE_FAILED', 502);
        return reply({ ok: true, recipient_type: recipientType });
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
        if (result.error?.message === 'BET_MINIMUM') return reply({ ok: false, code: 'BET_MINIMUM' }, 409);
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
        const result = await db.rpc('record_cash_table_payment', {
          p_shop: shopId, p_table: table, p_id: input.entry_id, p_type: input.type,
          p_amount: input.amount, p_staff: staff.data.display_name || staff.data.member_id,
        });
        if (result.error) fail('TABLE_PAYMENT_UNAVAILABLE', 500);
        if (result.data?.code !== 'RECORDED') fail(result.data?.code || 'TABLE_PAYMENT_UNAVAILABLE', 409);
        return reply({ ok: true, balance: result.data.balance });
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
      if (spec.table === 'tables' && spec.operation === 'update' && Object.hasOwn(input.values, 'credit')) {
        query = query.is('cash_limit', null);
      }
      const changingBet = spec.table === 'bets' && spec.operation === 'update';
      if (changingBet) {
        query = query.eq('status', 'Active');
        if (input.values.status === 'Cancelled') query = query.eq('cash_table', false);
      }
      if (spec.table === 'rounds' && spec.operation === 'update' &&
          (input.values.status === 'Closed' || Object.hasOwn(input.values, 'resolver_type'))) {
        query = query.in('status', ['Open','Closed']).is('settlement_weight', null);
      }
      const walletDecision = spec.table === 'topup_requests' && spec.operation === 'update' &&
        ['Approved', 'Rejected'].includes(input.values?.status);
      if (walletDecision) {
        query = query.eq('status', 'Pending');
        if (input.values.status === 'Approved') query = query.neq('type', 'ถอนโบนัส');
        query = query.select(input.returning ? spec.columns : 'uid,type,amount,status');
      }
      else if (changingBet) query = query.select(spec.columns);
      else if (spec.operation !== 'select' && input.returning) query = query.select(spec.columns);
      for (const o of spec.orders) query = query.order(o.column, { ascending: o.ascending });
      if (spec.operation === 'select') query = query.limit(input.limit ?? 1000);
      if (input.single) query = query.single();
      const result = await query;
      if (result.error) {
        if (result.error.message === 'ROUND_CANNOT_REOPEN') fail('ROUND_CANNOT_REOPEN', 409);
        if (result.error.message === 'CASH_TABLE_OPEN_BALANCE') fail('CASH_TABLE_OPEN_BALANCE', 409);
        if (spec.table === 'tables' && spec.operation === 'insert' && result.error.code === '23505') fail('TABLE_ALREADY_EXISTS', 409);
        console.error('admin-api database error', spec.table, spec.operation, result.error.code);
        fail('ADMIN_DATABASE_ERROR', 500);
      }
      if (changingBet && !result.data?.length) fail('BET_NOT_ACTIVE', 409);
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
