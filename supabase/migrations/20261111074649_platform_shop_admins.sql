create table public.platform_shop_admins (
  line_uid text primary key check (line_uid ~ '^U[0-9a-f]{32}$')
);
alter table public.platform_shop_admins enable row level security;
revoke all on public.platform_shop_admins from public, anon, authenticated;
grant select on public.platform_shop_admins to service_role;
