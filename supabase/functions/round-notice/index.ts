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
  const secrets = JSON.parse(Deno.env.get('LINE_ROUND_WEBHOOK_SECRETS') || '{}');
  if (!await signatureValid(raw, req.headers.get('x-line-signature'), secrets[shop])) return fail('INVALID_SIGNATURE', 401);
  const { events } = JSON.parse(raw);
  if (!Array.isArray(events)) return fail('INVALID_EVENTS');
  if (!events.length) return reply({ ok: true });
  const db = database();
  const latest = new Map();
  for (const event of events) {
    const uid = event.source?.userId;
    const time = Number(event.timestamp);
    if (event.type !== 'message' || event.source?.type !== 'user' || !validUid(uid) ||
        !Number.isFinite(time) || time <= 0 || time > Date.now() + 60000) continue;
    latest.set(uid, Math.max(latest.get(uid) || 0, time));
  }
  for (const [uid, time] of latest) {
    const result = await db.rpc('record_member_chat', { p_shop: shop, p_uid: uid, p_at: new Date(time).toISOString() });
    if (result.error) return fail('ACTIVITY_SAVE_FAILED', 500);
  }
  return reply({ ok: true });
}

const noticeStates = { opened: 'Open', closed: 'Closed', result: 'Ended' };

function roundFlex(shop, round, kind) {
  const liffId = shop.liff_id_player || Deno.env.get('MEMBERSHIP_LIFF_ID_PLAYER') || '2012454809-UFGeUGbW';
  if (!/^\d+-[A-Za-z0-9]+$/.test(liffId)) throw new Error('PLAYER_LIFF_INVALID');
  const url = 'https://liff.line.me/' + liffId + '?shop=' + encodeURIComponent(shop.shop_id);
  const title = { opened: 'เปิดรอบใหม่แล้ว', closed: 'ปิดรับรอบนี้แล้ว', result: 'ประกาศผลชั่งกุ้ง' }[kind];
  return {
    type: 'flex', altText: title,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
        { type: 'text', text: String(shop.shop_name || 'บ่อตกกุ้ง').slice(0, 100), wrap: true },
        { type: 'text', text: 'รอบ ' + round.round_id, wrap: true },
        ...(kind === 'result' ? [{ type: 'text', text: 'ผล ' + round.result + ' · น้ำหนัก ' + round.weight + ' กรัม', wrap: true }] : [])
      ] },
      footer: { type: 'box', layout: 'vertical', contents: [
        { type: 'button', style: 'primary', action: { type: 'uri', label: 'เปิดหน้าเล่น', uri: url } }
      ] }
    }
  };
}

async function dispatch(db, shop, round, batches, kind) {
  const message = roundFlex(shop, round, kind);
  let accepted = 0;
  let failed = 0;
  for (const batch of batches) {
    if (kind === 'opened' && Date.now() >= Number(round.end_time_ms)) break;
    const current = await db.from('rounds').select('status').eq('shop_id', shop.shop_id).eq('round_id', round.round_id).maybeSingle();
    if (current.error || current.data?.status !== noticeStates[kind]) break;
    const to = batch.recipients.filter(validUid);
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
    if (!input || !/^SHOP_[0-9]{3,}$/.test(input.shop_id) || typeof input.round_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(input.round_id)) return fail('INVALID_ROUND');
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const clientId = Deno.env.get('LINE_CHANNEL_ID_ADMIN');
    if (!token || !clientId) return fail('LINE_AUTH_INVALID', 401);
    const verified = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST', body: new URLSearchParams({ id_token: token, client_id: clientId }), signal: AbortSignal.timeout(8000)
    });
    if (!verified.ok) return fail('LINE_AUTH_INVALID', 401);
    const claims = await verified.json();
    if (!validUid(claims.sub) || claims.aud !== clientId || !(Number(claims.exp) * 1000 > Date.now())) return fail('LINE_AUTH_INVALID', 401);
    const db = database();
    const staff = await db.from('users').select('role,status').eq('shop_id', input.shop_id).eq('uid', claims.sub).maybeSingle();
    if (staff.error) return fail('DATABASE_ERROR', 500);
    if (staff.data?.status !== 'Active' || !['Admin', 'Superadmin', 'Operator'].includes(staff.data.role)) return fail('ADMIN_REQUIRED', 403);
    const shop = await db.from('shops').select('shop_id,shop_name,status,line_oa_token,liff_id_player').eq('shop_id', input.shop_id).maybeSingle();
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
