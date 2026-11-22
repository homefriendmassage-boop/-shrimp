alter table public.cash_table_bet_corrections
  drop constraint cash_table_bet_corrections_operation_check,
  add constraint cash_table_bet_corrections_operation_check check (operation in ('add','edit','move','remove'));

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
  if p_request is null or p_bet is null or p_operation is null or p_operation not in ('add','edit','move','remove')
    or p_reason is null or char_length(btrim(p_reason)) not between 1 and 300 then return 'BET_INVALID'; end if;
  if p_operation <> 'remove' and (
    p_side is null or p_side not in ('คู่','คี่') or p_amount is null or p_amount not between 0.01 and 999999999
    or p_amount <> round(p_amount,2)
  ) then return 'BET_INVALID'; end if;
  if p_operation = 'move' and (p_expected_side is null or p_expected_side not in ('คู่','คี่')
    or p_side = p_expected_side or p_amount is distinct from p_expected_amount) then return 'BET_INVALID'; end if;
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
  if item.status = 'Open' and item.end_time_ms > extract(epoch from clock_timestamp()) * 1000
    and p_operation not in ('move','remove')
  then return 'ROUND_STILL_OPEN'; end if;

  if p_operation <> 'add' then
    select * into bill from public.bets where shop_id = p_shop and round_id = p_round
      and table_no = p_table and bet_id = p_bet and cash_table and status = 'Active' for update;
    if not found or bill.amount is distinct from p_expected_amount or bill.bet_type is distinct from p_expected_side
    then return 'BET_CHANGED'; end if;
    before_bill := jsonb_build_object('side',bill.bet_type,'amount',bill.amount,'status',bill.status);
  end if;
  select * into desk from public.tables where shop_id = p_shop and table_no = p_table for update;
  if not found or desk.cash_limit is null then return 'CASH_TABLE_REQUIRED'; end if;
  if p_operation = 'add' and desk.is_hidden then return 'TABLE_CLOSED'; end if;
  if p_operation = 'add' and shop_finance_private.cash_table_prior_balance(p_shop,p_table,p_round,desk.credit)<0 then
    return 'CASH_TABLE_PRIOR_DEBT';
  end if;
  balance := coalesce(desk.credit,0) + coalesce(bill.amount,0)
    - case when p_operation = 'remove' then 0 else p_amount end;
  if p_operation in ('add','edit') then
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
  elsif p_operation in ('edit','move') then
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

create or replace function public.manage_cash_table_guests(
  p_shop text, p_actor text, p_table text, p_action text, p_bill text, p_name text, p_guest text, p_expected uuid
) returns jsonb language plpgsql set search_path = '' as $$
declare
  desk public.tables%rowtype;
  bill public.tables%rowtype;
  incoming shop_finance_private.table_guest_scans%rowtype;
  next_no text;
  day_now date := public.shop_accounting_day(clock_timestamp());
