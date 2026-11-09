begin;

create table public.wallet_slip_credits (
  transaction_ref text primary key,
  shop_id text not null references public.shops (shop_id),
  uid text not null references public.users (uid),
  image_hash text not null,
  amount numeric not null check (amount > 0),
  credited_at timestamptz not null default now(),
  unique (shop_id, uid, image_hash)
);
alter table public.wallet_slip_credits enable row level security;
revoke all on public.wallet_slip_credits from public, anon, authenticated;
grant select on public.wallet_slip_credits to service_role;

create function public.credit_verified_wallet_slip(
  p_id uuid, p_shop text, p_uid text, p_ref text, p_hash text,
  p_amount numeric, p_bank text, p_number text, p_path text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  member public.users%rowtype;
begin
  if p_ref is null or length(p_ref) not between 1 and 160
      or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2)
      or p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
      or p_path is null then
    return 'INVALID_SLIP';
  end if;
  if not exists (
    select 1 from public.wallet_receiving_accounts a
    join public.shops s on s.shop_id = a.shop_id
    where a.shop_id = p_shop and a.enabled and lower(s.status) = 'active'
      and a.bank_code = p_bank and a.bank_number = p_number
  ) then
    return 'RECEIVER_MISMATCH';
  end if;

  select u.* into member from public.users u
  where u.uid = p_uid and u.shop_id = p_shop and u.status = 'Active'
    and u.role is distinct from 'Backer'
    and exists (
      select 1 from public.membership_applications a
      where a.line_uid = u.uid and a.shop_id = u.shop_id
        and a.member_id = u.member_id and a.state = 'Approved'
    )
  for update;
  if not found then return 'PLAYER_ACCESS_REQUIRED'; end if;

  if exists (select 1 from public.wallet_slip_credits
      where shop_id = p_shop and uid = p_uid and image_hash = p_hash) then
    return 'ALREADY_CREDITED';
  end if;

  if exists (select 1 from public.slip_verifications where transaction_ref = p_ref) then
    return 'DUPLICATE_SLIP';
  end if;

  insert into public.wallet_slip_credits (transaction_ref, shop_id, uid, image_hash, amount)
  values (p_ref, p_shop, p_uid, p_hash, p_amount)
  on conflict do nothing;
  if not found then return 'DUPLICATE_SLIP'; end if;

  insert into public.slip_verifications (
    id, shop_id, uid, storage_path, claimed_amount, slip_amount,
    transaction_ref, receiver_matched, is_duplicate, status, verified_at
  ) values (
    p_id, p_shop, p_uid, p_path, p_amount, p_amount,
    p_ref, true, false, 'Verified', now()
  );

  update public.users
  set credit_balance = coalesce(credit_balance, 0) + p_amount,
      total_deposit = coalesce(total_deposit, 0) + p_amount
  where uid = p_uid and shop_id = p_shop;

  insert into public.transactions (shop_id, target_id, type, amount, admin_name, target_type)
  values (p_shop, member.member_id, 'deposit', p_amount, 'Thunder', 'user');

  return 'CREDITED';
end;
$$;

revoke all on function public.credit_verified_wallet_slip(uuid,text,text,text,text,numeric,text,text,text)
  from public, anon, authenticated;
grant execute on function public.credit_verified_wallet_slip(uuid,text,text,text,text,numeric,text,text,text)
  to service_role;

commit;
