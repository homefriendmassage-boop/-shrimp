begin;

alter table public.rounds add column settlement_weight numeric;

create table public.cash_table_bet_corrections (
  shop_id text not null,
  request_id uuid not null,
  round_id text not null,
  table_no text not null,
  bet_id uuid not null,
  actor_uid text not null,
  operation text not null check (operation in ('add','edit','remove')),
  reason text not null check (char_length(reason) between 1 and 300),
  before_bill jsonb,
  after_bill jsonb not null,
  before_credit numeric not null,
  after_credit numeric not null,
  created_at timestamptz not null default now(),
  primary key (shop_id,request_id),
  foreign key (shop_id,round_id) references public.rounds(shop_id,round_id)
);
alter table public.cash_table_bet_corrections enable row level security;
revoke all on public.cash_table_bet_corrections from public, anon, authenticated;
grant select, insert on public.cash_table_bet_corrections to service_role;

create function public.guard_round_acceptance()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'Open' and (
    old.status is distinct from 'Open' or old.settlement_weight is not null
    or old.end_time_ms is null or old.end_time_ms <= extract(epoch from clock_timestamp()) * 1000
  ) then raise exception 'ROUND_CANNOT_REOPEN'; end if;
  return new;
end;
$$;
create trigger guard_round_acceptance before update of status, end_time_ms on public.rounds
for each row execute function public.guard_round_acceptance();

-- Lock corrections before the existing multi-request settlement workflow reads or pays bills.
create function public.begin_round_settlement(p_shop text,p_round text,p_weight numeric,p_resolver text)
returns text language plpgsql set search_path = '' as $$
declare
  item public.rounds%rowtype;
  gap numeric;
begin
  if p_weight is null or p_weight <= 0 or p_weight > 1000000 then return 'ROUND_WEIGHT_INVALID'; end if;
  select * into item from public.rounds where shop_id = p_shop and round_id = p_round for update;
  if not found or item.status <> 'Closed' then return 'ROUND_NOT_CLOSED'; end if;
  if item.resolver_type is distinct from p_resolver or p_resolver is null then return 'ROUND_REVIEW_REQUIRED'; end if;
  if item.settlement_weight is not null then
    if item.settlement_weight <> p_weight then return 'ROUND_RESULT_MISMATCH'; end if;
    if p_resolver <> 'none' then return 'ROUND_SETTLEMENT_STARTED'; end if;
  end if;
  if p_resolver = 'none' then
    select coalesce(sum(case when bet_type = 'คู่' then amount else -amount end),0) into gap
      from public.bets where shop_id = p_shop and round_id = p_round and status <> 'Cancelled';
    if gap <> 0 then return 'ROUND_REVIEW_REQUIRED'; end if;
  end if;
  update public.rounds set settlement_weight = p_weight where shop_id = p_shop and round_id = p_round;
  return 'READY';
end;
$$;

create or replace function public.place_player_cash_table_bet(
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
      and (case when p_staff then u.role in ('Admin','Superadmin','Operator','Cashier') else
        coalesce(u.role,'Customer') not in ('Promoter','Cashier') and exists (
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
  if not desk.is_open or desk.is_hidden then return jsonb_build_object('code','TABLE_CLOSED'); end if;
  if coalesce(desk.credit,0) - p_amount < -desk.cash_limit then
    return jsonb_build_object('code','TABLE_CREDIT_LIMIT');
  end if;
  if current_round.end_time_ms <= extract(epoch from clock_timestamp()) * 1000 then
    return jsonb_build_object('code','ROUND_CLOSED');
  end if;
  insert into public.bets (bet_id,shop_id,round_id,uid,table_no,bet_type,amount,status,play_mode,payout,cash_table,player_scanned_table)
    values (p_id,p_shop,p_round,p_uid,p_table,p_type,p_amount,'Active','table',0,true,not p_staff);
  update public.tables set credit = coalesce(credit,0) - p_amount where id = desk.id;
  return jsonb_build_object('code','PLACED','bet_id',p_id);
end;
$$;

create function public.correct_cash_table_bet(
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
  if item.status = 'Open' and item.end_time_ms > extract(epoch from clock_timestamp()) * 1000
    and not (actor_role in ('Admin','Superadmin') and p_operation = 'remove')
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

revoke all on function public.guard_round_acceptance(), public.begin_round_settlement(text,text,numeric,text),
  public.correct_cash_table_bet(text,text,text,text,uuid,uuid,text,text,text,numeric,text,numeric)
  from public, anon, authenticated;
grant execute on function public.guard_round_acceptance(), public.begin_round_settlement(text,text,numeric,text),
  public.correct_cash_table_bet(text,text,text,text,uuid,uuid,text,text,text,numeric,text,numeric) to service_role;

create or replace function public.read_mc_board(p_shop text, p_revision uuid)
returns jsonb language sql stable set search_path = '' as $$
  with board as (
    select public.build_mc_board(p_shop) as data
    from public.mc_board_access where shop_id = p_shop and revision = p_revision
  ), totals as (
    select case when b.play_mode = 'table' then nullif(b.table_no,'-') end as table_no,
      coalesce(sum(b.amount) filter (where b.bet_type = 'คู่'),0) as even,
      coalesce(sum(b.amount) filter (where b.bet_type = 'คี่'),0) as odd
    from board join public.bets b on b.shop_id = p_shop and b.round_id = board.data->'round'->>'round_id'
    where b.status is distinct from 'Cancelled'
    group by 1
  )
  select data || jsonb_build_object('table_totals', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table_no',a.table_no,'name',coalesce(t.table_name,'โต๊ะ ' || a.table_no,'ออนไลน์'),
      'even',a.even,'odd',a.odd
    ) order by a.table_no nulls last),'[]'::jsonb)
    from totals a left join public.tables t on t.shop_id = p_shop and t.table_no = a.table_no
  ))
  from board;
$$;

commit;