begin
  if not exists (select from public.users u join public.shops s using(shop_id)
    where u.shop_id=p_shop and u.uid=p_actor and u.status='Active'
    and (u.role in ('Admin','Superadmin','Cashier') or (u.role='Operator' and p_action='list')) and lower(s.status)='active')
  then return jsonb_build_object('code','ADMIN_REQUIRED'); end if;
  select * into desk from public.tables where shop_id=p_shop and table_no=p_table
    and parent_table_no is null for update;
  if not found or desk.cash_limit is null or desk.is_hidden then return jsonb_build_object('code','CASH_TABLE_REQUIRED'); end if;

  if p_action='list' then
    return jsonb_build_object('code','OK','generation',desk.qr_generation,'scans',coalesce((
      select jsonb_agg(jsonb_build_object('uid',s.uid,'name',s.display_name,'picture',s.picture) order by s.display_name,s.uid)
      from shop_finance_private.table_guest_scans s
      where s.shop_id=p_shop and s.table_no=p_table and s.day=day_now and s.generation is not distinct from desk.qr_generation
      and not exists (select from public.tables b where b.shop_id=p_shop and b.parent_table_no=p_table
        and not b.guest_bill_closed and b.guest_uid=s.uid)
    ),'[]'::jsonb));
  end if;
  if desk.qr_generation is distinct from p_expected then return jsonb_build_object('code','TABLE_QR_INVALID'); end if;
  if p_action='rotate' then
    if coalesce(desk.credit,0)<>0 or exists (select from public.tables
      where shop_id=p_shop and parent_table_no=p_table and not guest_bill_closed)
      or exists (select from public.bets where shop_id=p_shop and table_no=p_table and cash_table and status='Active')
    then return jsonb_build_object('code','GUEST_BILLS_UNSETTLED'); end if;
    delete from shop_finance_private.table_guest_scans where shop_id=p_shop and table_no=p_table;
    update public.tables set qr_generation=gen_random_uuid() where id=desk.id;
    return jsonb_build_object('code','OK');
  end if;

  if p_action in ('edit','close') then
    select * into bill from public.tables where shop_id=p_shop and parent_table_no=p_table
      and table_no=p_bill and not guest_bill_closed for update;
    if not found then return jsonb_build_object('code','GUEST_BILL_NOT_FOUND'); end if;
  end if;
  if p_action='close' then
    if coalesce(bill.credit,0)<>0 or exists (select from public.bets where shop_id=p_shop
      and table_no=p_bill and cash_table and status='Active')
    then return jsonb_build_object('code','GUEST_BILLS_UNSETTLED'); end if;
    update public.tables set guest_bill_closed=true,is_open=false,is_hidden=true,
      guest_scan_day=day_now,qr_generation=desk.qr_generation where id=bill.id;
    delete from shop_finance_private.table_guest_scans where shop_id=p_shop and table_no=p_table and uid=bill.guest_uid;
    return jsonb_build_object('code','OK');
  end if;
  if p_action not in ('add','edit') or p_name is null or char_length(btrim(p_name)) not between 1 and 40
    then return jsonb_build_object('code','GUEST_NAME_INVALID'); end if;
  if exists (select from public.tables where shop_id=p_shop and parent_table_no=p_table
    and not guest_bill_closed and id is distinct from bill.id
    and lower(table_name)=lower(btrim(p_name))) then return jsonb_build_object('code','GUEST_NAME_DUPLICATE'); end if;
  if p_action='add' and (coalesce(desk.credit,0)<>0 or exists (
    select from public.bets where shop_id=p_shop and table_no=p_table and cash_table and status='Active'))
  then return jsonb_build_object('code','GUEST_BILLS_UNSETTLED'); end if;
  if p_guest is not null and p_guest is distinct from bill.guest_uid then
    select * into incoming from shop_finance_private.table_guest_scans
      where shop_id=p_shop and table_no=p_table and day=day_now and uid=p_guest
      and generation is not distinct from desk.qr_generation;
    if not found or exists (select from public.tables where shop_id=p_shop and parent_table_no=p_table
      and not guest_bill_closed and guest_uid=p_guest) then return jsonb_build_object('code','GUEST_SCAN_NOT_FOUND'); end if;
    if bill.guest_uid is not null then return jsonb_build_object('code','GUEST_ALREADY_LINKED'); end if;
  end if;
  if p_action='edit' then
    update public.tables set table_name=btrim(p_name), guest_uid=coalesce(p_guest,guest_uid) where id=bill.id;
    return jsonb_build_object('code','OK','bill',p_bill);
  end if;
  loop
    next_no := nextval('shop_finance_private.guest_bill_number')::text;
    exit when not exists (select from public.tables where shop_id=p_shop and table_no=next_no);
  end loop;
  insert into public.tables(shop_id,table_no,table_name,parent_table_no,guest_uid,credit,cash_limit,is_open,is_hidden)
  values(p_shop,next_no,btrim(p_name),p_table,p_guest,0,desk.cash_limit,true,false);
  return jsonb_build_object('code','OK','bill',next_no);
end;
$$;
