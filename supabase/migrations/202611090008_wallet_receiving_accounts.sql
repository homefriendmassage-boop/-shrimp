begin;

-- Only a server-verified Thunder match for a registered recipient may
-- qualify for automatic Wallet credit. One account belongs to one shop.
create table public.wallet_receiving_accounts (
  shop_id text not null references public.shops (shop_id),
  bank_code text not null check (bank_code ~ '^[0-9]{3}$'),
  bank_number text not null check (bank_number ~ '^[0-9]{6,20}$'),
  enabled boolean not null default true,
  primary key (bank_code, bank_number)
);

alter table public.wallet_receiving_accounts enable row level security;
revoke all on public.wallet_receiving_accounts from public, anon, authenticated;
grant select on public.wallet_receiving_accounts to service_role;

commit;
