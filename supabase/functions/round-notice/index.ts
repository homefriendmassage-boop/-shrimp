import { createClient } from 'npm:@supabase/supabase-js@2';

const origin = Deno.env.get('WEB_ORIGIN') || 'https://homefriendmassage-boop.github.io';
const headers = {
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const fail = (code, status = 400) => reply({ ok: false, code }, status);
const validUid = value => typeof value === 'string' && /^U[0-9a-f]{32}$/i.test(value);

function database() {
  const url = Deno.env.get('SUPABASE_URL');
  let key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  try {
    const named = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    if (typeof named.default === 'string' && named.default.startsWith('sb_secret_')) key = named.default;
  } catch { /* Legacy service role key remains available. */ }
  if (!url || !key) throw new Error('SUPABASE_CONFIG_MISSING');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signatureValid(raw, signature, secret) {
  if (!signature || !secret) return false;
  try {
    const bytes = Uint8Array.from(atob(signature), character => character.charCodeAt(0));
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(raw));
  } catch { return false; }
}

async function recordWebhook(req, shop) {
  if (!/^SHOP_[0-9]{3,}$/.test(shop)) return fail('SHOP_INVALID');
  const raw = await req.text();
  const db = database();
  const configured = await db.from('shop_oa_runtime').select('webhook_secret').eq('shop_id', shop).maybeSingle();
  if (configured.error) return fail('DATABASE_ERROR', 500);
  const secret = configured.data?.webhook_secret || Deno.env.get('LINE_ROUND_WEBHOOK_SECRET_' + shop)?.trim() ||
    JSON.parse(Deno.env.get('LINE_ROUND_WEBHOOK_SECRETS') || '{}')[shop];
  if (!await signatureValid(raw, req.headers.get('x-line-signature'), secret)) return fail('INVALID_SIGNATURE', 401);
  const { events, destination } = JSON.parse(raw);
  const registered = await db.from('shops').select('line_oa_bot_uid').eq('shop_id', shop).maybeSingle();
  if (registered.error) return fail('DATABASE_ERROR', 500);
  const bot = registered.data?.line_oa_bot_uid;
  if (bot && destination !== bot) return fail('WRONG_OA', 403);
  if (!Array.isArray(events)) return fail('INVALID_EVENTS');
  if (!events.length) return reply({ ok: true });
  const latest = new Map();
  for (const event of events) {
    const uid = event.source?.userId;
    const time = Number(event.timestamp);
    const capture = event.type === 'message' && event.message?.type === 'text' &&
      /^รับไอดี ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(event.message.text?.trim() ?? '');
    if (capture) {
      const group = event.source?.groupId;
      const isGroup = event.source?.type === 'group' && /^C[0-9a-f]{32}$/.test(group ?? '');
      const recipient = isGroup ? group : event.source?.type === 'user' && validUid(uid) ? uid : null;
      if (recipient) {
        const saved = await db.from('shop_notice_capture').update({ recipient_id: recipient })
          .eq('shop_id', shop).eq('code', capture[1]).eq('kind', isGroup ? 'group' : 'owner')
          .gt('expires_at', new Date().toISOString()).is('recipient_id', null);
        if (saved.error) return fail('NOTICE_CAPTURE_FAILED', 500);
      }
      continue;
    }
    if (event.type !== 'message' || event.source?.type !== 'user' || !validUid(uid) ||
        !Number.isFinite(time) || time <= 0 || time > Date.now() + 60000) continue;
    const code = event.message?.type === 'text' && /^ผูกแจ้งเตือน ([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.exec(event.message.text?.trim() ?? '');
    if (bot && code) {
      const linked = await db.rpc('complete_shop_oa_link', { p_shop: shop, p_bot: bot, p_code: code[1], p_sender: uid });
      if (linked.error) return fail('OA_LINK_SAVE_FAILED', 500);
    }
    latest.set(uid, Math.max(latest.get(uid) || 0, time));
  }
  for (const [uid, time] of latest) {
    const result = await db.rpc('record_member_chat', { p_shop: shop, p_uid: uid, p_at: new Date(time).toISOString() });
    if (result.error) return fail('ACTIVITY_SAVE_FAILED', 500);
  }
  return reply({ ok: true });
}

async function memberOaLink(db, shopId, uid, start) {
  const registered = await db.from('shops').select('line_oa_bot_uid,status').eq('shop_id', shopId).maybeSingle();
  if (registered.error) return fail('DATABASE_ERROR', 500);
  if (registered.data?.status !== 'active') return fail('SHOP_NOT_AVAILABLE', 403);
  const bot = registered.data.line_oa_bot_uid;
  if (!validUid(bot)) return reply({ ok: true, available: false });
  const [application, member] = await Promise.all([
    db.from('membership_applications').select('state').eq('shop_id', shopId).eq('line_uid', uid).maybeSingle(),
    db.from('users').select('status,role').eq('shop_id', shopId).eq('uid', uid).maybeSingle()
  ]);
  if (application.error || member.error) return fail('DATABASE_ERROR', 500);
  const canLink = application.data?.state === 'Pending' ||
    (member.data?.status === 'Active' && (application.data?.state === 'Approved' ||
      ['Admin', 'Operator', 'Superadmin'].includes(member.data.role)));
  if (!canLink) return fail('MEMBERSHIP_REQUIRED', 403);
  const existing = await db.rpc('resolve_shop_oa_recipient', { p_shop: shopId, p_member: uid });
  if (existing.error) return fail('DATABASE_ERROR', 500);
  if (existing.data || !start) return reply({ ok: true, available: true, linked: Boolean(existing.data) });

  const credential = await db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', shopId).maybeSingle();
  if (credential.error) return fail('DATABASE_ERROR', 500);
  if (!credential.data?.line_oa_token) return fail('SHOP_OA_TOKEN_MISSING', 422);
  const response = await fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + credential.data.line_oa_token },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) return fail('OA_INFO_UNAVAILABLE', 502);
  const info = await response.json();
  if (info.userId !== bot || !/^@[a-zA-Z0-9._-]{1,40}$/.test(info.basicId)) return fail('WRONG_OA', 409);
  const code = crypto.randomUUID();
  const challenge = await db.from('shop_oa_link_challenges').upsert({
    shop_id: shopId, member_uid: uid, bot_uid: bot, code, expires_at: new Date(Date.now() + 600000).toISOString()
  }, { onConflict: 'shop_id,member_uid' });
  if (challenge.error) return fail('OA_LINK_SAVE_FAILED', 500);
  const chatUrl = 'https://line.me/R/oaMessage/' + encodeURIComponent(info.basicId) + '/?' +
    encodeURIComponent('ผูกแจ้งเตือน ' + code);
  return reply({ ok: true, available: true, linked: false, chat_url: chatUrl });
}

const noticeStates = { opened: 'Open', closed: 'Closed', result: 'Ended' };

const flexColors = { dark: '#141721', panel: '#1B1F2D', white: '#FFFFFF', muted: '#A3ADBF',
  green: '#10B981', red: '#F43F42', blue: '#397DF1', lightBlue: '#BFD9FF' };
const flexText = (text, color, options = {}) => ({ type: 'text', text: String(text), color, wrap: true, ...options });
const flexBox = (contents, options = {}) => ({ type: 'box', layout: 'vertical', spacing: 'sm', contents, ...options });
const flexButton = (label, uri, color) => ({ type: 'button', style: 'primary', height: 'sm', color, action: { type: 'uri', label, uri } });
const money = value => '฿' + Number(value).toLocaleString('th-TH', { maximumFractionDigits: 2 });

function playerLink(shop) {
  return 'https://liff.line.me/2012454809-UFGeUGbW?shop=' + encodeURIComponent(shop.shop_id);
}

function roundFlex(shop, round, kind) {
  const c = flexColors;
  const uri = playerLink(shop);
  const title = { opened: 'เปิดรับแทงแล้ว!', closed: 'ปิดรับแทงแล้ว', result: 'ประกาศผลชั่งกุ้ง' }[kind];
  let bubble;
  if (kind === 'opened') {
    const minutes = Math.max(1, Math.ceil((Number(round.end_time_ms) - Date.now()) / 60000));
    bubble = {
      body: flexBox([
        flexText('📢 ' + title, c.green, { weight: 'bold', size: 'lg' }),
        flexText('รอบใหม่: ' + round.round_id, c.white, { weight: 'bold', size: 'sm' }),
        flexText('หมดเวลาในอีก ' + minutes + ' นาที 🦐', c.muted, { size: 'sm' })
      ], { backgroundColor: c.dark }),
      footer: flexBox([flexButton('เข้าเล่นรอบนี้', uri, c.red)], { backgroundColor: c.dark })
    };
  } else if (kind === 'closed') {
    bubble = { body: flexBox([
      flexText('⏳ [รอบ: ' + round.round_id + '] ปิดรับแทงแล้ว!', '#233755', { weight: 'bold', size: 'sm' }),
      flexText('รอแอดมินชั่งกุ้งและประกาศผลครับ 🦐', '#233755', { size: 'sm' })
    ], { backgroundColor: c.lightBlue }) };
  } else {
    const row = (label, value, color = c.white) => ({
      type: 'box', layout: 'horizontal', spacing: 'sm',
      contents: [flexText(label, c.muted, { size: 'sm', flex: 2 }),
        flexText(value, color, { size: 'sm', flex: 3, weight: 'bold', align: 'end' })]
    });
    const outcome = round.result === 'คู่' ? c.blue : c.red;
    const footer = [flexButton('เล่นรอบถัดไป', uri, c.blue)];
    if (round.win_count > 0) footer.unshift(flexText('🎉 ยินดีกับผู้ชนะ ' + round.win_count + ' บิล', c.green, { align: 'center', size: 'sm', weight: 'bold' }));
    bubble = {
      header: flexBox([flexText(title + ' 🦐', c.white, { align: 'center', weight: 'bold', size: 'lg' })], { backgroundColor: c.panel }),
      body: flexBox([
        row('รอบที่', round.round_id), row('น้ำหนัก', round.weight + ' กรัม'),
        { type: 'separator', color: '#303747', margin: 'md' },
        row('ผลที่ออก', round.result + ' ชนะ!', outcome)
      ], { backgroundColor: c.dark }),
      footer: flexBox(footer, { backgroundColor: c.panel })
    };
  }
  return { type: 'flex', altText: title + ' · ' + round.round_id, contents: { type: 'bubble', size: 'mega', ...bubble } };
}

function creditFlex(shop, transaction, account) {
  const c = flexColors;
  const deposit = transaction.type === 'deposit';
  const title = deposit ? '🎉 เติมเครดิตสำเร็จ' : '💸 ถอนเครดิตสำเร็จ';
  const accent = deposit ? c.green : c.red;
  const wallet = account.role === 'Backer';
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble', size: 'mega',
      header: flexBox([flexText(title, c.white, { weight: 'bold', align: 'center' })], { backgroundColor: accent }),
      body: flexBox([
        flexText('แอดมินดำเนินการให้คุณเรียบร้อยแล้ว', '#444444', { size: 'sm' }),
        flexText('จำนวนเงิน: ' + money(transaction.amount), accent, { size: 'lg', weight: 'bold' }),
        flexText((wallet ? 'ยอดกระเป๋ารับจบคงเหลือ: ' : 'ยอดเครดิตคงเหลือปัจจุบัน: ') + money(wallet ? account.backer_wallet : account.credit_balance), '#666666', { size: 'sm' })
      ], { backgroundColor: c.white }),
      footer: flexBox([flexButton('เข้าสู่ระบบ (หน้าเล่น)', playerLink(shop), c.blue)], { backgroundColor: c.white })
    }
  };
}

