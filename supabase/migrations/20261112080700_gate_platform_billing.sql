alter table public.platform_billing_receiver
  add column enabled boolean not null default false;

create or replace function public.settle_platform_billing_order(
  p_shop text, p_order uuid, p_ref text, p_amount numeric,
  p_bank text, p_account text, p_transfer_at timestamptz
)
returns text
language plpgsql set search_path = ''
as $$
declare
  bill public.platform_billing_orders%rowtype;
  entitlement public.platform_billing_state%rowtype;
  requested_plan text;
begin
  perform 1 from public.shops where shop_id = p_shop for update;
  if not found then return 'SHOP_INVALID'; end if;
  select * into bill from public.platform_billing_orders where shop_id = p_shop and id = p_order for update;
  if not found then return 'ORDER_INVALID'; end if;
  if bill.paid_at is not null then return 'ALREADY_PAID'; end if;
  if p_ref is null or length(p_ref) not between 1 and 160 or p_amount is distinct from bill.amount::numeric
      or p_transfer_at is null or p_transfer_at < bill.created_at - interval '2 minutes'
      or p_transfer_at > now() + interval '1 minute' then return 'SLIP_INVALID'; end if;
  if not exists (select 1 from public.platform_billing_receiver
      where enabled and verified_bank_code = p_bank and verified_bank_number = p_account)
      or exists (select 1 from public.wallet_receiving_accounts
      where bank_code = p_bank and bank_number = p_account and enabled) then return 'RECEIVER_MISMATCH'; end if;
  if exists (select 1 from public.slip_verifications where transaction_ref = p_ref)
      or exists (select 1 from public.platform_billing_orders where transaction_ref = p_ref) then return 'DUPLICATE_SLIP'; end if;

  update public.platform_billing_orders set paid_at = now(), transaction_ref = p_ref where id = bill.id;
  insert into public.platform_billing_state (shop_id) values (p_shop) on conflict (shop_id) do nothing;
  select * into strict entitlement from public.platform_billing_state where shop_id = p_shop for update;

  if bill.slip_credits > 0 then
    update public.platform_billing_state set slip_balance = slip_balance + bill.slip_credits where shop_id = p_shop;
  else
    update public.platform_billing_state
    set plan_code = bill.sku,
        paid_until = case when entitlement.plan_code = bill.sku then greatest(entitlement.paid_until, now())
                          else now() end + interval '1 month'
    where shop_id = p_shop;
    select plan_code into requested_plan from public.platform_shop_plan_requests where shop_id = p_shop;
    if entitlement.plan_code is null and requested_plan in ('starter', 'basic', 'pro') then
      update public.shops set status = 'active' where shop_id = p_shop and lower(status) = 'inactive';
    end if;
  end if;
  return 'PAID';
exception when unique_violation then
  if exists (select 1 from public.platform_billing_orders where transaction_ref = p_ref) then return 'DUPLICATE_SLIP'; end if;
  raise;
end;
$$;

create or replace function public.debit_platform_slip_credit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  trial_ends timestamptz;
  entitlement public.platform_billing_state%rowtype;
begin
  if new.shop_id = 'SHOP_000' or not exists (select 1 from public.platform_billing_receiver where enabled) then return new; end if;
  select trial_ends_at into trial_ends from public.platform_shop_plan_requests
    where shop_id = new.shop_id and plan_code = 'free';
  if trial_ends is null and not exists (
    select 1 from public.platform_billing_state where shop_id = new.shop_id
  ) then return new; end if;

  insert into public.platform_billing_state (shop_id) values (new.shop_id) on conflict (shop_id) do nothing;
  select * into strict entitlement from public.platform_billing_state where shop_id = new.shop_id for update;
  if trial_ends > now() and entitlement.trial_slips_used < 30 and entitlement.plan_code is null then
    update public.platform_billing_state set trial_slips_used = trial_slips_used + 1 where shop_id = new.shop_id;
  elsif entitlement.slip_balance > 0 then
    update public.platform_billing_state set slip_balance = slip_balance - 1 where shop_id = new.shop_id;
  else
    raise exception using errcode = 'P7201', message = 'SLIP_QUOTA_EXHAUSTED';
  end if;
  return new;
end;
$$;

