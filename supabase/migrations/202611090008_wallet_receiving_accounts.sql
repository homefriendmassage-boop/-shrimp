begin;

-- Only a server-verified Thunder match for a registered recipient may
-- qualify for automatic Wallet credit. One account belongs to one shop.
create table public.wallet_receiving_accounts (
  shop_id text not null references public.shops (shop_id),
  bank_code text not null check (bank_code ~ '^[0-9]{3}$'),
  bank_number text not null check (bank_number ~ '^[0-9]{6,20}$'),
  auto_credit_from timestamptz,
  enabled boolean not null default true,
  primary key (bank_code, bank_number)
);

alter table public.wallet_receiving_accounts enable row level security;
revoke all on public.wallet_receiving_accounts from public, anon, authenticated;
grant select on public.wallet_receiving_accounts to service_role;

-- Once a shop switches to automatic verification, an older Player build
-- must not create a second manual transfer request for the same payment.
create function public.guard_legacy_wallet_transfer() returns trigger
language plpgsql security definer set search_path = '' as $
begin
  if new.type = 'ฝากเงิน' and new.method = 'โอนเงิน' and new.status = 'Pending'
      and exists (
        select 1 from public.wallet_receiving_accounts a
        where a.shop_id = new.shop_id and a.enabled and a.auto_credit_from <= now()
      ) then
    raise exception 'WALLET_TRANSFER_REQUIRES_VERIFICATION';
  end if;
  return new;
end;
$;

revoke all on function public.guard_legacy_wallet_transfer() from public, anon, authenticated;
create trigger guard_legacy_wallet_transfer before insert on public.topup_requests
for each row execute function public.guard_legacy_wallet_transfer();

commit;
