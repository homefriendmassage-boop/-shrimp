begin;

-- Remove this round's already-booked debits to recover the outstanding
-- balance carried into it. Also detect prior bills that never settled.
create function public.cash_table_requires_settlement(p_shop text,p_table text,p_round text,p_credit numeric)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(p_credit, (
      select t.credit from public.tables t where t.shop_id = p_shop and t.table_no = p_table
    ),0) + coalesce(sum(b.amount) filter (where b.round_id = p_round),0) <> 0
    or coalesce(bool_or(b.round_id is distinct from p_round),false)
  from public.bets b
  where b.shop_id = p_shop and b.table_no = p_table and b.cash_table and b.status = 'Active';
$$;

create function public.guard_unsettled_cash_table_bet()
returns trigger language plpgsql set search_path = '' as $$
declare
  desk_credit numeric;
begin
  -- Serialize the check with cash receipts, payouts, and other bets.
  select t.credit into desk_credit from public.tables t
    where t.shop_id = new.shop_id and t.table_no = new.table_no for update;
  if not found then raise exception 'CASH_TABLE_REQUIRED'; end if;
  if public.cash_table_requires_settlement(new.shop_id,new.table_no,new.round_id,desk_credit) then
    raise exception 'TABLE_SETTLEMENT_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger guard_unsettled_cash_table_bet before insert on public.bets
for each row when (new.cash_table and new.status = 'Active')
execute function public.guard_unsettled_cash_table_bet();

revoke all on function public.cash_table_requires_settlement(text,text,text,numeric),
  public.guard_unsettled_cash_table_bet() from public, anon, authenticated;
grant execute on function public.cash_table_requires_settlement(text,text,text,numeric),
  public.guard_unsettled_cash_table_bet() to service_role;

create or replace function public.correct_cash_table_bet(
  p_shop text,p_actor text,p_round text,p_table text,p_request uuid,p_bet uuid,
  p_operation text,p_reason text,p_side text,p_amount numeric,p_expected_side text,p_expected_amount numeric
) returns text language plpgsql set search_path = '' as $$
declare
  actor_role text;
  item public.rounds%rowtype;
  desk public.tables%rowtype;
  bill public.bets%rowtype;
  prior public.cash_table_bet_corrections%rowtype;
  before_bill jsonb;
  after_bill jsonb;
  balance numeric;
  limits public.system_settings%rowtype;
begin
  if p_request is null or p_bet is null or p_operation is null or p_operation not in ('add','edit','remove')
    or p_reason is null or char_length(btrim(p_reason)) not between 1 and 300 then return 'BET_INVALID'; end if;
  if p_operation <> 'remove' and (
    p_side is null or p_side not in ('คู่','คี่') or p_amount is null or p_amount not between 0.01 and 999999999
    or p_amount <> round(p_amount,2)
  ) then return 'BET_INVALID'; end if;
  select u.role into actor_role from public.users u join public.shops s using (shop_id)
    where u.shop_id = p_shop and u.uid = p_actor and u.status = 'Active' and lower(s.status) = 'active';
  if coalesce(actor_role,'') not in ('Cashier','Admin','Superadmin') then return 'ADMIN_REQUIRED'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shop || ':cash-table:' || p_request::text,0));
  select * into prior from public.cash_table_bet_corrections where shop_id = p_shop and request_id = p_request;
  if found then
    if prior.actor_uid = p_actor and prior.round_id = p_round and prior.table_no = p_table
      and prior.bet_id = p_bet and prior.operation = p_operation and prior.reason = btrim(p_reason)
      and (p_operation = 'remove' or
        (prior.after_bill->>'side' = p_side and (prior.after_bill->>'amount')::numeric = p_amount))
      and (p_operation = 'add' or
        (prior.before_bill->>'side' = p_expected_side and (prior.before_bill->>'amount')::numeric = p_expected_amount))
    then return 'RECORDED'; end if;
    return 'BET_INVALID';
  end if;

  select * into item from public.rounds where shop_id = p_shop
    order by created_at desc nulls last, round_id desc limit 1 for update;
  if not found or item.round_id <> p_round or item.status not in ('Open','Closed')
    or item.settlement_weight is not null
    or exists (select 1 from public.bets where shop_id = p_shop and round_id = p_round and status in ('Win','Lose'))
    or exists (select 1 from public.backer_logs where shop_id = p_shop and round_id = p_round)
  then return 'ROUND_LOCKED'; end if;
  if p_operation <> 'add' then
    select * into bill from public.bets where shop_id = p_shop and round_id = p_round
      and table_no = p_table and bet_id = p_bet and cash_table and status = 'Active' for update;
    if not found or bill.amount is distinct from p_expected_amount or bill.bet_type is distinct from p_expected_side
    then return 'BET_CHANGED'; end if;
    before_bill := jsonb_build_object('side',bill.bet_type,'amount',bill.amount,'status',bill.status);
  end if;
  if item.status = 'Open' and item.end_time_ms > extract(epoch from clock_timestamp()) * 1000
    and not (
      p_operation = 'remove' and (
        actor_role in ('Admin','Superadmin')
        or (actor_role = 'Cashier' and bill.uid = p_actor and not bill.player_scanned_table)
      )
    )
  then return 'ROUND_STILL_OPEN'; end if;

  select * into desk from public.tables where shop_id = p_shop and table_no = p_table for update;
  if not found or desk.cash_limit is null then return 'CASH_TABLE_REQUIRED'; end if;
  if p_operation = 'add' and desk.is_hidden then return 'TABLE_CLOSED'; end if;
  balance := coalesce(desk.credit,0) + coalesce(bill.amount,0)
    - case when p_operation = 'remove' then 0 else p_amount end;
  if p_operation <> 'remove' then
    select * into limits from public.system_settings where shop_id = p_shop;
    if p_amount not between greatest(coalesce(limits.min_bet,100),100) and coalesce(limits.max_bet,5000)
    then return 'BET_LIMIT'; end if;
    if balance < -desk.cash_limit and balance < coalesce(desk.credit,0) then return 'TABLE_CREDIT_LIMIT'; end if;
  end if;

  if p_operation = 'add' then
    insert into public.bets (bet_id,shop_id,round_id,uid,table_no,bet_type,amount,status,play_mode,payout,cash_table)
      values (p_bet,p_shop,p_round,p_actor,p_table,p_side,p_amount,'Active','table',0,true)
      on conflict (bet_id) do nothing;
    if not found then return 'BET_INVALID'; end if;
  elsif p_operation = 'edit' then
    update public.bets set amount = p_amount, bet_type = p_side where shop_id = p_shop and bet_id = p_bet;
  else
    -- The existing cancellation trigger restores the original cash-table credit.
    update public.bets set status = 'Cancelled' where shop_id = p_shop and bet_id = p_bet;
  end if;
  if p_operation <> 'remove' then
    update public.tables set credit = balance where id = desk.id and shop_id = p_shop;
  end if;

  after_bill := case when p_operation = 'remove' then before_bill || '{"status":"Cancelled"}'::jsonb
    else jsonb_build_object('side',p_side,'amount',p_amount,'status','Active') end;
  insert into public.cash_table_bet_corrections(
    shop_id,request_id,round_id,table_no,bet_id,actor_uid,operation,reason,before_bill,after_bill,before_credit,after_credit
  ) values (
    p_shop,p_request,p_round,p_table,p_bet,p_actor,p_operation,btrim(p_reason),before_bill,after_bill,coalesce(desk.credit,0),balance
  );
  return 'RECORDED';
end;
$$;

commit;
