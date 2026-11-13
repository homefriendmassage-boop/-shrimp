import { createClient } from 'npm:@supabase/supabase-js@2';

function sameSecret(value: string, expected: string) {
  if (value.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= value.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  const presented = req.headers.get('authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
  if (!presented) return new Response(null, { status: 401 });
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  try {
    const key = await db.from('shop_internal_webhook').select('secret').eq('name', 'notify-topup').maybeSingle();
    if (key.error || !key.data?.secret || !sameSecret(presented, key.data.secret)) return new Response(null, { status: 401 });

    const raw = await req.text();
    if (raw.length > 1024) return new Response(null, { status: 413 });
    const { shop_id, request_id } = JSON.parse(raw);
    if (typeof shop_id !== 'string' || !/^SHOP_[0-9]{3,24}$/.test(shop_id) ||
        !Number.isInteger(request_id) || request_id < 1) return new Response(null, { status: 400 });
    const [request, shop] = await Promise.all([
      db.from('topup_requests').select('display_name,member_id,amount,type,status')
        .eq('shop_id', shop_id).eq('id', request_id).eq('status', 'Pending').maybeSingle(),
      db.from('shop_oa_runtime').select('status,line_oa_token,liff_id_admin,admin_group_id,membership_notice_recipient_uid,line_notifications_enabled')
        .eq('shop_id', shop_id).maybeSingle(),
    ]);
    if (request.error || shop.error) return new Response(null, { status: 503 });
    const settings = shop.data;
    const item = request.data;
    const target = settings?.admin_group_id || settings?.membership_notice_recipient_uid;
    if (!item || settings?.status !== 'active' || settings.line_notifications_enabled === false ||
        !settings.line_oa_token || !/^[CUR][0-9a-f]{32}$/i.test(target ?? '')) return new Response(null, { status: 204 });
    const liff = /^\d+-[a-zA-Z0-9]+$/.test(settings.liff_id_admin ?? '') ? settings.liff_id_admin : '2012454809-41EMnP1K';
    const title = 'รายการ Wallet รอตรวจ';
    const result = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.line_oa_token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ to: target, messages: [{ type: 'flex', altText: title, contents: {
        type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: title, weight: 'bold' },
          { type: 'text', text: [item.type, item.display_name, item.member_id, '฿' + item.amount].filter(Boolean).join(' · '), wrap: true },
        ] }, footer: { type: 'box', layout: 'vertical', contents: [
          { type: 'button', style: 'primary', action: { type: 'uri', label: 'เปิดคิวรอดำเนินการ',
            uri: 'https://liff.line.me/' + liff + '?shop=' + encodeURIComponent(shop_id) + '&tab=pending' } },
        ] },
      } }] }),
    });
    return new Response(null, { status: result.ok ? 204 : 502 });
  } catch {
    return new Response(null, { status: 503 });
  }
});
