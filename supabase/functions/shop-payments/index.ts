import { createClient } from 'npm:@supabase/supabase-js@2';

export function createShopPaymentsHandler({ env, fetcher = fetch, createDb = createClient }) {
  const origin = env('WEB_ORIGIN') || 'https://homefriendmassage-boop.github.io';
  const headers = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'Vary': 'Origin',
  };
  const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
  const fail = (code, status = 400) => reply({ ok: false, code }, status);
  const uidPattern = /^U[0-9a-f]{32}$/i;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const digits = value => typeof value === 'string' ? value.replace(/[ -]/g, '') : '';

  async function verifiedBankAccount(bank, number) {
    const key = env('THUNDER_API_KEY');
    if (!key) return null;
    for (let page = 1; page <= 10; page++) {
      const endpoint = new URL('https://api.thunder.in.th/v2/bank-accounts');
      endpoint.search = new URLSearchParams({ bankCode: bank, page: String(page), limit: '100' }).toString();
      const result = await fetcher(endpoint, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(5000) });
      if (!result.ok) return null;
      const data = (await result.json()).data;
      const rows = data?.items;
      if (!Array.isArray(rows)) return null;
      const account = rows.find(item => item.bankCode === bank && digits(item.bankNumber) === number && item.extraVerify !== 'NAME');
      if (account) return String(account.nameTh || account.nameEn || '').trim().slice(0, 150) || null;
      if (rows.length < 100) return null;
    }
    return null;
  }

  async function sendWithdrawalReceipt(db, shop, uid, id) {
    const draft = await db.from('wallet_withdrawal_confirmations').select('amount,chat_receipt_sent_at')
      .eq('id', id).eq('shop_id', shop).eq('uid', uid).maybeSingle();
    if (draft.error || !draft.data) return 'RECEIPT_PENDING';
    if (draft.data.chat_receipt_sent_at) return 'ALREADY_QUEUED';
    const [target, oa] = await Promise.all([
      db.rpc('resolve_shop_oa_recipient', { p_shop: shop, p_member: uid }),
      db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', shop).maybeSingle(),
    ]);
    if (target.error || oa.error || !uidPattern.test(target.data) || !oa.data?.line_oa_token) return 'RECEIPT_PENDING';
    const amount = Number(draft.data.amount).toFixed(2);
    const sent = await fetcher('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + oa.data.line_oa_token, 'Content-Type': 'application/json', 'X-Line-Retry-Key': id },
      body: JSON.stringify({ to: target.data, messages: [{
        type: 'text', text: 'ยืนยันคำขอถอนเงิน ฿' + amount + ' แล้ว\nโปรดรอร้านโอนเงินเข้าบัญชีที่แจ้งไว้',
      }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!sent.ok && !(sent.status === 409 && sent.headers.has('x-line-accepted-request-id'))) return 'RECEIPT_PENDING';
    await db.from('wallet_withdrawal_confirmations').update({ chat_receipt_sent_at: new Date().toISOString() })
      .eq('id', id).eq('shop_id', shop).eq('uid', uid).is('chat_receipt_sent_at', null);
    return 'QUEUED';
  }

  return async request => {
    if (request.headers.get('origin') && request.headers.get('origin') !== origin) return fail('ORIGIN_INVALID', 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
    const token = request.headers.get('authorization')?.match(/^Bearer (\S{1,16000})$/i)?.[1];
    if (!token) return fail('LINE_AUTH_INVALID', 401);
    try {
      if (Number(request.headers.get('content-length')) > 4096) return fail('FORM_INVALID', 413);
      const raw = await request.text();
      if (raw.length > 4096) return fail('FORM_INVALID', 413);
      let input;
      try { input = JSON.parse(raw); } catch { return fail('FORM_INVALID'); }
      const shop = input?.shop_id;
      if (typeof shop !== 'string' || !/^SHOP_[0-9]{3,24}$/.test(shop)) return fail('SHOP_INVALID');
      const action = input?.action;
      const staff = ['settings', 'save_settings', 'destinations', 'billing_bank', 'wallet_review'].includes(action);
      if (!staff && !['receiver', 'withdraw_start', 'withdraw_confirm'].includes(action)) return fail('INVALID_ACTION');
      const shopLogin = input.shop_login === true;
      if (shopLogin && (staff || shop !== 'SHOP_001')) return fail('SHOP_LOGIN_NOT_ALLOWED', 403);
      const channel = shopLogin ? '2009043114' : env(staff ? 'LINE_CHANNEL_ID_ADMIN' : 'LINE_CHANNEL_ID_PLAYER');
      const url = env('SUPABASE_URL');
      const key = env('SUPABASE_SERVICE_ROLE_KEY');
      if (!channel || !url || !key) return fail('PAYMENTS_UNAVAILABLE', 503);
      const verified = await fetcher('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST', body: new URLSearchParams({ id_token: token, client_id: channel }),
        signal: AbortSignal.timeout(8000),
      });
      if (!verified.ok) return fail('LINE_AUTH_INVALID', 401);
      const claims = await verified.json();
      if (!uidPattern.test(claims.sub) || claims.aud !== channel || !(Number(claims.exp) * 1000 > Date.now())) return fail('LINE_AUTH_INVALID', 401);
      const db = createDb(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      let uid = claims.sub;
      if (shopLogin) {
        const mapped = await db.rpc('resolve_shop_oa_member', { p_shop: shop, p_oa_uid: uid });
        if (mapped.error || !uidPattern.test(mapped.data)) return fail('PLAYER_ACCESS_REQUIRED', 403);
        uid = mapped.data;
      }
      const [member, store] = await Promise.all([
        db.from('users').select('role,status,member_id,credit_balance,backer_wallet').eq('shop_id', shop).eq('uid', uid).maybeSingle(),
        db.from('shops').select('status').eq('shop_id', shop).maybeSingle(),
      ]);
      if (member.error || store.error) return fail('PAYMENTS_UNAVAILABLE', 503);
      if (member.data?.status !== 'Active') return fail('MEMBERSHIP_REQUIRED', 403);
      if (staff) {
        const roles = ['destinations', 'wallet_review'].includes(action) ? ['Admin', 'Superadmin', 'Operator'] : ['Admin', 'Superadmin'];
        if (!roles.includes(member.data.role)) return fail('ADMIN_REQUIRED', 403);
      } else {
        if (String(store.data?.status).toLowerCase() !== 'active') return fail('SHOP_NOT_AVAILABLE', 403);
        const approved = await db.from('membership_applications').select('member_id').eq('shop_id', shop)
          .eq('line_uid', uid).eq('state', 'Approved').maybeSingle();
        if (approved.error || approved.data?.member_id !== member.data.member_id) return fail('PLAYER_ACCESS_REQUIRED', 403);
      }
      if (action === 'billing_bank') {
        if (member.data.member_id !== 'M0000' || !uuid.test(input.order_id)) return fail('OWNER_REQUIRED', 403);
        const [order, receiver] = await Promise.all([
          db.from('platform_billing_orders').select('id').eq('shop_id', shop).eq('id', input.order_id).maybeSingle(),
          db.from('platform_billing_receiver').select('verified_bank_number').eq('enabled', true)
            .eq('transfer_number', digits(input.transfer_number)).maybeSingle(),
        ]);
        if (order.error || receiver.error || !order.data || !receiver.data) return fail('PAYMENTS_UNAVAILABLE', 409);
        return reply({ ok: true, bank_account: receiver.data.verified_bank_number });
      }
      if (action === 'settings' || action === 'receiver') {
        const profile = await db.from('shop_payment_profiles').select('bank_code,bank_number,account_name,promptpay')
          .eq('shop_id', shop).maybeSingle();
        if (profile.error) return fail('PAYMENTS_UNAVAILABLE', 503);
        return reply({ ok: true, receiver: profile.data });
      }
      const bank = input.bank_code;
      const number = digits(input.bank_number);
      if (action === 'save_settings') {
        const promptpay = digits(input.promptpay);
        if (typeof bank !== 'string' || !/^\d{3}$/.test(bank) || !/^\d{6,20}$/.test(number) ||
            !/^(0\d{9}|\d{13}|\d{15})$/.test(promptpay)) return fail('RECEIVER_INVALID');
        const name = await verifiedBankAccount(bank, number);
        if (!name) return fail('THUNDER_RECEIVER_NOT_LINKED', 409);
        const saved = await db.rpc('set_shop_payment_profile', {
          p_shop: shop, p_bank: bank, p_number: number, p_name: name, p_promptpay: promptpay,
        });
        if (saved.error || saved.data !== 'SAVED') return fail(saved.data || 'PAYMENTS_UNAVAILABLE', 409);
        return reply({ ok: true, account_name: name });
      }
      if (action === 'destinations') {
        const pending = await db.from('topup_requests').select('withdrawal_confirmation_id')
          .eq('shop_id', shop).eq('status', 'Pending').not('withdrawal_confirmation_id', 'is', null);
        if (pending.error) return fail('PAYMENTS_UNAVAILABLE', 503);
        const ids = pending.data.map(item => item.withdrawal_confirmation_id);
        if (!ids.length) return reply({ ok: true, destinations: [] });
        const found = await db.from('wallet_withdrawal_confirmations').select('request_id,bank_code,bank_number')
          .eq('shop_id', shop).in('id', ids);
        if (found.error) return fail('PAYMENTS_UNAVAILABLE', 503);
        return reply({ ok: true, destinations: found.data });
      }
      if (action === 'wallet_review') {
        if (!Number.isInteger(input.request_id) || input.request_id < 1 || input.request_id > 2147483647) {
          return fail('WALLET_REQUEST_INVALID');
        }
        const pending = await db.from('topup_requests').select('wallet_slip_id,uid')
          .eq('shop_id', shop).eq('id', input.request_id).eq('status', 'Pending').maybeSingle();
        if (pending.error) return fail('PAYMENTS_UNAVAILABLE', 503);
        if (!pending.data?.wallet_slip_id) return fail('REQUEST_NOT_PENDING', 409);

        const review = await db.from('slip_verifications').select('claimed_amount,slip_amount,error_code,storage_path,transaction_ref')
          .eq('shop_id', shop).eq('uid', pending.data.uid).eq('id', pending.data.wallet_slip_id)
          .eq('status', 'ReviewRequired').maybeSingle();
        if (review.error || !review.data?.storage_path) return fail('PAYMENTS_UNAVAILABLE', 503);
        const signed = await db.storage.from('slips-private').createSignedUrl(review.data.storage_path, 300);
        if (signed.error || !signed.data?.signedUrl) return fail('PAYMENTS_UNAVAILABLE', 503);
        return reply({ ok: true, review: {
          claimed_amount: review.data.claimed_amount, slip_amount: review.data.slip_amount,
          reason: review.data.error_code, transaction_ref: review.data.transaction_ref, image_url: signed.data.signedUrl,
        } });
      }
      if (action === 'withdraw_confirm') {
        if (typeof input.confirmation_id !== 'string' || !uuid.test(input.confirmation_id)) return fail('WITHDRAWAL_INVALID');
        const result = await db.rpc('confirm_wallet_withdrawal', { p_shop: shop, p_uid: uid, p_id: input.confirmation_id });
        if (result.error || result.data !== 'QUEUED') return fail(result.data || 'PAYMENTS_UNAVAILABLE', 409);
        const code = await sendWithdrawalReceipt(db, shop, uid, input.confirmation_id).catch(() => 'RECEIPT_PENDING');
        return reply({ ok: true, code });
      }
      const amount = input.amount;
      if (typeof amount !== 'string' || !/^\d{1,9}(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 ||
          typeof bank !== 'string' || !/^\d{3}$/.test(bank) || !/^\d{6,20}$/.test(number)) return fail('WITHDRAWAL_INVALID');
      const balance = member.data.role === 'Backer' ? member.data.backer_wallet : member.data.credit_balance;
      if (Number(amount) > Number(balance || 0)) return fail('WALLET_INSUFFICIENT_BALANCE', 409);
      const [target, oa] = await Promise.all([
        db.rpc('resolve_shop_oa_recipient', { p_shop: shop, p_member: uid }),
        db.from('shop_oa_runtime').select('line_oa_token').eq('shop_id', shop).maybeSingle(),
      ]);
      if (target.error || oa.error || !uidPattern.test(target.data) || !oa.data?.line_oa_token) return fail('LINE_OA_LINK_REQUIRED', 409);
      const deliveryKey = input.delivery_key;
      if (typeof deliveryKey !== 'string' || !uuid.test(deliveryKey)) return fail('WITHDRAWAL_INVALID');
      const draft = await db.from('wallet_withdrawal_confirmations').upsert({
        delivery_key: deliveryKey, shop_id: shop, uid, amount, bank_code: bank, bank_number: number,
      }, { onConflict: 'delivery_key', ignoreDuplicates: true });
      if (draft.error) return fail('PAYMENTS_UNAVAILABLE', 503);
      const stored = await db.from('wallet_withdrawal_confirmations').select('id,amount,bank_code,bank_number,expires_at')
        .eq('delivery_key', deliveryKey).eq('shop_id', shop).eq('uid', uid).maybeSingle();
      if (stored.error || Number(stored.data?.amount) !== Number(amount) ||
          stored.data?.bank_code !== bank || stored.data?.bank_number !== number ||
          !(Date.parse(stored.data.expires_at) > Date.now())) return fail('WITHDRAWAL_INVALID', 409);
      const link = new URL('https://liff.line.me/' + (env('MEMBERSHIP_LIFF_ID_PLAYER') || '2012454809-UFGeUGbW'));
      link.searchParams.set('shop', shop);
      link.searchParams.set('withdraw_confirm', stored.data.id);
      const total = Number(amount).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const sent = await fetcher('https://api.line.me/v2/bot/message/push', {
        method: 'POST', headers: { Authorization: 'Bearer ' + oa.data.line_oa_token, 'Content-Type': 'application/json', 'X-Line-Retry-Key': deliveryKey },
        body: JSON.stringify({ to: target.data, messages: [{
          type: 'flex', altText: 'ยืนยันคำขอถอนเงิน', contents: {
            type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
              { type: 'text', text: 'ยืนยันคำขอถอนเงิน', weight: 'bold', size: 'lg' },
              { type: 'text', text: 'โปรดตรวจสอบยอดถอน ฿' + total + ' เข้าบัญชีเลขที่ ' + number, wrap: true },
              { type: 'text', text: 'กดยืนยันเพื่อส่งเข้าคิวรอโอนเงิน', wrap: true },
            ] }, footer: { type: 'box', layout: 'vertical', contents: [
              { type: 'button', style: 'primary', action: { type: 'uri', label: 'ยืนยันถอนเงิน', uri: link.href } },
            ] },
          },
        }] }), signal: AbortSignal.timeout(8000),
      });
      if (!sent.ok && !(sent.status === 409 && sent.headers.has('x-line-accepted-request-id'))) return fail('LINE_CONFIRM_UNAVAILABLE', 502);
      return reply({ ok: true, code: 'LINE_CONFIRM_SENT' });
    } catch {
      return fail('PAYMENTS_UNAVAILABLE', 503);
    }
  };
}

Deno.serve(createShopPaymentsHandler({ env: name => Deno.env.get(name) }));