async function creditNotice(db, shop, transactionId) {
  if (!Number.isSafeInteger(transactionId) || transactionId < 1) return fail('INVALID_TRANSACTION');
  const record = await db.from('transactions').select('id,target_id,type,amount,created_at')
    .eq('shop_id', shop.shop_id).eq('id', transactionId).eq('target_type', 'user').maybeSingle();
  if (record.error) return fail('DATABASE_ERROR', 500);
  const transaction = record.data;
  const age = Date.now() - Date.parse(transaction?.created_at);
  if (!transaction || !['deposit', 'withdraw'].includes(transaction.type) || !(Number(transaction.amount) > 0) ||
      !Number.isFinite(age) || age < -60000 || age > 10 * 60000) return fail('TRANSACTION_NOT_AVAILABLE', 404);
  const member = await db.from('users').select('uid,role,credit_balance,backer_wallet,status')
    .eq('shop_id', shop.shop_id).eq('member_id', transaction.target_id).maybeSingle();
  if (member.error) return fail('DATABASE_ERROR', 500);
  if (member.data?.status !== 'Active' || !validUid(member.data.uid)) return fail('MEMBER_NOT_AVAILABLE', 404);
  if (!shop.line_oa_token) return fail('SHOP_OA_TOKEN_MISSING', 422);
  const recipient = await db.rpc('resolve_shop_oa_recipient', { p_shop: shop.shop_id, p_member: member.data.uid });
  if (recipient.error) return fail('DATABASE_ERROR', 500);
  if (!recipient.data) return reply({ ok: true, skipped: true, accepted: false, code: 'OA_ACCOUNT_NOT_LINKED' });
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode('credit-notice:' + shop.shop_id + ':' + transaction.id))).slice(0, 16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const retryKey = [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + shop.line_oa_token, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey },
    body: JSON.stringify({ to: recipient.data, messages: [creditFlex(shop, transaction, member.data)] }),
    signal: AbortSignal.timeout(6000)
  });
  if (!response.ok && !(response.status === 409 && response.headers.has('x-line-accepted-request-id'))) {
    return fail('LINE_PUSH_HTTP_' + response.status, 502);
  }
  return reply({ ok: true, accepted: true });
}

