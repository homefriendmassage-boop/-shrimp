begin;
create table public.shop_notice_capture (
  code uuid primary key default gen_random_uuid(),
  shop_id text not null references public.shops(shop_id),
  created_by text not null,
  kind text not null check (kind in ('owner','group')),
  expires_at timestamptz not null default now() + interval '10 minutes',
  recipient_id text,
  unique (shop_id, created_by, kind)
);
alter table public.shop_notice_capture enable row level security;
revoke all on public.shop_notice_capture from public, anon, authenticated;
grant select, insert, update on public.shop_notice_capture to service_role;

alter table public.tables add column cash_limit numeric check (cash_limit between 0.01 and 999999999);
alter table public.bets add column cash_table boolean not null default false;
alter table public.transactions add column cash_table_no text, add column cash_entry_id uuid unique;

create function public.shop_accounting_day(p_time timestamptz)
returns date language sql immutable set search_path = '' as $$
  select ((p_time at time zone 'Asia/Bangkok') - interval '6 hours')::date;
$$;

create function public.place_player_cash_table_bet(
  p_shop text, p_uid text, p_round text, p_id uuid, p_type text, p_amount numeric,
  p_table text, p_day date, p_staff boolean
) returns jsonb language plpgsql set search_path = '' as $$
declare
  current_round public.rounds%rowtype;
  existing public.bets%rowtype;
  desk public.tables%rowtype;
  limits public.system_settings%rowtype;
begin
  if p_id is null or p_type is null or p_type not in ('คู่', 'คี่')
    or p_amount is null or p_amount not between 0.01 and 999999999
    or p_amount <> round(p_amount, 2) then return jsonb_build_object('code','BET_INVALID'); end if;
  select r.* into current_round from public.rounds r where r.shop_id = p_shop
    order by r.created_at desc nulls last, r.round_id desc limit 1 for update;
  if not exists (
    select 1 from public.users u join public.shops s on s.shop_id = u.shop_id
    where u.shop_id = p_shop and u.uid = p_uid and u.status = 'Active'
      and lower(s.status) = 'active'
      and (case when p_staff then u.role in ('Admin','Superadmin','Operator') else
        u.role is distinct from 'Promoter' and exists (
          select 1 from public.membership_applications a where a.shop_id = u.shop_id
            and a.line_uid = u.uid and a.member_id = u.member_id and a.state = 'Approved'
        ) end)
  ) then return jsonb_build_object('code','PLAYER_ACCESS_REQUIRED'); end if;

  select * into existing from public.bets where bet_id = p_id;
  if found then
    if existing.shop_id = p_shop and existing.uid = p_uid and existing.round_id = p_round
      and existing.amount = p_amount and existing.bet_type = p_type and existing.cash_table
      and existing.table_no = p_table then return jsonb_build_object('code','PLACED','bet_id',p_id); end if;
    return jsonb_build_object('code','BET_INVALID');
  end if;
  if p_day is distinct from public.shop_accounting_day(clock_timestamp()) then
    return jsonb_build_object('code','TABLE_QR_EXPIRED');
  end if;
  if current_round.round_id is distinct from p_round or current_round.status is distinct from 'Open'
    or current_round.end_time_ms is null or current_round.end_time_ms <= extract(epoch from clock_timestamp()) * 1000 then
    return jsonb_build_object('code','ROUND_CLOSED');
  end if;
  select * into limits from public.system_settings where shop_id = p_shop;
  if p_amount not between coalesce(limits.min_bet,20) and coalesce(limits.max_bet,5000) then
    return jsonb_build_object('code','BET_LIMIT','min',coalesce(limits.min_bet,20),'max',coalesce(limits.max_bet,5000));
  end if;
  select * into desk from public.tables where shop_id = p_shop and table_no = p_table for update;
  if not found or desk.cash_limit is null then return jsonb_build_object('code','CASH_TABLE_REQUIRED'); end if;
  if coalesce(desk.credit,0) - p_amount < -desk.cash_limit then
    return jsonb_build_object('code','TABLE_CREDIT_LIMIT');
  end if;
  insert into public.bets (bet_id,shop_id,round_id,uid,table_no,bet_type,amount,status,play_mode,payout,cash_table)
    values (p_id,p_shop,p_round,p_uid,p_table,p_type,p_amount,'Active','table',0,true);
  update public.tables set credit = coalesce(credit,0) - p_amount where id = desk.id;
  return jsonb_build_object('code','PLACED','bet_id',p_id);
end;
$$;

