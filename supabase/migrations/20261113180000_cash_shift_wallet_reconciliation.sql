begin;

create table public.cash_shift_closes (
  shop_id text not null,
  accounting_day date not null,
  shift_id uuid not null,
  shift_name text not null,
  opening_cash numeric(14,2) not null check (opening_cash >= 0),
  cash_received numeric(14,2) not null check (cash_received >= 0),
  cash_paid numeric(14,2) not null check (cash_paid >= 0),
  transfer_received numeric(14,2) not null check (transfer_received >= 0),
  transfer_paid numeric(14,2) not null check (transfer_paid >= 0),
  bank_withdrawal numeric(14,2) not null check (bank_withdrawal >= 0),
  bank_deposit numeric(14,2) not null check (bank_deposit >= 0),
  expenses jsonb not null check (jsonb_typeof(expenses) = 'array'),
  cash_expenses numeric(16,2) not null check (cash_expenses >= 0),
  transfer_expenses numeric(16,2) not null check (transfer_expenses >= 0),
  counted_cash numeric(14,2) not null check (counted_cash >= 0),
  expected_cash numeric generated always as
    (opening_cash + cash_received - cash_paid + bank_withdrawal - bank_deposit - cash_expenses) stored,
  cash_difference numeric generated always as
    (counted_cash - (opening_cash + cash_received - cash_paid + bank_withdrawal - bank_deposit - cash_expenses)) stored,
  note text not null,
  closed_by text not null,
  closed_at timestamptz not null default statement_timestamp(),
  primary key (shop_id, accounting_day, shift_id)
);

create table public.wallet_reconciliation_start (
  singleton boolean primary key check (singleton),
  started_at timestamptz not null
);
create table public.wallet_reconciliation_baselines (
  shop_id text primary key,
  balance numeric not null
);
create table public.wallet_balance_movements (
  id bigint generated always as identity primary key,
  shop_id text not null,
  member_id text,
  recorded_at timestamptz not null default clock_timestamp(),
  before_balance numeric not null,
  after_balance numeric not null,
  delta numeric generated always as (after_balance - before_balance) stored
);
create index wallet_balance_movements_shop_time
  on public.wallet_balance_movements (shop_id, recorded_at, id);

alter table public.cash_shift_closes enable row level security;
alter table public.wallet_reconciliation_start enable row level security;
alter table public.wallet_reconciliation_baselines enable row level security;
alter table public.wallet_balance_movements enable row level security;
revoke all on public.cash_shift_closes, public.wallet_reconciliation_start,
  public.wallet_reconciliation_baselines, public.wallet_balance_movements from public, anon, authenticated, service_role;
grant select, insert on public.cash_shift_closes to service_role;
grant select on public.wallet_reconciliation_start, public.wallet_reconciliation_baselines,
  public.wallet_balance_movements to service_role;

create schema if not exists shop_finance_private;
revoke all on schema shop_finance_private from public, anon, authenticated, service_role;

create function shop_finance_private.record_wallet_balance_movement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  previous numeric := 0;
  current_balance numeric := 0;
begin
  if tg_op <> 'INSERT' and old.role is distinct from 'Backer' then
    previous := greatest(old.credit_balance, 0);
  end if;
  if tg_op <> 'DELETE' and new.role is distinct from 'Backer' then
    current_balance := greatest(new.credit_balance, 0);
  end if;
  if tg_op = 'UPDATE' and old.shop_id is distinct from new.shop_id then
    if previous <> 0 and old.shop_id is not null then
      insert into public.wallet_balance_movements (shop_id, member_id, before_balance, after_balance)
      values (old.shop_id, old.member_id, previous, 0);
    end if;
    previous := 0;
  end if;
  if previous <> current_balance then
    if tg_op = 'DELETE' and old.shop_id is not null then
      insert into public.wallet_balance_movements (shop_id, member_id, before_balance, after_balance)
      values (old.shop_id, old.member_id, previous, 0);
    elsif tg_op <> 'DELETE' and new.shop_id is not null then
      insert into public.wallet_balance_movements (shop_id, member_id, before_balance, after_balance)
      values (new.shop_id, new.member_id, previous, current_balance);
    end if;
  end if;
  return null;
end;
$$;
revoke all on function shop_finance_private.record_wallet_balance_movement() from public, anon, authenticated, service_role;

create function public.wallet_daily_reconciliation(p_shop text, p_day date, p_page integer)
returns jsonb language sql stable set search_path = '' as $$
  with bounds as (
    select (p_day + time '06:00') at time zone 'Asia/Bangkok' as starts,
      (p_day + 1 + time '06:00') at time zone 'Asia/Bangkok' as ends,
      started_at, statement_timestamp() as observed_at
    from public.wallet_reconciliation_start
  ), movements as (
    select coalesce(sum(m.delta) filter (where m.recorded_at < b.starts),0) as prior,
      coalesce(sum(m.delta) filter (where m.recorded_at >= b.starts and m.delta > 0),0) as increases,
      coalesce(-sum(m.delta) filter (where m.recorded_at >= b.starts and m.delta < 0),0) as decreases,
      count(*) filter (where m.recorded_at >= b.starts) as movement_count
    from public.wallet_balance_movements m cross join bounds b
    where m.shop_id=p_shop and m.recorded_at < least(b.ends,b.observed_at)
  ), entries as (
    select m.id,m.recorded_at,m.member_id,m.before_balance,m.after_balance,m.delta
    from public.wallet_balance_movements m cross join bounds b
    where m.shop_id=p_shop and m.recorded_at >= b.starts and m.recorded_at < least(b.ends,b.observed_at)
    order by m.recorded_at desc,m.id desc limit 50 offset (greatest(p_page,0)::bigint * 50)
  ), balances as (
    select b.*, m.*, coalesce(base.balance,0)+m.prior as opening
    from bounds b cross join movements m
    left join public.wallet_reconciliation_baselines base on base.shop_id=p_shop
  )
  select jsonb_build_object(
    'coverage', case when observed_at < starts then 'future' when ends <= started_at then 'none'
      when starts < started_at then 'partial' else 'full' end,
    'opening_at', greatest(starts,started_at), 'closing_at', least(ends,observed_at),
    'opening', case when ends > started_at and observed_at >= starts then opening end,
    'increases', increases, 'decreases', decreases, 'movement_count', movement_count,
    'closing', case when ends > started_at and observed_at >= starts then opening+increases-decreases end,
    'current_balance', (
      select coalesce(sum(u.credit_balance),0) from public.users u
      where u.shop_id=p_shop and u.role is distinct from 'Backer' and u.credit_balance>0
    ),
    'is_open_day', observed_at >= starts and observed_at < ends,
    'entries', (select coalesce(jsonb_agg(to_jsonb(e) order by e.recorded_at desc,e.id desc),'[]'::jsonb) from entries e)
  ) from balances;
$$;
revoke all on function public.wallet_daily_reconciliation(text,date,integer) from public, anon, authenticated;
grant execute on function public.wallet_daily_reconciliation(text,date,integer) to service_role;

-- Drain writes before taking the opening baseline and installing the trigger.
lock table public.users in share row exclusive mode;
insert into public.wallet_reconciliation_start values (true,clock_timestamp());
insert into public.wallet_reconciliation_baselines
select u.shop_id,sum(u.credit_balance) from public.users u
where u.shop_id is not null and u.role is distinct from 'Backer' and u.credit_balance>0 group by u.shop_id;
create trigger track_wallet_balance after insert or delete or update of credit_balance, role, shop_id
on public.users for each row execute function shop_finance_private.record_wallet_balance_movement();

commit;