async function dispatch(db, shop, round, batches, kind) {
  const message = roundFlex(shop, round, kind);
  let accepted = 0;
  let failed = 0;
  for (const batch of batches) {
    if (kind === 'opened' && Date.now() >= Number(round.end_time_ms)) break;
    const current = await db.from('rounds').select('status').eq('shop_id', shop.shop_id).eq('round_id', round.round_id).maybeSingle();
    if (current.error || current.data?.status !== noticeStates[kind]) break;
    const recipients = await db.rpc('resolve_shop_oa_recipients', { p_shop: shop.shop_id, p_members: batch.recipients });
    if (recipients.error) {
      failed += batch.recipients.length;
      continue;
    }
    const to = (recipients.data ?? []).filter(validUid);
    if (!to.length) continue;
    try {
      const response = await fetch('https://api.line.me/v2/bot/message/multicast', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + shop.line_oa_token,
          'Content-Type': 'application/json', 'X-Line-Retry-Key': batch.id
        },
        body: JSON.stringify({ to, messages: [message] }),
        signal: AbortSignal.timeout(6000)
      });
      if (!response.ok && !(response.status === 409 && response.headers.has('x-line-accepted-request-id'))) {
        failed += to.length;
        console.error('round notice LINE status', response.status);
        continue;
      }
      accepted += to.length;
      const saved = await db.from('round_notice_batches').update({ sent_at: new Date().toISOString() })
        .eq('id', batch.id).eq('shop_id', shop.shop_id);
      if (saved.error) console.error('round notice could not record acceptance');
    } catch {
      failed += to.length;
      console.error('round notice request failed');
    }
  }
  return { accepted, failed };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
  try {
    const url = new URL(req.url);
    if (url.searchParams.has('webhook_shop')) return await recordWebhook(req, url.searchParams.get('webhook_shop'));
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return fail('ORIGIN_NOT_ALLOWED', 403);
    const input = await req.json();
    const kind = input?.kind ?? 'opened';
    if (!Object.hasOwn(noticeStates, kind)) return fail('INVALID_NOTICE_KIND');
    const creditRequest = input?.action === 'credit_notice';
    const linkRequest = ['oa_link_status', 'oa_link_start'].includes(input?.action);
    if (!input || !/^SHOP_[0-9]{3,}$/.test(input.shop_id)) return fail('SHOP_INVALID');
    if (!creditRequest && !linkRequest && (typeof input.round_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.round_id))) return fail('INVALID_ROUND');
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const clientId = Deno.env.get(linkRequest ? 'LINE_CHANNEL_ID_PLAYER' : 'LINE_CHANNEL_ID_ADMIN');
    if (!token || !clientId) return fail('LINE_AUTH_INVALID', 401);
    const verified = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST', body: new URLSearchParams({ id_token: token, client_id: clientId }), signal: AbortSignal.timeout(8000)
    });
    if (!verified.ok) return fail('LINE_AUTH_INVALID', 401);
    const claims = await verified.json();
    if (!validUid(claims.sub) || claims.aud !== clientId || !(Number(claims.exp) * 1000 > Date.now())) return fail('LINE_AUTH_INVALID', 401);
    const db = database();
    if (linkRequest) return await memberOaLink(db, input.shop_id, claims.sub, input.action === 'oa_link_start');
    const staff = await db.from('users').select('role,status').eq('shop_id', input.shop_id).eq('uid', claims.sub).maybeSingle();
    if (staff.error) return fail('DATABASE_ERROR', 500);
    const allowedRoles = creditRequest ? ['Admin', 'Superadmin', 'Operator'] : ['Admin', 'Superadmin', 'Operator', 'Cashier'];
    if (staff.data?.status !== 'Active' || !allowedRoles.includes(staff.data.role)) return fail('ADMIN_REQUIRED', 403);
    const shop = await db.from('shop_oa_runtime').select('shop_id,shop_name,status,line_oa_token,line_notifications_enabled').eq('shop_id', input.shop_id).maybeSingle();
    if (shop.error) return fail('DATABASE_ERROR', 500);
    if (shop.data?.line_notifications_enabled === false) return reply({ ok: true, skipped: true, eligible: 0, accepted: 0, failed: 0 });
    if (shop.data?.status !== 'active') return fail('SHOP_NOT_AVAILABLE', 403);
    if (creditRequest) return await creditNotice(db, shop.data, input.transaction_id);
    const round = await db.from('rounds').select('round_id,status,end_time_ms,result,weight').eq('shop_id', input.shop_id).eq('round_id', input.round_id).maybeSingle();
    if (shop.error || round.error) return fail('DATABASE_ERROR', 500);
    if (shop.data?.status !== 'active' || round.data?.status !== noticeStates[kind] ||
        (kind === 'opened' && !(Number(round.data.end_time_ms) > Date.now()))) {
      return fail('ROUND_STATE_CHANGED', 409);
    }
    if (kind === 'result' && (round.data.result == null || round.data.weight == null)) return fail('ROUND_RESULT_MISSING', 409);
    const batches = await db.from('round_notice_batches').select('id,recipients,sent_at')
      .eq('shop_id', input.shop_id).eq('round_id', input.round_id).eq('kind', kind).order('batch_no');
    if (batches.error) return fail('DATABASE_ERROR', 500);
    const jobs = batches.data ?? [];
    const eligible = jobs.reduce((count, job) => count + job.recipients.length, 0);
    const unsent = jobs.filter(job => !job.sent_at);
    const alreadyAccepted = jobs.filter(job => job.sent_at).reduce((count, job) => count + job.recipients.length, 0);
    if (!unsent.length) return reply({ ok: true, eligible, accepted: alreadyAccepted, failed: 0 });
    if (kind === 'result') {
      const wins = await db.from('bets').select('bet_id', { count: 'exact', head: true })
        .eq('shop_id', input.shop_id).eq('round_id', input.round_id).eq('status', 'Win');
      if (!wins.error) round.data.win_count = wins.count;
    }
    if (!shop.data.line_oa_token) return fail('SHOP_OA_TOKEN_MISSING', 422);
    if (unsent.length <= 2) {
      const result = await dispatch(db, shop.data, round.data, unsent, kind);
      return reply({ ok: true, eligible, accepted: alreadyAccepted + result.accepted, failed: result.failed });
    }
    EdgeRuntime.waitUntil(dispatch(db, shop.data, round.data, unsent, kind).catch(() => console.error('round notice dispatch failed')));
    return reply({ ok: true, eligible, accepted: alreadyAccepted, queued: true });
  } catch {
    console.error('round notice request failed');
    return fail('SERVER_ERROR', 500);
  }
});