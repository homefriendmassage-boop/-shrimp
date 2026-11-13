begin;

create table public.mc_board_access (
  shop_id text primary key references public.shops(shop_id) on delete cascade,
  salt text not null check (salt ~ '^[0-9a-f]{32}$'),
  password_hash text not null check (password_hash ~ '^[0-9a-f]{64}$'),
  revision uuid not null,
  attempt_window timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10)
);
alter table public.mc_board_access enable row level security;
revoke all on public.mc_board_access from public, anon, authenticated;
grant select, insert, update on public.mc_board_access to service_role;

create function public.reserve_mc_board_attempt(p_shop text)
returns table(salt text, password_hash text, revision uuid)
language sql set search_path = '' as $$
  update public.mc_board_access a
  set attempt_count = case when a.attempt_window <= now() - interval '1 minute'
                           then 1 else a.attempt_count + 1 end,
      attempt_window = case when a.attempt_window <= now() - interval '1 minute'
                            then now() else a.attempt_window end
  where a.shop_id = p_shop
    and (a.attempt_window <= now() - interval '1 minute' or a.attempt_count < 10)
    and exists (select 1 from public.shops s where s.shop_id = p_shop and s.status = 'active')
  returning a.salt, a.password_hash, a.revision;
$$;

alter function public.read_public_cash_board(text) rename to build_mc_board;
create function public.read_mc_board(p_shop text, p_revision uuid)
returns jsonb language sql stable set search_path = '' as $$
  select public.build_mc_board(p_shop)
  from public.mc_board_access where shop_id = p_shop and revision = p_revision;
$$;

revoke all on function public.reserve_mc_board_attempt(text), public.read_mc_board(text,uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_mc_board_attempt(text), public.read_mc_board(text,uuid)
  to service_role;

commit;
