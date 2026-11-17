create table public.shop_rich_menu_pilots (
  shop_id text primary key references public.shops(shop_id) on delete cascade,
  member_uid text
);
alter table public.shop_rich_menu_pilots enable row level security;
revoke all on public.shop_rich_menu_pilots from public, anon, authenticated;
grant select on public.shop_rich_menu_pilots to service_role;

create table public.shop_rich_menus (
  shop_id text primary key references public.shops(shop_id) on delete restrict,
  draft jsonb,
  bot_uid text unique,
  published_id text,
  publish_lock uuid,
  publish_started_at timestamptz
);
create table public.shop_rich_menu_versions (
  menu_id text primary key,
  shop_id text not null references public.shop_rich_menus(shop_id) on delete restrict,
  bot_uid text not null
);
create table public.shop_rich_menu_members (
  shop_id text not null references public.shop_rich_menus(shop_id) on delete restrict,
  oa_uid text not null,
  applied_id text,
  refresh_after timestamptz not null default now(),
  lease uuid,
  primary key (shop_id, oa_uid)
);
alter table public.shop_rich_menus enable row level security;
alter table public.shop_rich_menu_versions enable row level security;
alter table public.shop_rich_menu_members enable row level security;
revoke all on public.shop_rich_menus, public.shop_rich_menu_versions, public.shop_rich_menu_members from public, anon, authenticated;
grant select, insert, update on public.shop_rich_menus, public.shop_rich_menu_versions, public.shop_rich_menu_members to service_role;

create function public.finish_shop_rich_menu(p_shop text, p_lock uuid, p_bot text, p_menu text)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.shop_rich_menus set bot_uid = p_bot, published_id = p_menu, publish_lock = null
    where shop_id = p_shop and publish_lock = p_lock and (bot_uid is null or bot_uid = p_bot);
  if not found then return false; end if;
  insert into public.shop_rich_menu_versions (menu_id, shop_id, bot_uid) values (p_menu, p_shop, p_bot);
  return true;
end;
$$;

create function public.claim_shop_rich_menu_sync()
returns table(shop_id text, oa_uid text, menu_id text, lease uuid, token text, known_menus text[])
language plpgsql set search_path = '' as $$
begin
  insert into public.shop_rich_menu_members (shop_id, oa_uid)
  select m.shop_id, l.oa_uid
    from public.shop_rich_menus m
    join public.shop_rich_menu_pilots p on p.shop_id = m.shop_id
    join public.shops s on s.shop_id = m.shop_id and s.line_oa_bot_uid = m.bot_uid
    join public.shop_oa_member_links l on l.shop_id = m.shop_id and l.bot_uid = m.bot_uid
    join public.users u on u.shop_id = l.shop_id and u.uid = l.member_uid
    join public.membership_applications a on a.shop_id = u.shop_id and a.line_uid = u.uid
    where lower(s.status) = 'active' and m.published_id is not null
      and u.status = 'Active' and u.role <> 'Cashier' and a.state = 'Approved'
      and (p.member_uid is null or p.member_uid = u.uid)
    on conflict do nothing;

  return query
  with candidates as (
    select j.shop_id, j.oa_uid,
      case when lower(s.status) = 'active' and exists (
        select 1 from public.shop_oa_member_links l
        join public.users u on u.shop_id = l.shop_id and u.uid = l.member_uid
        join public.membership_applications a on a.shop_id = u.shop_id and a.line_uid = u.uid
        join public.shop_rich_menu_pilots p on p.shop_id = l.shop_id
        where (p.member_uid is null or p.member_uid = u.uid) and l.shop_id = j.shop_id and l.bot_uid = m.bot_uid and l.oa_uid = j.oa_uid
          and u.status = 'Active' and u.role <> 'Cashier' and a.state = 'Approved'
      ) then m.published_id end as target,
      j.applied_id, j.lease, j.refresh_after, o.line_oa_token
    from public.shop_rich_menu_members j
    join public.shop_rich_menus m on m.shop_id = j.shop_id
    join public.shops s on s.shop_id = m.shop_id and s.line_oa_bot_uid = m.bot_uid
    join public.shop_oa_runtime o on o.shop_id = m.shop_id
    where o.line_oa_token is not null
  ), selected as (
    select c.* from candidates c
    join public.shop_rich_menu_members j using (shop_id, oa_uid)
    where (c.lease is null or c.refresh_after <= now())
      and (c.target is distinct from c.applied_id or c.refresh_after <= now())
    order by c.refresh_after, c.shop_id, c.oa_uid
    limit 24 for update of j skip locked
  ), leased as (
    update public.shop_rich_menu_members as j set lease = gen_random_uuid(), refresh_after = now() + interval '2 minutes'
    from selected c where j.shop_id = c.shop_id and j.oa_uid = c.oa_uid
    returning j.shop_id, j.oa_uid, c.target, j.lease, c.line_oa_token
  )
  select j.shop_id, j.oa_uid, j.target, j.lease, j.line_oa_token,
    array(select v.menu_id from public.shop_rich_menu_versions v where v.shop_id = j.shop_id)
  from leased j;
end;
$$;

create function public.authorize_shop_rich_menu_worker(p_secret text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from vault.decrypted_secrets where name = 'shop_rich_menu_worker'
    and decrypted_secret = p_secret and length(p_secret) = 64);
$$;

revoke all on function public.finish_shop_rich_menu(text,uuid,text,text),
  public.claim_shop_rich_menu_sync(), public.authorize_shop_rich_menu_worker(text) from public, anon, authenticated;
grant execute on function public.finish_shop_rich_menu(text,uuid,text,text),
  public.claim_shop_rich_menu_sync(), public.authorize_shop_rich_menu_worker(text) to service_role;


create extension if not exists pg_cron;
create extension if not exists pg_net;

create function public.schedule_shop_rich_menu_worker(p_endpoint text)
returns bigint language plpgsql set search_path = '' as $$
declare
  worker_secret text;
begin
  if p_endpoint !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/admin-api$' then
    raise exception 'Invalid worker endpoint';
  end if;
  if not exists (select 1 from vault.secrets where name = 'shop_rich_menu_worker') then
    worker_secret := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    perform vault.create_secret(worker_secret, 'shop_rich_menu_worker');
  end if;
  return cron.schedule('shop-rich-menu-sync', '* * * * *', format(
    'select net.http_post(url := %L, headers := jsonb_build_object(''Content-Type'',''application/json'',''Authorization'',''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''shop_rich_menu_worker'')), body := ''{"action":"rich_menu_worker"}''::jsonb, timeout_milliseconds := 25000)',
    p_endpoint));
end;
$$;
revoke all on function public.schedule_shop_rich_menu_worker(text) from public, anon, authenticated, service_role;
