alter table public.shops
  add column line_notifications_enabled boolean not null default true,
  add column membership_notice_recipient_uid text check (membership_notice_recipient_uid ~ '^U[0-9a-f]{32}$');

create or replace view public.shop_oa_runtime as
select s.shop_id, s.shop_name, s.status, s.liff_id_admin, s.liff_id_player, s.admin_group_id,
  coalesce(token.decrypted_secret, s.line_oa_token) as line_oa_token,
  webhook.decrypted_secret as webhook_secret,
  s.line_notifications_enabled, s.membership_notice_recipient_uid
from public.shops s
left join shop_oa_private.credentials c on c.shop_id = s.shop_id
left join vault.decrypted_secrets token on token.id = c.token_id
left join vault.decrypted_secrets webhook on webhook.id = c.webhook_secret_id;
