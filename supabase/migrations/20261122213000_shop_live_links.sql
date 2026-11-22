create table public.shop_live_links (
  shop_id text primary key references public.shops(shop_id) on delete cascade,
  live_url text check (live_url is null or (length(live_url) <= 2048 and live_url like 'https://%'))
);

alter table public.shop_live_links enable row level security;
revoke all on public.shop_live_links from public, anon, authenticated;
grant select, insert, update on public.shop_live_links to service_role;