create function public.record_cash_table_payment(
  p_shop text, p_table text, p_id uuid, p_type text, p_amount numeric, p_staff text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  desk public.tables%rowtype;
  prior public.transactions%rowtype;
  balance numeric;
begin
  if p_id is null or p_type is null or p_type not in ('deposit','withdraw')
    or p_amount is null or p_amount not between 0.01 and 999999999 or p_amount <> round(p_amount,2) then
    return jsonb_build_object('code','AMOUNT_INVALID');
  end if;
  select * into desk from public.tables where shop_id = p_shop and table_no = p_table for update;
  if not found or desk.cash_limit is null then return jsonb_build_object('code','CASH_TABLE_REQUIRED'); end if;
  select * into prior from public.transactions where cash_entry_id = p_id;
  if found then
    if prior.shop_id = p_shop and prior.cash_table_no = p_table and prior.type = p_type and prior.amount = p_amount then
      return jsonb_build_object('code','RECORDED','balance',desk.credit);
    end if;
    return jsonb_build_object('code','AMOUNT_INVALID');
  end if;
  if exists (select 1 from public.bets where shop_id = p_shop and table_no = p_table and cash_table and status = 'Active') then
    return jsonb_build_object('code','CASH_TABLE_WAITING_RESULT');
  end if;
  balance := coalesce(desk.credit,0);
  if (p_type = 'deposit' and p_amount > -balance) or (p_type = 'withdraw' and p_amount > balance) then
    return jsonb_build_object('code','CASH_AMOUNT_EXCEEDS_BALANCE');
  end if;
  balance := balance + case when p_type = 'deposit' then p_amount else -p_amount end;
  update public.tables set credit = balance where id = desk.id;
  insert into public.transactions (shop_id,target_id,type,amount,admin_name,target_type,cash_table_no,cash_entry_id)
    values (p_shop,'โต๊ะ ' || p_table,p_type,p_amount,p_staff,'table',p_table,p_id);
  return jsonb_build_object('code','RECORDED','balance',balance);
end;
$$;

create function public.cash_table_daily_report(p_shop text,p_day date)
returns jsonb language sql stable set search_path = '' as $$
  with report_window as (
    select (p_day + time '06:00') at time zone 'Asia/Bangkok' as start_at,
           (p_day + 1 + time '06:00') at time zone 'Asia/Bangkok' as end_at
  ), bills as (
    select b.table_no, coalesce(sum(b.amount) filter (where b.status <> 'Cancelled'),0) as played,
      coalesce(sum(b.payout) filter (where b.status = 'Win'),0) as won,
      coalesce(sum(b.amount) filter (where b.status = 'Cancelled'),0) as cancelled,
      count(*) filter (where b.status = 'Active') as pending
    from public.bets b cross join report_window w
    where b.shop_id = p_shop and b.cash_table and b.created_at >= w.start_at and b.created_at < w.end_at
    group by b.table_no
  ), cash as (
    select t.cash_table_no as table_no, coalesce(sum(t.amount) filter (where t.type = 'deposit'),0) as received,
      coalesce(sum(t.amount) filter (where t.type = 'withdraw'),0) as paid
    from public.transactions t cross join report_window w
    where t.shop_id = p_shop and t.cash_table_no is not null and t.created_at >= w.start_at and t.created_at < w.end_at
    group by t.cash_table_no
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'table_no',table_no,'played',coalesce(played,0),'won',coalesce(won,0),'cancelled',coalesce(cancelled,0),
    'pending',coalesce(pending,0),'received',coalesce(received,0),'paid',coalesce(paid,0)
  ) order by table_no),'[]'::jsonb)
  from bills full join cash using (table_no);
$$;

-- Cash payouts and cancellations follow the bill transition atomically,
-- including on the legacy unbalanced-round settlement path.
create function public.adjust_cash_table_on_bet_result()
returns trigger language plpgsql set search_path = '' as $$
declare adjustment numeric;
begin
  adjustment := case new.status when 'Cancelled' then old.amount when 'Win' then new.payout else 0 end;
  if adjustment > 0 then
    update public.tables set credit = coalesce(credit,0) + adjustment
      where shop_id = old.shop_id and table_no = old.table_no;
    if not found then raise exception 'CASH_TABLE_NOT_FOUND'; end if;
  end if;
  return new;
end;
$$;
revoke all on function public.adjust_cash_table_on_bet_result() from public, anon, authenticated;
grant execute on function public.adjust_cash_table_on_bet_result() to service_role;
create trigger adjust_cash_table_on_bet_result after update of status on public.bets
for each row when (old.cash_table and old.status = 'Active' and new.status in ('Cancelled','Win','Lose'))
execute function public.adjust_cash_table_on_bet_result();

create function public.guard_cash_table_removal()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.cash_limit is not null and (coalesce(old.credit,0) <> 0 or exists (
    select 1 from public.bets where shop_id = old.shop_id and table_no = old.table_no
      and cash_table and status = 'Active'
  )) then raise exception 'CASH_TABLE_OPEN_BALANCE'; end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_cash_table_removal() from public, anon, authenticated;
grant execute on function public.guard_cash_table_removal() to service_role;
create trigger guard_cash_table_delete before delete on public.tables
for each row execute function public.guard_cash_table_removal();
create trigger guard_cash_table_disable before update of cash_limit on public.tables
for each row when (old.cash_limit is not null and new.cash_limit is null)
execute function public.guard_cash_table_removal();

