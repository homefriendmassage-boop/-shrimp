begin;

-- Stop before changing anything if both IDs already exist.
lock table public.shops in share row exclusive mode;
do $$
declare
  fk record;
begin
  if not exists (select 1 from public.shops where shop_id = 'SHOP_001')
    or exists (select 1 from public.shops where shop_id = 'SHOP_000') then
    raise exception 'Expected SHOP_001 to exist and SHOP_000 to be available.';
  end if;
  insert into public.shops
    (shop_id, shop_name, line_oa_token, admin_group_id, liff_id_player, liff_id_admin, status, created_at)
  select 'SHOP_000', 'บ่อกุ้ง DEMO', line_oa_token, admin_group_id,
    liff_id_player, liff_id_admin, status, created_at
  from public.shops where shop_id = 'SHOP_001';

  for fk in
    select c.conrelid::regclass as relation, a.attname as column_name
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    join pg_attribute target on target.attrelid = c.confrelid and target.attnum = c.confkey[1]
    where c.contype = 'f' and c.confrelid = 'public.shops'::regclass
      and cardinality(c.conkey) = 1 and target.attname = 'shop_id'
  loop
    execute format('update %s set %I = $1 where %I = $2', fk.relation, fk.column_name, fk.column_name)
      using 'SHOP_000', 'SHOP_001';
  end loop;
  delete from public.shops where shop_id = 'SHOP_001';
end $$;

create schema if not exists vault;
create extension if not exists supabase_vault with schema vault;
alter table public.shops add column owner_line_uid text;
create sequence public.merchant_shop_number;

create table public.merchant_shop_requests (
  shop_id text primary key,
  shop_name text not null,
  owner_line_uid text not null unique,
  bot_user_id text not null unique,
  token_secret_id uuid not null,
  state text not null default 'Pending' check (state in ('Pending', 'Active')),
  requested_at timestamptz not null default now(),
  activated_at timestamptz
);
alter table public.merchant_shop_requests enable row level security;
revoke all on public.merchant_shop_requests from public, anon, authenticated;
grant select on public.merchant_shop_requests to service_role;

create function public.register_merchant_shop(p_name text, p_owner text, p_bot text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request public.merchant_shop_requests%rowtype;
  code text;
  number_text text;
  secret_id uuid;
begin
  if char_length(trim(p_name)) not between 1 and 80 or p_owner !~ '^U[0-9a-fA-F]{32}$'
    or p_bot !~ '^U[0-9a-fA-F]{32}$' or nullif(trim(p_token), '') is null then
    raise exception 'INVALID_SHOP_REQUEST';
  end if;
  perform pg_advisory_xact_lock(721003);
  select * into request from public.merchant_shop_requests where owner_line_uid = p_owner;
  if found then
    return jsonb_build_object('shop_id', request.shop_id, 'state', request.state, 'shop_name', request.shop_name);
  end if;
  if exists (select 1 from public.merchant_shop_requests where bot_user_id = p_bot) then
    raise exception 'OA_ALREADY_REGISTERED';
  end if;
  loop
    number_text := nextval('public.merchant_shop_number'::regclass)::text;
    code := 'SHOP_' || lpad(number_text, greatest(3, length(number_text)), '0');
    exit when not exists (select 1 from public.shops where shop_id = code)
      and not exists (select 1 from public.merchant_shop_requests where shop_id = code);
  end loop;
  secret_id := vault.create_secret(p_token, 'merchant_messaging_' || code);
  insert into public.merchant_shop_requests(shop_id, shop_name, owner_line_uid, bot_user_id, token_secret_id)
  values (code, trim(p_name), p_owner, p_bot, secret_id);
  return jsonb_build_object('shop_id', code, 'state', 'Pending', 'shop_name', trim(p_name));
end $$;

create function public.activate_merchant_shop(p_shop text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  request public.merchant_shop_requests%rowtype;
begin
  select * into request from public.merchant_shop_requests where shop_id = p_shop for update;
  if not found then raise exception 'SHOP_REQUEST_NOT_FOUND'; end if;
  if request.state = 'Active' then
    return jsonb_build_object('shop_id', request.shop_id, 'state', 'Active');
  end if;
  insert into public.shops(shop_id, shop_name, owner_line_uid, status)
  values (request.shop_id, request.shop_name, request.owner_line_uid, 'active');
  insert into public.users(uid, shop_id, display_name, role, status)
  values (request.owner_line_uid, request.shop_id, request.shop_name, 'Admin', 'Active')
  on conflict (uid) do nothing;
  insert into public.system_settings(shop_id) values (request.shop_id);
  update public.merchant_shop_requests set state = 'Active', activated_at = now() where shop_id = p_shop;
  return jsonb_build_object('shop_id', request.shop_id, 'state', 'Active');
end $$;

create function public.read_merchant_messaging_token(p_shop text)
returns text language sql security definer set search_path = '' as $$
  select v.decrypted_secret from public.merchant_shop_requests r
  join vault.decrypted_secrets v on v.id = r.token_secret_id
  where r.shop_id = p_shop and r.state = 'Active';
$$;

revoke all on function public.register_merchant_shop(text,text,text,text),
  public.activate_merchant_shop(text), public.read_merchant_messaging_token(text)
  from public, anon, authenticated;
grant execute on function public.register_merchant_shop(text,text,text,text),
  public.activate_merchant_shop(text), public.read_merchant_messaging_token(text)
  to service_role;

commit;
