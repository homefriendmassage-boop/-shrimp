import { parseShopPlayerLiff, readShopPlayerOverride, shopPlayerChannel, shopPlayerLiff, shopPlayerUrl } from '../_shared/shop-player-login.mjs';
// Separate from member-approval. Deploy with verify_jwt=false: LINE verifies tokens below.
// Required secrets: LINE_CHANNEL_ID_ADMIN, WEB_ORIGIN (origin only), and a Supabase server key.
import { createClient } from 'npm:@supabase/supabase-js@2';

const fields = {
  users: 'uid shop_id member_id display_name profile_pic role status credit_balance total_deposit commission_balance referrer_uid backer_share backer_water_fee backer_wallet created_at',
  tables: 'id shop_id table_no credit created_at cash_limit table_name is_open is_hidden parent_table_no guest_bill_closed guest_uid',
  rounds: 'round_id shop_id status weight result created_at end_time_ms resolver_type settlement_weight',
  bets: 'bet_id shop_id round_id uid table_no bet_type amount status play_mode payout created_at cash_table',
  backer_logs: 'id shop_id round_id uid member_id share_percent gap_amount result_status pnl_amount water_fee_deducted wallet_balance_after created_at',
  transactions: 'id shop_id target_id type amount admin_name target_type created_at cash_table_no',
  topup_requests: 'id shop_id uid member_id display_name type amount method fee_option slip_url status admin_name created_at',
  system_settings: 'id shop_id water_margin min_bet max_bet round_duration comm_rate withdrawal_fee_mode created_at'
};
const writes = {
  users: { update: 'role status credit_balance total_deposit commission_balance backer_share backer_water_fee' },
  tables: { insert: 'shop_id table_no credit', update: 'credit cash_limit table_name is_open is_hidden' },
  rounds: { update: 'status' },
  bets: { update: 'status' },
  transactions: { insert: 'shop_id target_id type amount admin_name target_type' },
  topup_requests: { update: 'status admin_name' },
  system_settings: { update: 'water_margin min_bet max_bet round_duration comm_rate withdrawal_fee_mode' }
};
const identity = { users: ['uid', 'member_id'], tables: ['table_no'], rounds: ['round_id'], bets: ['bet_id'], topup_requests: ['id'] };
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };
const includes = (words, key) => words.split(' ').includes(key);
const primitive = value => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean';
const wholeHundredBet = value => Number(value) >= 100 && Number(value) % 100 === 0;


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
  if (['Cashier','Operator'].includes(role)) {
    if (operation === 'select' && !['tables','rounds','bets'].includes(table)) fail('ADMIN_REQUIRED', 403);
    const allowedTableFields = ['is_open'];
    const keys = Object.keys(input.values ?? {});
    const tableUpdate = table === 'tables' && keys.length === 1 && allowedTableFields.includes(keys[0]);
    const closeRound = keys.length === 1 && input.values?.status === 'Closed';
    const roundUpdate = role === 'Cashier' && table === 'rounds' && closeRound;
    if (operation !== 'select' && !(operation === 'update' && (tableUpdate || roundUpdate))) fail('ADMIN_REQUIRED', 403);
  }
  if (!['Admin', 'Superadmin', 'Operator', 'Cashier'].includes(role)) fail('ADMIN_REQUIRED', 403);
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
          if (table === 'rounds' && value !== 'Closed') fail('WRITE_NOT_ALLOWED', 403);
          if (table === 'bets' && value !== 'Cancelled') fail('WRITE_NOT_ALLOWED', 403);
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
      : shopPlayerUrl(env, shopId, await readShopPlayerOverride(db, shopId));
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
      row(data.coverage?.settled_bills ? 'ผลสุทธิรวมก่อนค่าแนะนำและค่าใช้จ่าย' : 'ค่าน้ำสุทธิก่อนค่าคอมและค่าใช้จ่าย', signedMoney(margin), movementColor(margin)),
      row('ค่าแนะนำที่เข้าโบนัส', signedMoney(-referral), movementColor(-referral)),
      row(data.coverage?.settled_bills ? 'ผลสุทธิรวมหลังหักค่าแนะนำ' : 'ค่าน้ำหลังหักค่าแนะนำ ก่อนค่าใช้จ่าย', signedMoney(margin - referral), movementColor(margin - referral), true),
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
  if (data.coverage?.settled_bills) {
    for (const [key, label] of [['wallet','Wallet'], ['table','บนโต๊ะ']]) {
      const totals = data.coverage.channels[key];
      sections.push(section('ค่าน้ำ ' + label, [
        row('ค่าน้ำยอดจับคู่', money(totals.matched_fee)),
        row('ค่าน้ำรับจบเข้าร้าน', money(totals.coverage_fee)),
        row('ค่าแนะนำ', signedMoney(-totals.referral)),
        row('ค่าน้ำสุทธิ', signedMoney(totals.net_fee), movementColor(totals.net_fee), true),
        row('ยอดที่รับจบรวม', money(totals.recipients.reduce((sum, item) => sum + Number(item.covered), 0))),
        row('ผลรับจบสุทธิรวม', signedMoney(totals.recipients.reduce((sum, item) => sum + Number(item.pnl), 0))),
      ]));
    }
    sections.push(section('รวมค่าน้ำสุทธิทั้งสองช่องทาง', [
      row('ตามกติกาใหม่', signedMoney(data.coverage.total_net_fee), movementColor(data.coverage.total_net_fee), true),
    ]));
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

function parseShopRichMenu(draft) {
  if (!draft || ![843, 1686].includes(draft.height) || !['image/png', 'image/jpeg'].includes(draft.mime) ||
      typeof draft.data !== 'string' || draft.data.length > 1333336 ||
      !Array.isArray(draft.areas) || ![2, 3].includes(draft.areas.length) || typeof draft.food_url !== 'string' ||
      draft.food_url.length > 1000) fail('RICH_MENU_INVALID');

  let url, booking, bytes;
  try {
    url = draft.food_url ? new URL(draft.food_url) : null;
    if (draft.booking_url != null && (typeof draft.booking_url !== 'string' || draft.booking_url.length > 1000)) fail('RICH_MENU_INVALID');
    booking = draft.booking_url ? new URL(draft.booking_url) : null;
    bytes = Uint8Array.from(atob(draft.data), char => char.charCodeAt(0));
  } catch { fail('RICH_MENU_INVALID'); }
  if ([url, booking].some(link => link && (link.protocol !== 'https:' || link.username || link.password || link.href.length > 1000)) ||
      bytes.byteLength < 24 || bytes.byteLength > 1000000) fail('RICH_MENU_INVALID');

  const view = new DataView(bytes.buffer);
  let width, height;
  if (draft.mime === 'image/png' && view.getUint32(0) === 0x89504e47 &&
      view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (draft.mime === 'image/jpeg' && view.getUint16(0) === 0xffd8) {
    for (let i = 2; i + 8 < bytes.length && bytes[i] === 255;) {
      const marker = bytes[i + 1];
      if (marker === 255) { i++; continue; }
      const length = view.getUint16(i + 2);
      if (length < 2 || i + 2 + length > bytes.length || marker === 0xda) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = view.getUint16(i + 5);
        width = view.getUint16(i + 7);
        break;
      }
      i += 2 + length;
    }
  }
  if (width !== 2500 || height !== draft.height) fail('RICH_MENU_INVALID');

  const areas = draft.areas.map(rect => {
    if (!rect || !['x','y','width','height'].every(key => Number.isInteger(rect[key]))) fail('RICH_MENU_INVALID');
    const { x, y, width, height: h } = rect;
    if (x < 0 || y < 0 || width < 20 || h < 20 || x + width > 2500 || y + h > height) fail('RICH_MENU_INVALID');
    return { x, y, width, height: h };
  });
  if (areas.some((a, i) => areas.slice(i + 1).some(b =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height))) {
    fail('RICH_MENU_INVALID');
  }
  return { draft: { height, mime: draft.mime, data: draft.data, food_url: url?.href ?? '', booking_url: booking?.href ?? '', areas }, bytes };
}

function richMenuLine(fetcher, token, path, options = {}, data = false) {
  const domain = data ? 'api-data.line.me' : 'api.line.me';
  return fetcher('https://' + domain + path, {
    ...options, signal: AbortSignal.timeout(6500),
    headers: { ...options.headers, Authorization: 'Bearer ' + token },
  });
}

async function manageShopRichMenu(db, fetcher, env, input, shopId, defaultMenu = false) {
  const table = 'shop_rich_menus';
  if (input.operation === 'load') {
    const result = await db.from(table).select('draft,published_id').eq('shop_id', shopId).maybeSingle();
    if (result.error) fail('RICH_MENU_UNAVAILABLE', 500);
    return { draft: result.data?.draft ?? null, published: Boolean(result.data?.published_id) };
  }
  if (!['save', 'publish'].includes(input.operation)) fail('RICH_MENU_INVALID');
  const { draft, bytes } = parseShopRichMenu(input.draft);
  if (input.operation === 'publish') {
    const pilot = await db.from('shop_rich_menu_pilots').select('shop_id').eq('shop_id', shopId).maybeSingle();
    if (pilot.error) fail('RICH_MENU_UNAVAILABLE', 500);
    if (!pilot.data) fail('RICH_MENU_PILOT_ONLY', 409);
  }
  if (defaultMenu) {
    const prepared = await db.rpc('prepare_default_shop_rich_menu', { p_shop: shopId, p_draft: draft });
    if (prepared.error) fail('RICH_MENU_UNAVAILABLE', 500);
    if (prepared.data !== true) return {};
  } else {
    const saved = await db.from(table).upsert({ shop_id: shopId, draft, use_default: false }, { onConflict: 'shop_id' });
    if (saved.error) fail('RICH_MENU_UNAVAILABLE', 500);
  }
  if (input.operation === 'save') return {};

  const [shop, oa] = await Promise.all([
    db.from('shops').select('line_oa_bot_uid').eq('shop_id', shopId).single(),
    db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', shopId).single(),
  ]);
  const token = oa.data?.line_oa_token;
  let bot = shop.data?.line_oa_bot_uid;
  if (!token) fail('RICH_MENU_OA_REQUIRED', 409);
  if (!bot && shopId === 'SHOP_000') {
    const info = await richMenuLine(fetcher, token, '/v2/bot/info');
    if (!info.ok) fail('RICH_MENU_OA_REQUIRED', 409);
    bot = (await info.json()).userId;
  }
  if (!bot || !/^U[0-9a-f]{32}$/i.test(bot)) fail('RICH_MENU_OA_REQUIRED', 409);
  const lock = crypto.randomUUID();
  const claimed = await db.from(table).update({ publish_lock: lock, publish_started_at: new Date().toISOString() })
    .eq('shop_id', shopId)
    .or('publish_lock.is.null,publish_started_at.lt.' + new Date(Date.now() - 120000).toISOString())
    .select('shop_id').maybeSingle();
  if (claimed.error) fail('RICH_MENU_UNAVAILABLE', 500);
  if (!claimed.data) fail('RICH_MENU_BUSY', 409);
  let menu;
  let finished = false;
  try {
    const info = await richMenuLine(fetcher, token, '/v2/bot/info');
    if (!info.ok || (await info.json()).userId !== bot) fail('RICH_MENU_OA_REQUIRED', 409);
    const player = shopPlayerUrl(env, shopId, await readShopPlayerOverride(db, shopId));
    const created = await richMenuLine(fetcher, token, '/v2/bot/richmenu', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        size: { width: 2500, height: draft.height }, selected: true,
        name: 'Shrimp members ' + shopId, chatBarText: 'เมนูสมาชิก',
        areas: draft.areas.map((bounds, i) => {
          const isPlayer = i === draft.areas.length - 1;
          const uri = isPlayer ? player : i === 0 ? draft.food_url : draft.booking_url;
          return { bounds, action: uri ? { type: 'uri', uri } : {
            type: 'message', text: i === 0 ? 'ร้านยังไม่เปิดลิงก์สั่งอาหาร' : 'ร้านยังไม่เปิดลิงก์จองโต๊ะ / ที่นั่ง',
          } };
        }),
      }),
    });
    if (!created.ok) fail('RICH_MENU_LINE_FAILED', 502);
    menu = (await created.json()).richMenuId;
    if (typeof menu !== 'string' || !/^richmenu-[a-f0-9]+$/i.test(menu)) fail('RICH_MENU_LINE_FAILED', 502);
    const uploaded = await richMenuLine(fetcher, token, '/v2/bot/richmenu/' + menu + '/content',
      { method: 'POST', headers: { 'Content-Type': draft.mime }, body: bytes }, true);
    if (!uploaded.ok) fail('RICH_MENU_LINE_FAILED', 502);
    const result = await db.rpc('finish_shop_rich_menu', { p_shop: shopId, p_lock: lock, p_bot: bot, p_menu: menu });
    if (result.error || result.data !== true) fail('RICH_MENU_UNAVAILABLE', 500);
    finished = true;
    return {};
  } finally {
    if (!finished) {
      // Retain any uploaded menu after an ambiguous database response. A later publish is safe.
      await db.from(table).update({ publish_lock: null }).eq('shop_id', shopId).eq('publish_lock', lock);
    }
  }
}