create or replace function public.finalize_balanced_round(p_shop text, p_round text, p_weight numeric)
returns text language plpgsql security invoker set search_path = '' as $finalize$
declare
  item public.rounds%rowtype;
  bill public.bets%rowtype;
  result_side text;
  total_even numeric;
  total_odd numeric;
  settled_count bigint;
  active_count bigint;
  bill_count bigint;
  margin numeric;
  commission numeric;
  payout_amount numeric;
  referral text;
begin
  if p_weight is null or p_weight <= 0 or p_weight > 1000000 then
    return 'ROUND_WEIGHT_INVALID';
  end if;
  result_side := case when mod(p_weight, 2) = 0 then 'คู่' else 'คี่' end;

  select * into item from public.rounds
  where shop_id = p_shop and round_id = p_round for update;
  if not found then return 'ROUND_NOT_FOUND'; end if;
  if item.status = 'Ended' and item.weight = p_weight and item.result = result_side then return 'ENDED'; end if;
  if item.status is distinct from 'Closed' then return 'ROUND_NOT_CLOSED'; end if;
  if item.resolver_type is distinct from 'none' then return 'ROUND_REVIEW_REQUIRED'; end if;

  select coalesce(sum(amount) filter (where bet_type = 'คู่'), 0),
    coalesce(sum(amount) filter (where bet_type = 'คี่'), 0),
    count(*) filter (where status in ('Win', 'Lose')),
    count(*) filter (where status = 'Active'), count(*)
  into total_even, total_odd, settled_count, active_count, bill_count
  from public.bets where shop_id = p_shop and round_id = p_round and status is distinct from 'Cancelled';
  if total_even <> total_odd or settled_count + active_count <> bill_count then return 'ROUND_REVIEW_REQUIRED'; end if;

  if settled_count > 0 then
    if active_count <> 0 then return 'ROUND_REVIEW_REQUIRED'; end if;
    if exists (select 1 from public.bets where shop_id = p_shop and round_id = p_round and status in ('Win','Lose')
      and status is distinct from case when bet_type = result_side then 'Win' else 'Lose' end) then
      return 'ROUND_RESULT_MISMATCH';
    end if;
    update public.rounds set status = 'Ended', weight = p_weight, result = result_side
      where shop_id = p_shop and round_id = p_round;
    return 'RECOVERED';
  end if;

  select water_margin, comm_rate into margin, commission from public.system_settings where shop_id = p_shop;
  for bill in select * from public.bets
    where shop_id = p_shop and round_id = p_round and status = 'Active'
    order by bet_id for update
  loop
    payout_amount := case when bill.bet_type = result_side
      then bill.amount + bill.amount * (1 - coalesce(margin, 0.05)) else 0 end;
    if bill.cash_table then payout_amount := round(payout_amount, 2); end if;
    if payout_amount > 0 and not bill.cash_table then
      if bill.play_mode = 'table' then
        update public.tables set credit = coalesce(credit, 0) + payout_amount
          where shop_id = p_shop and table_no = bill.table_no;
        if not found then raise exception 'ROUND_PAYOUT_TARGET_MISSING'; end if;
      else
        update public.users set credit_balance = coalesce(credit_balance, 0) + payout_amount
          where shop_id = p_shop and uid = bill.uid returning referrer_uid into referral;
        if not found then raise exception 'ROUND_PAYOUT_TARGET_MISSING'; end if;
        if referral is not null and referral <> '-' then
          update public.users set commission_balance = coalesce(commission_balance, 0) + bill.amount * coalesce(commission, 0.01)
            where shop_id = p_shop and member_id = referral;
        end if;
      end if;
    end if;
    update public.bets set status = case when bill.bet_type = result_side then 'Win' else 'Lose' end, payout = payout_amount
      where shop_id = p_shop and round_id = p_round and bet_id = bill.bet_id;
  end loop;
  update public.rounds set status = 'Ended', weight = p_weight, result = result_side
    where shop_id = p_shop and round_id = p_round;
  return 'ENDED';
end;
$finalize$;

create index cash_table_open_bets_idx on public.bets(shop_id,table_no) where cash_table and status = 'Active';
create index cash_table_bets_report_idx on public.bets(shop_id,created_at) where cash_table;
create index cash_table_transactions_report_idx on public.transactions(shop_id,created_at) where cash_table_no is not null;
revoke all on function public.place_player_cash_table_bet(text,text,text,uuid,text,numeric,text,date,boolean),
  public.record_cash_table_payment(text,text,uuid,text,numeric,text),
  public.cash_table_daily_report(text,date) from public, anon, authenticated;
grant execute on function public.place_player_cash_table_bet(text,text,text,uuid,text,numeric,text,date,boolean),
  public.record_cash_table_payment(text,text,uuid,text,numeric,text),
  public.cash_table_daily_report(text,date) to service_role;
commit;
