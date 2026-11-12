create table public.platform_billing_products (
  sku text primary key,
  label text not null,
  kind text not null check (kind in ('plan', 'slips')),
  amount integer not null check (amount > 0),
  slip_credits integer not null default 0 check (slip_credits >= 0),
  check ((kind = 'slips') = (slip_credits > 0))
);

insert into public.platform_billing_products (sku, label, kind, amount, slip_credits) values
  ('starter', 'Starter', 'plan', 990, 0),
  ('basic', 'Basic', 'plan', 1490, 0),
  ('pro', 'Pro', 'plan', 2490, 0),
  ('slip100', 'เริ่มต้น', 'slips', 100, 100),
  ('slip300', 'ประหยัด', 'slips', 270, 300),
  ('slip500', 'คุ้มค่า', 'slips', 425, 500),
  ('slip1000', 'ร้านยอดนิยม', 'slips', 790, 1000),
  ('slip3000', 'แพ็กเกจร้านใหญ่', 'slips', 2190, 3000);

create table public.platform_billing_receiver (
  id boolean primary key default true check (id),
  transfer_method text not null check (transfer_method in ('promptpay', 'bank')),
  transfer_number text not null check (transfer_number ~ '^[0-9]{8,20}$'),
  recipient_name text not null check (length(btrim(recipient_name)) between 1 and 150),
  bank_name text check (transfer_method <> 'bank' or length(btrim(coalesce(bank_name, ''))) > 0),
  verified_bank_code text not null check (verified_bank_code ~ '^[0-9]{3}$'),
  verified_bank_number text not null check (verified_bank_number ~ '^[0-9]{8,20}$')
);

create table public.platform_billing_state (
  shop_id text primary key references public.shops(shop_id) on delete cascade,
  plan_code text references public.platform_billing_products(sku)
    check (plan_code in ('starter', 'basic', 'pro')),
  paid_until timestamptz,
  slip_balance bigint not null default 0 check (slip_balance >= 0),
  trial_slips_used integer not null default 0 check (trial_slips_used between 0 and 30),
  check ((plan_code is null) = (paid_until is null))
);

create table public.platform_billing_orders (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null references public.shops(shop_id) on delete cascade,
  sku text not null references public.platform_billing_products(sku),
  amount integer not null check (amount > 0),
  slip_credits integer not null check (slip_credits >= 0),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  transaction_ref text unique,
  check ((paid_at is null) = (transaction_ref is null))
);
create unique index platform_billing_pending_sku
  on public.platform_billing_orders (shop_id, sku) where paid_at is null;
create index platform_billing_shop_order_history
  on public.platform_billing_orders (shop_id, created_at desc);

alter table public.platform_billing_products enable row level security;
alter table public.platform_billing_receiver enable row level security;
alter table public.platform_billing_state enable row level security;
alter table public.platform_billing_orders enable row level security;
revoke all on public.platform_billing_products, public.platform_billing_receiver,
  public.platform_billing_state, public.platform_billing_orders from public, anon, authenticated;
grant select on public.platform_billing_products, public.platform_billing_receiver,
  public.platform_billing_state, public.platform_billing_orders to service_role;
grant insert, update on public.platform_billing_orders, public.platform_billing_state to service_role;

create function public.create_platform_billing_order(p_shop text, p_sku text)
returns public.platform_billing_orders
language sql set search_path = ''
as $$
  insert into public.platform_billing_orders (shop_id, sku, amount, slip_credits)
  select p_shop, sku, amount, slip_credits from public.platform_billing_products where sku = p_sku
  on conflict (shop_id, sku) where paid_at is null do update set sku = excluded.sku
  returning *;
$$;

create function public.settle_platform_billing_order(
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
      where verified_bank_code = p_bank and verified_bank_number = p_account)
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

create function public.debit_platform_slip_credit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  trial_ends timestamptz;
  entitlement public.platform_billing_state%rowtype;
begin
  if new.shop_id = 'SHOP_000' or not exists (select 1 from public.platform_billing_receiver) then return new; end if;
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

revoke all on function public.create_platform_billing_order(text,text),
  public.settle_platform_billing_order(text,uuid,text,numeric,text,text,timestamptz),
  public.debit_platform_slip_credit() from public, anon, authenticated;
grant execute on function public.create_platform_billing_order(text,text),
  public.settle_platform_billing_order(text,uuid,text,numeric,text,text,timestamptz) to service_role;

create trigger debit_platform_slip_credit
after insert on public.wallet_slip_credits
for each row execute function public.debit_platform_slip_credit();