async function syncShopRichMenus(db, fetcher, env) {
  const defaults = await db.rpc('next_default_shop_rich_menu');
  if (!defaults.error && defaults.data) {
    try {
      const response = await fetcher('https://homefriendmassage-boop.github.io/-shrimp/assets/rich-menu-standard-2500x843.jpg',
        { signal: AbortSignal.timeout(6500) });
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await manageShopRichMenu(db, fetcher, env, { operation: 'publish', draft: {
          mime: 'image/jpeg', data: btoa(binary), height: 843, food_url: '', booking_url: '',
          areas: [0, 833, 1667].map((x, i) => ({ x, y: 0, width: [833, 834, 833][i], height: 843 })),
        } }, defaults.data, true);
      }
    } catch { /* The next scheduled run retries default publication. */ }
  }

  const jobs = await db.rpc('claim_shop_rich_menu_sync');
  if (jobs.error) fail('RICH_MENU_UNAVAILABLE', 500);
  await Promise.all((jobs.data ?? []).map(async job => {
    const path = '/v2/bot/user/' + encodeURIComponent(job.oa_uid) + '/richmenu';
    try {
      const observed = await richMenuLine(fetcher, job.token, path);
      if (observed.status !== 404 && !observed.ok) return;
      const current = observed.ok ? (await observed.json()).richMenuId : null;
      if (job.menu_id && job.menu_id !== current) {
        if (current && !job.known_menus.includes(current)) return;
        const linked = await richMenuLine(fetcher, job.token, path + '/' + job.menu_id, { method: 'POST' });
        if (!linked.ok) return;
      } else if (!job.menu_id && current && job.known_menus.includes(current)) {
        const removed = await richMenuLine(fetcher, job.token, path, { method: 'DELETE' });
        if (!removed.ok) return;
      }
      await db.from('shop_rich_menu_members').update({
        applied_id: job.menu_id, lease: null, refresh_after: new Date(Date.now() + 86400000).toISOString(),
      }).eq('shop_id', job.shop_id).eq('oa_uid', job.oa_uid).eq('lease', job.lease);
    } catch { /* An expired lease lets the next run retry. */ }
  }));
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

  async function tableQrSignature(shop, table, day, generation = null) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(serverKey(env)),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(generation ? ['cash-table', shop, table, day, generation] : ['cash-table', shop, table, day])));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function playerEntry(shopId) {
    if (!/^SHOP_[0-9]{3,24}$/.test(shopId)) fail('SHOP_INVALID');
    const db = database();
    const [shop, runtime] = await Promise.all([
      db.from('shops').select('shop_name,status,line_oa_bot_uid,player_liff_override').eq('shop_id', shopId).maybeSingle(),
      db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', shopId).maybeSingle(),
    ]);
    if (shop.error || runtime.error) fail('DATABASE_ERROR', 500);
    if (shop.data?.status !== 'active') fail('SHOP_NOT_AVAILABLE', 404);
    const details = { ok: true, shop_name: shop.data.shop_name, add_friend_url: null, player_liff_id: shop.data.line_oa_bot_uid ? shopPlayerLiff(env, shopId, shop.data.player_liff_override) : null };
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
      if (raw.length > 1350000) fail('REQUEST_TOO_LARGE', 413);
      let input;
      try { input = JSON.parse(raw); } catch (_) { fail('INVALID_JSON'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_JSON');
      if (raw.length > 65536 && input.action !== 'platform_rich_menu') fail('REQUEST_TOO_LARGE', 413);
      if (input.action === 'rich_menu_worker') {
        const secret = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!/^[a-f0-9]{64}$/.test(secret)) fail('ADMIN_REQUIRED', 403);
        const db = database();
        const authorized = await db.rpc('authorize_shop_rich_menu_worker', { p_secret: secret });
        if (authorized.error || authorized.data !== true) fail('ADMIN_REQUIRED', 403);
        await syncShopRichMenus(db, fetcher, env);
        return reply({ ok: true });
      }
      const shopId = typeof input.shop_id === 'string' ? input.shop_id.trim() : '';
      if (input.action === 'public_cash_board') {
        if (!/^SHOP_[0-9]{3,24}$/.test(shopId)) fail('SHOP_INVALID');
        const result = await database().rpc('read_public_cash_board', { p_shop: shopId });
        if (result.error) fail('BOARD_UNAVAILABLE', 500);
        if (!result.data) fail('SHOP_NOT_AVAILABLE', 404);
        return reply({ ok: true, board: result.data });
      }
      if (input.action === 'player_entry') return reply(await playerEntry(shopId));
      if (!['access', 'query', 'membership_summary', 'promoter_profile', 'player_profile', 'player_state', 'table_guest_scan', 'player_place_bet', 'player_cancel_bet', 'player_bet_history', 'wallet_request', 'wallet_approve_deposit', 'wallet_approve_withdrawal', 'round_finalize_balanced', 'table_bulk_create', 'table_qr', 'table_guest_manage', 'table_cash_payment', 'table_cash_report', 'daily_referral_commission', 'table_cash_bet', 'table_correct_bet', 'round_begin_settlement', 'coverage_read', 'coverage_move', 'coverage_fund', 'coverage_reserve', 'coverage_report', 'banker_payout', 'backer_portal', 'daily_staff_round_report', 'round_open', 'round_close_with_coverage', 'round_finalize', 'table_round_summary', 'table_send_cash_report', 'platform_issue_shop_invite', 'platform_redeem_shop', 'platform_shop_invite_details', 'platform_shop_portal', 'platform_shop_control', 'platform_extend_shop_plan', 'platform_rich_menu', 'platform_save_shop_oa', 'platform_player_liff', 'platform_save_notice_recipient', 'platform_capture_notice'].includes(input.action)) fail('INVALID_ACTION');
      if (!['platform_issue_shop_invite', 'platform_redeem_shop', 'platform_shop_invite_details', 'platform_shop_portal', 'platform_shop_control', 'platform_extend_shop_plan', 'platform_rich_menu', 'platform_save_shop_oa', 'platform_player_liff', 'platform_save_notice_recipient', 'platform_capture_notice'].includes(input.action) && !/^[\w-]{1,80}$/.test(shopId)) fail('SHOP_INVALID');
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const playerRequest = ['promoter_profile', 'player_profile', 'player_state', 'table_guest_scan', 'player_place_bet', 'player_cancel_bet', 'player_bet_history', 'wallet_request', 'backer_portal'].includes(input.action);
      const channelKey = playerRequest ? 'LINE_CHANNEL_ID_PLAYER' : 'LINE_CHANNEL_ID_ADMIN';
      const shopLogin = input.shop_login === true;
      if (shopLogin && !playerRequest) fail('SHOP_LOGIN_NOT_ALLOWED', 403);
      const db = database();
      const clientId = shopLogin ? shopPlayerChannel(env, shopId, await readShopPlayerOverride(db, shopId)) : env(channelKey);
      if (shopLogin && !clientId) fail('SHOP_LOGIN_NOT_ALLOWED', 403);
      if (!clientId) fail(channelKey + '_MISSING', 503);
      if (!token || token.length > 16000) fail('LINE_AUTH_INVALID', 401);
      const identity = await verifyLineClaims(token, clientId, fetcher, input.action === 'player_state');
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
          can_manage_rich_menu: member_id === 'M0000',
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
          const liveSettings = await db.from('shop_live_links').select('shop_id,live_url');
          if (managed.error || liveSettings.error) fail('SHOP_PORTAL_UNAVAILABLE', 500);
          const liveLinks = new Map((liveSettings.data ?? []).map(row => [row.shop_id, row.live_url]));
          platformShops = (managed.data ?? []).map(({ line_oa_token, line_oa_bot_uid, ...shop }) => ({
            ...shop, oa_configured: Boolean(line_oa_bot_uid || line_oa_token?.trim()),
            live_url: liveLinks.get(shop.shop_id) ?? null,
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
      if (input.action === 'platform_player_liff') {
        if (!await canCreateShop()) fail('PLATFORM_ADMIN_REQUIRED', 403);
        const target = input.target_shop_id;
        if (typeof target !== 'string' || !/^SHOP_[0-9]{3,24}$/.test(target)) fail('SHOP_INVALID');
        const shop = await db.from('shops').select('line_oa_bot_uid,player_liff_override')
          .eq('shop_id', target).maybeSingle();
        if (shop.error) fail('SHOP_LIFF_UNAVAILABLE', 500);
        if (!shop.data) fail('SHOP_NOT_AVAILABLE', 404);
        let override = shop.data.player_liff_override;
        if (input.operation === 'save') {
          override = input.liff_url === '' ? '' : parseShopPlayerLiff(input.liff_url);
          if (override === null) fail('SHOP_LIFF_INVALID');
          if (override && !shop.data.line_oa_bot_uid) fail('SHOP_OA_NOT_CONFIGURED', 409);
          if (override && [env('LINE_CHANNEL_ID_PLAYER'), env('LINE_CHANNEL_ID_ADMIN')].includes(override.split('-')[0])) {
            fail('SHOP_LIFF_PLATFORM_CHANNEL', 409);
          }
          const saved = await db.from('shops').update({ player_liff_override: override })
            .eq('shop_id', target).select('shop_id').maybeSingle();
          if (saved.error?.code === '23505') fail('SHOP_LIFF_CHANNEL_IN_USE', 409);
          if (saved.error || !saved.data) fail('SHOP_LIFF_UNAVAILABLE', 500);
        } else if (input.operation !== 'read') fail('INVALID_ACTION');
        return reply({
          ok: true, liff_id: shopPlayerLiff(env, target, override),
          player_url: shopPlayerUrl(env, target, override),
        });
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
      if (input.action === 'platform_rich_menu') {
        const target = input.target_shop_id;
        if (typeof target !== 'string' || !/^SHOP_[0-9]{3,24}$/.test(target)) fail('SHOP_INVALID');
        const member = await db.from('users').select('uid').eq('shop_id', target).eq('uid', claims.sub)
          .eq('status', 'Active').eq('member_id', 'M0000').in('role', ['Admin', 'Superadmin']).maybeSingle();
        if (member.error) fail('RICH_MENU_UNAVAILABLE', 500);
        if (!member.data && !await canCreateShop()) fail('ADMIN_REQUIRED', 403);
        return reply({ ok: true, ...await manageShopRichMenu(db, fetcher, env, input, target) });
      }
      if (input.action === 'platform_extend_shop_plan') {
        if (!await canCreateShop()) fail('PLATFORM_ADMIN_REQUIRED', 403);
        const { target_shop_id, days, reason, request_id } = input;
        if (!/^SHOP_[0-9]{3,24}$/.test(target_shop_id) || target_shop_id === 'SHOP_000' ||
            !Number.isInteger(days) || days < 1 || days > 365 ||
            typeof reason !== 'string' || !reason.trim() || reason.trim().length > 300 ||
            typeof request_id !== 'string' || !shopInviteIdPattern.test(request_id)) fail('PLAN_EXTENSION_INVALID');
        const result = await db.rpc('extend_platform_shop_plan', {
          p_shop: target_shop_id, p_days: days, p_reason: reason.trim(), p_actor: claims.sub, p_request: request_id,
        });
        if (result.error) fail('PLAN_EXTENSION_FAILED', 500);
        if (result.data?.code !== 'EXTENDED') fail(result.data?.code || 'PLAN_EXTENSION_FAILED', 409);
        return reply({ ok: true, expires_at: result.data.expires_at });
      }
      if (input.action === 'platform_shop_control') {
        if (!await canCreateShop()) fail('PLATFORM_ADMIN_REQUIRED', 403);
        const target = input.target_shop_id;
        if (typeof target !== 'string' || !/^[\w-]{1,80}$/.test(target)) fail('SHOP_INVALID');
        if (input.setting === 'live_url') {
          if (typeof input.live_url !== 'string' || input.live_url.length > 2048) fail('LIVE_URL_INVALID');
          const value = input.live_url.trim();
          let liveUrl = null;
          if (value) {
            let parsed;
            try { parsed = new URL(value); } catch { fail('LIVE_URL_INVALID'); }
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
                !/^https:\/\//i.test(value) || parsed.href.length > 2048) fail('LIVE_URL_INVALID');
            liveUrl = parsed.href;
          }
          const saved = await db.from('shop_live_links').upsert({ shop_id: target, live_url: liveUrl });
          if (saved.error?.code === '23503') fail('SHOP_INVALID');
          if (saved.error) fail('LIVE_URL_SAVE_FAILED', 500);
          return reply({ ok: true });
        }
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
        const platformDemoInvite = !owner.data && referrer === 'SHOP_000' && await canCreateShop();
        if ((!owner.data && !platformDemoInvite) || String(shop.data?.status).toLowerCase() !== 'active') fail('REFERRER_INVALID', 403);
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
      const verifyGuestTableQr = async table => {
        if (input.table_day !== tableDay()) fail('TABLE_QR_EXPIRED', 409);
        const seat = await db.from('tables').select('qr_generation,parent_table_no')
          .eq('shop_id', shopId).eq('table_no', table).maybeSingle();
        if (seat.error) fail('PLAYER_STATE_UNAVAILABLE', 500);
        const generation = seat.data?.qr_generation ?? null;
        if (!seat.data || seat.data.parent_table_no ||
            input.table_token !== await tableQrSignature(shopId, table, input.table_day, generation)) {
          fail('TABLE_QR_INVALID', 403);
        }
        return generation;
      };
      const resolveGuestTable = async (table, register = false) => {
        const generation = await verifyGuestTableQr(table);
        const seat = await db.rpc('cash_table_guest_scan', {
          p_shop: shopId, p_table: table, p_day: input.table_day, p_generation: generation, p_uid: claims.sub,
          p_name: register ? (typeof identity.name === 'string' ? identity.name : 'สมาชิก LINE') : null,
          p_picture: register ? lineProfilePicture(identity.picture) : null,
        });
        if (seat.error) fail('PLAYER_STATE_UNAVAILABLE', 500);
        if (seat.data?.code !== 'OK') fail(seat.data?.code || 'TABLE_QR_INVALID', 409);
        return seat.data.bill ?? null;
      };
      if (input.action === 'table_guest_scan') {
        if (typeof input.table_no !== 'string' || !/^\d{1,8}$/.test(input.table_no)) fail('TABLE_INVALID');
        await resolveGuestTable(input.table_no, true);
        return reply({ ok: true });
      }
      if (input.action === 'player_state') {
        const member = await db.from('users').select('role,status').eq('shop_id', shopId).eq('uid', claims.sub).maybeSingle();
        if (member.error) fail('PLAYER_STATE_UNAVAILABLE', 500);
        if (['Cashier','Operator'].includes(member.data?.role)) {
          if (member.data.status === 'Active') fail(member.data.role === 'Cashier' ? 'CASHIER_ADMIN_REQUIRED' : 'OPERATOR_ADMIN_REQUIRED', 403);
          fail('PLAYER_ACCESS_REQUIRED', 403);
        }
        const table = input.table_no;
        if (table != null && (typeof table !== 'string' || table.length > 40)) fail('TABLE_INVALID');
        let validTable = null;
        let tableError = null;
        if (table) {
          try {
            validTable = await resolveGuestTable(table);
            if (!validTable) tableError = 'GUEST_BILL_REQUIRED';
          } catch (error) {
            if (!['TABLE_QR_EXPIRED','TABLE_QR_INVALID','TABLE_CLOSED'].includes(error.message)) throw error;
            tableError = error.message;
          }
        }
        const result = await db.rpc('read_player_live_state', {
          p_shop: shopId, p_uid: claims.sub, p_table: validTable, p_results: input.include_results === true
        });
        if (result.data && validTable) {
          const [desk, total] = await Promise.all([
            db.from('tables').select('table_name,is_open,is_hidden,cash_limit')
              .eq('shop_id', shopId).eq('table_no', validTable).maybeSingle(),
            result.data.round?.round_id
              ? db.rpc('cash_table_round_total', { p_shop: shopId, p_table: validTable, p_round: result.data.round.round_id })
              : { data: 0 },
          ]);
          if (desk.error || total.error) fail('PLAYER_STATE_UNAVAILABLE', 500);
          result.data.table_round_total = total.data;
          result.data.table_name = desk.data?.table_name ?? null;
          result.data.table_open = Boolean(desk.data?.is_open && !desk.data?.is_hidden && desk.data?.cash_limit);
        }
        if (result.error) fail('PLAYER_STATE_UNAVAILABLE', 500);
        if (!result.data) fail('PLAYER_ACCESS_REQUIRED', 403);
        if (tableError) result.data.table_error = tableError;
        return reply({ ok: true, snapshot: result.data });
      }
      if (input.action === 'backer_portal') {
        const [member, shop] = await Promise.all([
          db.from('users').select('uid,member_id,display_name,backer_wallet,backer_share,backer_water_fee')
            .eq('shop_id', shopId).eq('uid', claims.sub).eq('role', 'Backer').eq('status', 'Active').maybeSingle(),
          db.from('shops').select('status').eq('shop_id', shopId).maybeSingle(),
        ]);
        if (member.error || shop.error) fail('BANKER_PAYOUT_UNAVAILABLE', 500);
        if (!member.data || String(shop.data?.status).toLowerCase() !== 'active') fail('BACKER_REQUIRED', 403);
        if (input.operation === 'profile') {
          const logs = await db.from('backer_logs')
            .select('round_id,created_at,result_status,gap_amount,pnl_amount,wallet_balance_after')
            .eq('shop_id', shopId).eq('uid', claims.sub).order('created_at', { ascending: false }).limit(20);
          if (logs.error) fail('BANKER_PAYOUT_UNAVAILABLE', 500);
          return reply({ ok: true, member: member.data, logs: logs.data ?? [] });
        }
        if (input.operation !== 'request' || !shopInviteIdPattern.test(input.request_id) ||
            !Number.isFinite(input.amount)) fail('BANKER_PAYOUT_INVALID');
        const result = await db.rpc('record_banker_payout', {
          p_shop: shopId, p_actor: claims.sub, p_action: 'request', p_request: input.request_id,
          p_recipient: claims.sub, p_amount: input.amount,
        });
        if (result.error) fail('BANKER_PAYOUT_UNAVAILABLE', 500);
        if (result.data !== 'RECORDED') fail(result.data || 'BANKER_PAYOUT_UNAVAILABLE', 409);
        return reply({ ok: true });
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
        if (['Cashier','Operator'].includes(profile.data?.role)) {
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
          if (!wholeHundredBet(input.amount)) fail('BET_WHOLE_HUNDREDS');
          const params = {
            p_shop: shopId, p_uid: claims.sub, p_round: input.round_id, p_id: id, p_type: input.bet_type, p_amount: input.amount,
          };
          const table = input.table_no;
          let generation = null;
          if (table !== undefined) {
            if (typeof table !== 'string' || !/^\d{1,8}$/.test(table)) fail('BET_INVALID');
            generation = await verifyGuestTableQr(table);
          }
          const result = table === undefined
            ? await db.rpc('place_player_private_bet', params)
            : await db.rpc('place_guest_cash_table_bet', { ...params, p_table: table, p_day: input.table_day, p_staff: false, p_generation: generation });
          if (['BET_MINIMUM','BET_WHOLE_HUNDREDS'].includes(result.error?.message)) fail(result.error.message, 409);
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
        let liveUrl = null;
        if (shop.data.live_enabled === true) {
          const liveLink = await db.from('shop_live_links').select('live_url').eq('shop_id', shopId).maybeSingle();
          if (!liveLink.error) liveUrl = liveLink.data?.live_url ?? null;
        }
        return reply({ ok: true, staff, state: 'Approved', player: profile.data, live_enabled: shop.data.live_enabled === true, live_url: liveUrl });
      }

      // Identity always comes from LINE verification, never from input.uid/role.
      const staff = await db.from('users').select('uid,shop_id,role,status,member_id,display_name').eq('uid', claims.sub).eq('shop_id', shopId).maybeSingle();
      if (staff.error) fail('DATABASE_ERROR', 500);
      if (!staff.data || staff.data.status !== 'Active' || !['Admin', 'Superadmin', 'Operator', 'Cashier'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
      const shop = await db.from('shops').select('shop_id,status').eq('shop_id', shopId).maybeSingle();
      if (shop.error) fail('DATABASE_ERROR', 500);
      if (!shop.data || String(shop.data.status).toLowerCase() !== 'active') fail('SHOP_NOT_AVAILABLE', 403);
      if (staff.data.role === 'Operator' && !['access','query','table_qr','table_guest_manage','table_cash_payment','table_cash_bet'].includes(input.action)) {
        fail('ADMIN_REQUIRED', 403);
      }
      if (staff.data.role === 'Cashier' && !['access','query','table_qr','table_guest_manage','table_cash_payment','table_cash_bet','table_correct_bet','round_open','round_close_with_coverage','round_finalize','table_round_summary','coverage_read','coverage_reserve','coverage_report','banker_payout','daily_staff_round_report','table_cash_report','daily_referral_commission'].includes(input.action)) {
        fail('ADMIN_REQUIRED', 403);
      }
      if (input.action === 'banker_payout') {
        if (input.operation === 'report') {
          if (typeof input.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)) fail('TABLE_DATE_INVALID');
          const result = await db.rpc('daily_banker_payout_report', { p_shop: shopId, p_day: input.day });
          if (result.error) fail('BANKER_PAYOUT_UNAVAILABLE', 500);
          return reply({ ok: true, bankers: result.data });
        }
        if (!['Admin', 'Superadmin'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
        if (!['request', 'pay', 'cancel'].includes(input.operation) || !shopInviteIdPattern.test(input.request_id) ||
            (input.operation === 'request' && (typeof input.recipient !== 'string' || !input.recipient ||
              input.recipient.length > 100 || !Number.isFinite(input.amount)))) fail('BANKER_PAYOUT_INVALID');
        const result = await db.rpc('record_banker_payout', {
          p_shop: shopId, p_actor: claims.sub, p_action: input.operation, p_request: input.request_id,
          p_recipient: input.operation === 'request' ? input.recipient : null,
          p_amount: input.operation === 'request' ? input.amount : null,
        });
        if (result.error?.message === 'COVERAGE_FUNDS_RESERVED') fail('COVERAGE_FUNDS_RESERVED', 409);
        if (result.error) fail('BANKER_PAYOUT_UNAVAILABLE', 500);
        if (result.data !== 'RECORDED') fail(result.data || 'BANKER_PAYOUT_UNAVAILABLE', 409);
        return reply({ ok: true });
      }
      if (input.action === 'coverage_move') {
        if (!['Admin','Superadmin'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
        if (typeof input.recipient !== 'string' || !input.recipient || input.recipient.length > 100 ||
            !Number.isFinite(input.amount) || !shopInviteIdPattern.test(input.request_id) || !['deposit','withdraw'].includes(input.kind)) fail('COVERAGE_INVALID');
        const result = await db.rpc('move_backer_funds', {
          p_shop: shopId, p_actor: claims.sub, p_recipient: input.recipient, p_amount: input.amount, p_kind: input.kind, p_request: input.request_id,
        });
        if (result.error?.message === 'COVERAGE_FUNDS_RESERVED') fail('COVERAGE_FUNDS_RESERVED', 409);
        if (result.error) fail('COVERAGE_UNAVAILABLE', 500);
        if (result.data !== 'RECORDED') fail(result.data || 'COVERAGE_UNAVAILABLE', 409);
        return reply({ ok: true });
      }
      if (['coverage_read','coverage_fund','coverage_reserve','coverage_report'].includes(input.action)) {
        if (input.action === 'coverage_fund') {
          if (!['Admin','Superadmin'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
          if (typeof input.recipient !== 'string' || input.recipient.length > 100 ||
              !Number.isFinite(input.funded) || (input.rate != null && !Number.isFinite(input.rate))) fail('COVERAGE_INVALID');
          const result = await db.rpc('set_coverage_fund', {
            p_shop: shopId, p_actor: claims.sub, p_recipient: input.recipient, p_funded: input.funded, p_rate: input.rate ?? null,
          });
          if (result.error) fail('COVERAGE_UNAVAILABLE', 500);
          if (result.data !== 'SAVED') fail(result.data || 'COVERAGE_UNAVAILABLE', 409);
          return reply({ ok: true });
        }
        if (input.action === 'coverage_report') {
          if (typeof input.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)) fail('TABLE_DATE_INVALID');
          const result = await db.rpc('daily_round_coverage_report', { p_shop: shopId, p_day: input.day });
          if (result.error) fail('TABLE_REPORT_UNAVAILABLE', 500);
          return reply({ ok: true, coverage: result.data });
        }
        if (typeof input.round_id !== 'string' || input.round_id.length > 100) fail('INVALID_ROUND');
        if (input.action === 'coverage_read') {
          const result = await db.rpc('read_round_coverage', { p_shop: shopId, p_round: input.round_id || null });
          if (result.error) fail('COVERAGE_UNAVAILABLE', 500);
          return reply({ ok: true, coverage: result.data });
        }
        if (!input.allocations || typeof input.allocations !== 'object' || Array.isArray(input.allocations) ||
            Object.keys(input.allocations).length > 100 ||
            Object.entries(input.allocations).some(([key, amount]) => key.length > 100 || typeof amount !== 'string')) {
          fail('COVERAGE_INVALID');
        }
        const result = await db.rpc('reserve_round_coverage', {
          p_shop: shopId, p_round: input.round_id, p_allocations: input.allocations,
        });
        if (result.error) fail('COVERAGE_UNAVAILABLE', 500);
        if (result.data !== 'RESERVED') fail(result.data || 'COVERAGE_UNAVAILABLE', 409);
        return reply({ ok: true });
      }
      if (input.action === 'table_correct_bet') {
        if (!['Admin','Superadmin','Cashier'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
        const { operation, request_id, bet_id, table_no, round_id, reason, side, amount, expected_side, expected_amount } = input;
        const validSide = value => ['คู่','คี่'].includes(value);
        const validAmount = value => typeof value === 'string' && /^\d{1,9}(?:\.\d{1,2})?$/.test(value);
        if (!['add','edit','move','remove'].includes(operation) || !shopInviteIdPattern.test(request_id) ||
            !shopInviteIdPattern.test(bet_id) || typeof table_no !== 'string' || !/^\d{1,8}$/.test(table_no) ||
            typeof round_id !== 'string' || !round_id || round_id.length > 100 ||
            typeof reason !== 'string' || !reason.trim() || reason.trim().length > 300 ||
            (operation !== 'remove' && (!validSide(side) || !validAmount(amount))) ||
            (operation !== 'add' && (!validSide(expected_side) || !validAmount(expected_amount)))) fail('BET_INVALID');
        if (['add','edit'].includes(operation) && !wholeHundredBet(amount)) fail('BET_WHOLE_HUNDREDS');
        const result = await db.rpc('correct_cash_table_bet', {
          p_shop: shopId, p_actor: claims.sub, p_round: round_id, p_table: table_no, p_request: request_id,
          p_bet: bet_id, p_operation: operation, p_reason: reason.trim(),
          p_side: operation === 'remove' ? null : side, p_amount: operation === 'remove' ? null : amount,
          p_expected_side: operation === 'add' ? null : expected_side,
          p_expected_amount: operation === 'add' ? null : expected_amount,
        });
        if (result.error?.message === 'GUEST_BILL_REQUIRED') fail('GUEST_BILL_REQUIRED', 409);
        if (result.error) fail('BET_UNAVAILABLE', 500);
        if (result.data !== 'RECORDED') fail(result.data || 'BET_UNAVAILABLE', result.data === 'ADMIN_REQUIRED' ? 403 : 409);
        return reply({ ok: true });
      }
      if (input.action === 'round_open') {
        const opened = await db.rpc('open_staff_round', { p_shop: shopId });
        if (opened.error) fail('ROUND_OPEN_UNAVAILABLE', 500);
        if (opened.data?.code !== 'OPENED') fail(opened.data?.code || 'ROUND_OPEN_UNAVAILABLE', 409);
        return reply({ ok: true, round_id: opened.data.round_id });
      }
      if (input.action === 'round_close_with_coverage') {
        if (!['Admin','Superadmin','Cashier'].includes(staff.data.role)) fail('ADMIN_REQUIRED', 403);
        if (typeof input.round_id !== 'string' || !input.round_id || input.round_id.length > 100) fail('INVALID_ROUND');
        const result = await db.rpc('close_round_with_coverage', { p_shop: shopId, p_round: input.round_id });
        if (result.error) fail('COVERAGE_UNAVAILABLE', 500);
        if (!['RESERVED','BACKER_BALANCE_INSUFFICIENT'].includes(result.data?.code)) {
          fail(result.data?.code || 'COVERAGE_UNAVAILABLE', 409);
        }
        return reply({ ok: true, ...result.data });
      }
      if (input.action === 'table_round_summary') {
        if (typeof input.round_id !== 'string' || !input.round_id || input.round_id.length > 100) fail('INVALID_ROUND');
        const summary = await db.rpc('cash_table_round_summary', { p_shop: shopId, p_round: input.round_id });
        if (summary.error) fail('ROUND_SUMMARY_UNAVAILABLE', 500);
        return reply({ ok: true, totals: summary.data });
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
      if (['table_cash_report', 'table_send_cash_report', 'daily_referral_commission', 'daily_staff_round_report'].includes(input.action)) {
        if (staff.data.role === 'Operator') fail('ADMIN_REQUIRED', 403);
        if (typeof input.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.day)) fail('TABLE_DATE_INVALID');
        const date = new Date(input.day + 'T00:00:00Z');
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.day) fail('TABLE_DATE_INVALID');
        if (input.action === 'daily_staff_round_report') {
          const result = await db.rpc('daily_staff_round_report', { p_shop: shopId, p_day: input.day });
          if (result.error) fail('TABLE_REPORT_UNAVAILABLE', 500);
          return reply({ ok: true, ...result.data });
        }
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
        const reportArgs = { p_shop: shopId, p_day: input.day };
        const [result, coverage] = await Promise.all([
          db.rpc('daily_group_finance_report', reportArgs), db.rpc('daily_round_coverage_report', reportArgs),
        ]);
        if (result.error || !result.data || coverage.error) fail('TABLE_REPORT_UNAVAILABLE', 500);
        const report = dailyFinanceFlex(input.day, settings.shop_name || shopId, { ...result.data, coverage: coverage.data }, staff.data.display_name);
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
        if (!wholeHundredBet(input.amount)) fail('BET_WHOLE_HUNDREDS');
        const result = await db.rpc('place_guest_cash_table_bet', {
          p_generation: null, p_shop: shopId, p_uid: claims.sub, p_round: input.round_id, p_id: input.bet_id, p_type: input.bet_type,
          p_amount: input.amount, p_table: input.table_no, p_day: tableDay(), p_staff: true,
        });
        if (['BET_MINIMUM','BET_WHOLE_HUNDREDS'].includes(result.error?.message)) fail(result.error.message, 409);
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
      if (input.action === 'table_guest_manage') {
        const { table_no, operation, bill, name, guest, generation } = input;
        if (staff.data.role === 'Operator' && operation !== 'list') fail('ADMIN_REQUIRED', 403);
        if (typeof table_no !== 'string' || !/^\d{1,8}$/.test(table_no) ||
            !['list','add','edit','close','rotate'].includes(operation) ||
            (bill != null && (typeof bill !== 'string' || !/^\d{1,8}$/.test(bill))) ||
            (name != null && (typeof name !== 'string' || name.length > 40)) ||
            (guest != null && (typeof guest !== 'string' || !/^U[0-9a-f]{32}$/i.test(guest))) ||
            (generation != null && (typeof generation !== 'string' || !shopInviteIdPattern.test(generation)))) fail('TABLE_INVALID');
        const result = await db.rpc('manage_cash_table_guests', {
          p_shop: shopId, p_actor: claims.sub, p_table: table_no, p_action: operation,
          p_bill: bill ?? null, p_name: name ?? null, p_guest: guest ?? null, p_expected: generation ?? null,
        });
        if (result.error) fail('TABLE_GUEST_UNAVAILABLE', 500);
        if (result.data?.code !== 'OK') fail(result.data?.code || 'TABLE_GUEST_UNAVAILABLE', 409);
        return reply({ ok: true, ...result.data });
      }
      if (['table_qr', 'table_cash_payment'].includes(input.action)) {
        const table = input.table_no;
        if (typeof table !== 'string' || !/^\d{1,8}$/.test(table)) fail('TABLE_INVALID');
        if (input.action === 'table_qr') {
          const desk = await db.from('tables').select('cash_limit,is_open,is_hidden,qr_generation,parent_table_no').eq('shop_id', shopId).eq('table_no', table).maybeSingle();
          if (desk.error) fail('DATABASE_ERROR', 500);
          if (desk.data && (!desk.data.is_open || desk.data.is_hidden)) fail('TABLE_CLOSED', 409);
          if (!desk.data?.cash_limit || desk.data.parent_table_no) fail('CASH_TABLE_REQUIRED', 409);
          const day = tableDay();
          return reply({ ok: true, day, token: await tableQrSignature(shopId, table, day, desk.data.qr_generation) });
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
      if (['round_finalize','round_finalize_balanced'].includes(input.action)) {
        if (typeof input.round_id !== 'string' || !input.round_id || input.round_id.length > 100 ||
            !Number.isFinite(input.weight) || input.weight <= 0 || input.weight > 1000000) fail('ROUND_WEIGHT_INVALID');
        const rpc = input.action === 'round_finalize' ? 'finalize_staff_round' : 'finalize_balanced_round';
        const result = await db.rpc(rpc, {
          p_shop: shopId, p_round: input.round_id, p_weight: input.weight,
        });
        if (result.error?.message === 'ROUND_MARGIN_INVALID') fail('ROUND_MARGIN_INVALID', 409);
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
        if (approval.error?.message === 'COVERAGE_FUNDS_RESERVED') fail('COVERAGE_FUNDS_RESERVED', 409);
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
      if (spec.table === 'rounds' && spec.operation === 'update') {
        query = query.is('settlement_weight', null).in('status', ['Open','Closed']);
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
        if (result.error.message === 'COVERAGE_FUNDS_RESERVED') fail('COVERAGE_FUNDS_RESERVED', 409);
        if (result.error.message === 'ROUND_LOCKED') fail('ROUND_LOCKED', 409);
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
