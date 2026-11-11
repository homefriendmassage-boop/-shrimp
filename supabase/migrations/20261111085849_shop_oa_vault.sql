create schema shop_oa_private;
revoke all on schema shop_oa_private from public, anon, authenticated;

create table shop_oa_private.credentials (
  shop_id text primary key references public.shops(shop_id) on delete restrict,
  bot_uid text not null unique check (bot_uid ~ '^U[0-9a-f]{32}$'),
  token_id uuid not null,
  webhook_secret_id uuid not null
);
alter table shop_oa_private.credentials enable row level security;
alter table public.shops add column line_oa_bot_uid text;

create view public.shop_oa_runtime as
select s.shop_id, s.shop_name, s.status, s.liff_id_admin, s.liff_id_player, s.admin_group_id,
  coalesce(token.decrypted_secret, s.line_oa_token) as line_oa_token,
  webhook.decrypted_secret as webhook_secret
from public.shops s
left join shop_oa_private.credentials c on c.shop_id = s.shop_id
left join vault.decrypted_secrets token on token.id = c.token_id
left join vault.decrypted_secrets webhook on webhook.id = c.webhook_secret_id;

revoke all on public.shop_oa_runtime from public, anon, authenticated, service_role;
grant select on public.shop_oa_runtime to service_role;

create function public.save_shop_oa(p_shop text, p_bot text, p_token text, p_secret text)
returns text language plpgsql security definer set search_path = '' as $save_oa$
declare
  current_oa shop_oa_private.credentials%rowtype;
begin
  if p_bot is null or p_bot !~ '^U[0-9a-f]{32}$'
      or p_token is null or length(p_token) not between 20 and 4096
      or p_secret is null or p_secret !~ '^[0-9a-fA-F]{32}$' then
    return 'OA_DETAILS_INVALID';
  end if;
  perform 1 from public.shops where shop_id = p_shop for update;
  if not found then return 'SHOP_NOT_FOUND'; end if;
  if exists (select 1 from public.shops where shop_id <> p_shop and line_oa_token = p_token) then
    return 'OA_ALREADY_LINKED';
  end if;
  select * into current_oa from shop_oa_private.credentials where shop_id = p_shop;
  if found then
    update shop_oa_private.credentials set bot_uid = p_bot where shop_id = p_shop;
    perform vault.update_secret(current_oa.token_id, p_token);
    perform vault.update_secret(current_oa.webhook_secret_id, p_secret);
  else
    insert into shop_oa_private.credentials(shop_id, bot_uid, token_id, webhook_secret_id)
    values (p_shop, p_bot, vault.create_secret(p_token), vault.create_secret(p_secret));
  end if;
  update public.shops set line_oa_bot_uid = p_bot where shop_id = p_shop;
  return 'SAVED';
exception
  when unique_violation then return 'OA_ALREADY_LINKED';
end;
$save_oa$;
revoke all on function public.save_shop_oa(text,text,text,text) from public, anon, authenticated;
grant execute on function public.save_shop_oa(text,text,text,text) to service_role;
