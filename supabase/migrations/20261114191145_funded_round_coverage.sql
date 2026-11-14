begin;

create table shop_finance_private.coverage_funds (
  shop_id text not null references public.shops(shop_id),
  day date not null,
  recipient text not null,
  funded numeric(14,2) not null check (funded >= 0),
  rate numeric(5,2) not null check (rate between 0 and 100),
  actor_uid text not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (shop_id,day,recipient)
);

create table shop_finance_private.coverage_allocations (
  shop_id text not null,
  round_id text not null,
  day date not null,
  recipient text not null,
  amount numeric(14,2) not null check (amount > 0),
  rate numeric(5,2) not null,
  covered_side text not null check (covered_side in ('คู่','คี่')),
  pnl numeric(14,2),
  fee numeric(14,2),
  settled_at timestamptz,
  primary key (shop_id,round_id,recipient),
  foreign key (shop_id,round_id) references public.rounds(shop_id,round_id),
  foreign key (shop_id,day,recipient) references shop_finance_private.coverage_funds(shop_id,day,recipient)
);
create index coverage_by_recipient on shop_finance_private.coverage_allocations(shop_id,day,recipient);

alter table shop_finance_private.coverage_funds enable row level security;
alter table shop_finance_private.coverage_allocations enable row level security;
grant select,insert,update on shop_finance_private.coverage_funds to service_role;
grant select,insert,update,delete on shop_finance_private.coverage_allocations to service_role;

-- The empty recipient identifies the shop. A backer must also have available wallet funds.
create function shop_finance_private.coverage_available(p_shop text,p_day date,p_recipient text,p_ignore_round text)
returns numeric language sql stable set search_path='' as $$
  select greatest(0, least(
    f.funded + coalesce(a.pnl,0) - coalesce(a.held,0),
    case when f.recipient='' then f.funded + coalesce(a.pnl,0) - coalesce(a.held,0)
      when u.role='Backer' and u.status='Active' then coalesce(u.backer_wallet,0) - coalesce(a.wallet_held,0)
      else 0 end
  ))
  from shop_finance_private.coverage_funds f
  left join public.users u on u.shop_id=f.shop_id and u.uid=f.recipient
  cross join lateral (
    select sum(x.pnl) filter (where x.day=f.day) as pnl,
      sum(x.amount) filter (where x.settled_at is null and x.day=f.day) as held,
      sum(x.amount) filter (where x.settled_at is null) as wallet_held
    from shop_finance_private.coverage_allocations x
    where x.shop_id=f.shop_id and x.recipient=f.recipient
      and x.round_id is distinct from p_ignore_round
  ) a
  where f.shop_id=p_shop and f.day=p_day and f.recipient=p_recipient and f.funded>0;
$$;

-- The shop row serializes reservations and fund settings. User row locks protect wallet-backed holds.
create function public.set_coverage_fund(p_shop text,p_actor text,p_recipient text,p_funded numeric,p_rate numeric)
returns text language plpgsql set search_path='' as $$
declare
  d date := public.shop_accounting_day(clock_timestamp());
  wallet numeric;
  reserved numeric;
  settled_pnl numeric;
begin
  if p_recipient is null or p_funded is null or p_funded not between 0 and 999999999
    or p_funded <> round(p_funded,2) or p_rate is null or p_rate not between 0 and 100
    or p_rate <> round(p_rate,2) then return 'COVERAGE_INVALID'; end if;
  perform 1 from public.shops where shop_id=p_shop for update;
  if not found then return 'SHOP_INVALID'; end if;
  if p_recipient<>'' then
    select coalesce(backer_wallet,0) into wallet from public.users
      where shop_id=p_shop and uid=p_recipient and role='Backer' and status='Active' for update;
    if not found then return 'COVERAGE_INVALID'; end if;
  end if;
  select coalesce(sum(amount) filter (where settled_at is null),0),coalesce(sum(pnl),0)
    into reserved,settled_pnl from shop_finance_private.coverage_allocations
    where shop_id=p_shop and day=d and recipient=p_recipient;
  if reserved>0 and (p_funded=0 or p_funded+settled_pnl<reserved) then return 'COVERAGE_FUNDS_RESERVED'; end if;
  if p_recipient<>'' and p_funded>0 and p_funded+settled_pnl>wallet then return 'COVERAGE_WALLET_TOO_LOW'; end if;
  insert into shop_finance_private.coverage_funds(shop_id,day,recipient,funded,rate,actor_uid)
    values (p_shop,d,p_recipient,p_funded,p_rate,p_actor)
  on conflict (shop_id,day,recipient) do update set funded=excluded.funded,rate=excluded.rate,
    actor_uid=excluded.actor_uid,updated_at=clock_timestamp();
  return 'SAVED';
end;
$$;

create function public.read_round_coverage(p_shop text,p_round text)
returns jsonb language sql stable set search_path='' as $$
  with round_day as (select public.shop_accounting_day(statement_timestamp()) as day), totals as (
    select coalesce(sum(amount) filter (where bet_type='คู่'),0) as even_total,
      coalesce(sum(amount) filter (where bet_type='คี่'),0) as odd_total
    from public.bets where shop_id=p_shop and round_id=p_round and status='Active'
  ), recipients as (
    select u.uid as recipient,coalesce(u.display_name,u.member_id,u.uid) as name,
      coalesce(u.backer_wallet,0) as wallet
    from public.users u where u.shop_id=p_shop and u.role='Backer' and u.status='Active'
    union all select '', 'ร้าน', null
  )
  select jsonb_build_object('day',d.day,'even',t.even_total,'odd',t.odd_total,
    'recipients',(select jsonb_agg(jsonb_build_object('recipient',r.recipient,'name',r.name,
      'wallet',r.wallet,'funded',coalesce(f.funded,0),'rate',coalesce(f.rate,0),'pnl',coalesce(p.pnl,0),
      'available',coalesce(shop_finance_private.coverage_available(p_shop,d.day,r.recipient,p_round),0),
      'assigned',coalesce(a.amount,0)) order by r.recipient)
      from recipients r left join shop_finance_private.coverage_funds f on f.shop_id=p_shop and f.day=d.day and f.recipient=r.recipient
      left join shop_finance_private.coverage_allocations a on a.shop_id=p_shop and a.round_id=p_round and a.recipient=r.recipient and a.settled_at is null
      left join lateral (select sum(x.pnl) as pnl from shop_finance_private.coverage_allocations x
        where x.shop_id=p_shop and x.day=d.day and x.recipient=r.recipient) p on true))
  from round_day d cross join totals t;
$$;

create function public.reserve_round_coverage(p_shop text,p_round text,p_allocations jsonb)
returns text language plpgsql set search_path='' as $$
declare
  item public.rounds%rowtype;
  d date;
  signed_gap numeric;
  gap numeric;
  allocation record;
begin
  perform 1 from public.shops where shop_id=p_shop for update;
  select * into item from public.rounds where shop_id=p_shop and round_id=p_round for update;
  if not found or item.status<>'Closed' or item.settlement_weight is not null
    or exists (select 1 from public.bets where shop_id=p_shop and round_id=p_round and status in ('Win','Lose'))
    then return 'ROUND_NOT_CLOSED'; end if;
  if jsonb_typeof(p_allocations) is distinct from 'object' then return 'COVERAGE_INVALID'; end if;
  d := public.shop_accounting_day(clock_timestamp());
  perform 1 from public.bets where shop_id=p_shop and round_id=p_round and status='Active' order by bet_id for update;
  select coalesce(sum(case when bet_type='คู่' then amount else -amount end),0) into signed_gap
    from public.bets where shop_id=p_shop and round_id=p_round and status='Active';
  gap := abs(signed_gap);
  if exists (select 1 from jsonb_each_text(p_allocations) e
      where e.value is null or e.value !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$')
    then return 'COVERAGE_INVALID'; end if;
  if (select coalesce(sum(value::numeric),0) from jsonb_each_text(p_allocations))<>gap
    then return 'COVERAGE_GAP_MISMATCH'; end if;

  perform 1 from public.users where shop_id=p_shop and uid in (select jsonb_object_keys(p_allocations))
    order by uid for update;
  for allocation in select key,value::numeric as amount from jsonb_each_text(p_allocations) where value::numeric>0 loop
    if allocation.amount>coalesce(shop_finance_private.coverage_available(p_shop,d,allocation.key,p_round),0)
      then return 'BACKER_BALANCE_INSUFFICIENT'; end if;
  end loop;
  delete from shop_finance_private.coverage_allocations where shop_id=p_shop and round_id=p_round;
  insert into shop_finance_private.coverage_allocations(shop_id,round_id,day,recipient,amount,rate,covered_side)
    select p_shop,p_round,d,f.recipient,e.value::numeric,f.rate,case when signed_gap>0 then 'คี่' else 'คู่' end
    from jsonb_each_text(p_allocations) e join shop_finance_private.coverage_funds f
      on f.shop_id=p_shop and f.day=d and f.recipient=e.key where e.value::numeric>0;
  update public.rounds set resolver_type=case when gap=0 then 'none'
    when exists (select 1 from jsonb_each_text(p_allocations) where key<>'' and value::numeric>0) then 'backer'
    else 'shop' end where shop_id=p_shop and round_id=p_round;
  return 'RESERVED';
end;
$$;

-- Existing wallet debits must leave sufficient funds for outstanding reservations.
create function shop_finance_private.guard_coverage_wallet()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  held numeric;
begin
  select coalesce(sum(amount),0) into held from shop_finance_private.coverage_allocations
    where shop_id=old.shop_id and recipient=old.uid and settled_at is null;
  if tg_op='DELETE' then
    if held>0 then raise exception 'COVERAGE_FUNDS_RESERVED'; end if;
    return old;
  end if;
  if held>0 and (new.role is distinct from 'Backer' or new.status is distinct from 'Active'
     or coalesce(new.backer_wallet,0)<held) then raise exception 'COVERAGE_FUNDS_RESERVED'; end if;
  return new;
end;
$$;
create trigger guard_coverage_wallet before update of backer_wallet,role,status or delete on public.users
  for each row execute function shop_finance_private.guard_coverage_wallet();

revoke all on function shop_finance_private.coverage_available(text,date,text,text),
  shop_finance_private.guard_coverage_wallet(), public.set_coverage_fund(text,text,text,numeric,numeric),
  public.read_round_coverage(text,text), public.reserve_round_coverage(text,text,jsonb) from public,anon,authenticated;
grant execute on function shop_finance_private.coverage_available(text,date,text,text),
  public.set_coverage_fund(text,text,text,numeric,numeric),
  public.read_round_coverage(text,text), public.reserve_round_coverage(text,text,jsonb) to service_role;


create function shop_finance_private.guard_staff_bet_cancellation()
returns trigger language plpgsql set search_path='' as $$
begin
  if exists (select 1 from public.rounds where shop_id=old.shop_id and round_id=old.round_id
      and (status not in ('Open','Closed') or settlement_weight is not null)) then
    raise exception 'ROUND_LOCKED';
  end if;
  return new;
end;
$$;
create trigger guard_staff_bet_cancellation before update of status on public.bets
for each row when (old.status='Active' and new.status='Cancelled')
execute function shop_finance_private.guard_staff_bet_cancellation();

create table shop_finance_private.coverage_wallet_movements (
  shop_id text not null references public.shops(shop_id),
  request_id uuid not null,
  recipient text not null,
  actor_uid text not null,
  amount numeric(14,2) not null,
  kind text not null check (kind in ('deposit','withdraw')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (shop_id,request_id)
);
alter table shop_finance_private.coverage_wallet_movements enable row level security;
grant select,insert on shop_finance_private.coverage_wallet_movements to service_role;

-- Serialize manual funding with settlement and record the money movement in the same transaction.
create function public.move_backer_funds(p_shop text,p_actor text,p_recipient text,p_amount numeric,p_kind text,p_request uuid)
returns text language plpgsql set search_path='' as $$
declare
  account public.users%rowtype;
  previous shop_finance_private.coverage_wallet_movements%rowtype;
  staff_name text;
  next_balance numeric;
begin
  if p_request is null or p_kind is null or p_kind not in ('deposit','withdraw') or p_amount is null
    or p_amount not between 100 and 999999999 or p_amount<>round(p_amount,2) then return 'COVERAGE_INVALID'; end if;
  select coalesce(display_name,member_id,'Admin') into staff_name from public.users
    where shop_id=p_shop and uid=p_actor and status='Active' and role in ('Admin','Superadmin');
  if not found then return 'ADMIN_REQUIRED'; end if;
  perform 1 from public.shops where shop_id=p_shop for update;
  select * into previous from shop_finance_private.coverage_wallet_movements
    where shop_id=p_shop and request_id=p_request;
  if found then
    return case when previous.recipient=p_recipient and previous.actor_uid=p_actor
      and previous.amount=p_amount and previous.kind=p_kind then 'RECORDED' else 'COVERAGE_INVALID' end;
  end if;
  select * into account from public.users
    where shop_id=p_shop and uid=p_recipient and status='Active' and role='Backer' for update;
  if not found then return 'COVERAGE_INVALID'; end if;
  next_balance := coalesce(account.backer_wallet,0) + case when p_kind='deposit' then p_amount else -p_amount end;
  if next_balance<0 then return 'COVERAGE_WALLET_TOO_LOW'; end if;
  update public.users set backer_wallet=next_balance where shop_id=p_shop and uid=p_recipient;
  insert into shop_finance_private.coverage_wallet_movements(shop_id,request_id,recipient,actor_uid,amount,kind)
    values (p_shop,p_request,p_recipient,p_actor,p_amount,p_kind);
  insert into public.transactions(shop_id,target_id,type,amount,admin_name,target_type)
    values (p_shop,account.member_id,p_kind,p_amount,staff_name,'user');
  return 'RECORDED';
end;
$$;
revoke all on function public.move_backer_funds(text,text,text,numeric,text,uuid) from public,anon,authenticated;
grant execute on function public.move_backer_funds(text,text,text,numeric,text,uuid) to service_role;

alter table public.bets add column matched_water_fee numeric, add column coverage_water_fee numeric;
alter table public.rounds add column settled_at timestamptz;

create or replace function public.finalize_staff_round(p_shop text, p_round text, p_weight numeric)
returns text language plpgsql security invoker set search_path = '' as $finalize$
<<settlement>>
declare
  item public.rounds%rowtype;
  bill public.bets%rowtype;
  backer public.users%rowtype;
  gap numeric;
  allocation shop_finance_private.coverage_allocations%rowtype;
  gross_coverage_fee numeric := 0;
  cumulative numeric := 0;
  matched_fee numeric;
  player_coverage_fee numeric;
  winning_total numeric;
  matched_total numeric;
  calculated_at timestamptz;
  gap_side text;
  coverage_charge numeric;
  net_result numeric;
  balance numeric;
  result_side text;
  total_even numeric;
  total_odd numeric;
  settled_count bigint;
  active_count bigint;
  bill_count bigint;
  margin numeric;
  payout_amount numeric;
begin
  if p_weight is null or p_weight <= 0 or p_weight > 1000000 then
    return 'ROUND_WEIGHT_INVALID';
  end if;
  result_side := case when mod(p_weight, 2) = 0 then 'คู่' else 'คี่' end;

  perform 1 from public.shops where shop_id=p_shop for update;
  select * into item from public.rounds
  where shop_id = p_shop and round_id = p_round for update;
  if not found then return 'ROUND_NOT_FOUND'; end if;
  if item.status = 'Ended' and item.weight = p_weight and item.result = result_side then return 'ENDED'; end if;
  if item.status is distinct from 'Closed' then return 'ROUND_NOT_CLOSED'; end if;
  if item.settlement_weight is not null and item.settlement_weight <> p_weight then return 'ROUND_RESULT_MISMATCH'; end if;
  if coalesce(item.resolver_type,'') not in ('none','shop','backer') then return 'ROUND_REVIEW_REQUIRED'; end if;

  perform 1 from public.bets where shop_id=p_shop and round_id=p_round and status='Active'
    order by bet_id for update;
  select coalesce(sum(amount) filter (where bet_type = 'คู่'), 0),
    coalesce(sum(amount) filter (where bet_type = 'คี่'), 0),
    count(*) filter (where status in ('Win', 'Lose')),
    count(*) filter (where status = 'Active'), count(*)
  into total_even, total_odd, settled_count, active_count, bill_count
  from public.bets where shop_id = p_shop and round_id = p_round and status is distinct from 'Cancelled';
  gap := abs(total_even - total_odd);
  if settled_count + active_count <> bill_count then
    return 'ROUND_REVIEW_REQUIRED';
  end if;

  if settled_count > 0 then
    if active_count <> 0 or item.resolver_type <> 'none' then return 'ROUND_REVIEW_REQUIRED'; end if;
    if exists (select 1 from public.bets where shop_id = p_shop and round_id = p_round and status in ('Win','Lose')
      and status is distinct from case when bet_type = result_side then 'Win' else 'Lose' end) then
      return 'ROUND_RESULT_MISMATCH';
    end if;
    perform set_config('shop_finance.skip_referral_recovery','on',true);
    update public.rounds set status = 'Ended', weight = p_weight, result = result_side
      where shop_id = p_shop and round_id = p_round;
    perform set_config('shop_finance.skip_referral_recovery','off',true);
    return 'RECOVERED';
  end if;

  -- Existing partial backer processing requires reconciliation before retry.
  if exists (select 1 from public.backer_logs where shop_id = p_shop and round_id = p_round) then
    return 'ROUND_REVIEW_REQUIRED';
  end if;

  gap_side := case when total_even > total_odd then 'คี่' else 'คู่' end;
  if exists (select 1 from shop_finance_private.coverage_allocations where shop_id=p_shop and round_id=p_round
      and settled_at is null and (covered_side<>gap_side or day<>public.shop_accounting_day(clock_timestamp())))
    or gap <> (select coalesce(sum(amount),0) from shop_finance_private.coverage_allocations
      where shop_id=p_shop and round_id=p_round and settled_at is null) then
    return 'COVERAGE_GAP_MISMATCH';
  end if;
  calculated_at := clock_timestamp();
  matched_total := least(total_even,total_odd);
  winning_total := case when result_side='คู่' then total_even else total_odd end;

  perform 1 from public.users u join shop_finance_private.coverage_allocations a
    on a.shop_id=u.shop_id and a.recipient=u.uid
    where a.shop_id=p_shop and a.round_id=p_round order by u.uid for update of u;
  for allocation in select * from shop_finance_private.coverage_allocations
    where shop_id=p_shop and round_id=p_round and settled_at is null order by recipient
  loop
    if allocation.amount>coalesce(shop_finance_private.coverage_available(p_shop,allocation.day,allocation.recipient,p_round),0)
      then return 'BACKER_BALANCE_INSUFFICIENT'; end if;
  end loop;

  for allocation in select * from shop_finance_private.coverage_allocations
    where shop_id=p_shop and round_id=p_round and settled_at is null order by recipient
  loop
    coverage_charge := round(allocation.amount * allocation.rate / 100, 2);
    gross_coverage_fee := gross_coverage_fee + coverage_charge;
    net_result := case when result_side=gap_side then allocation.amount-coverage_charge else -allocation.amount end;
    update shop_finance_private.coverage_allocations
      set pnl=settlement.net_result,fee=case when result_side=gap_side then coverage_charge else 0 end,settled_at=calculated_at
      where shop_id=p_shop and round_id=p_round and recipient=allocation.recipient;
    if allocation.recipient<>'' then
      update public.users set backer_wallet=coalesce(backer_wallet,0)+net_result
        where shop_id=p_shop and uid=allocation.recipient returning * into backer;
      balance := backer.backer_wallet;
      insert into public.backer_logs (shop_id,round_id,uid,member_id,share_percent,gap_amount,result_status,
        pnl_amount,water_fee_deducted,wallet_balance_after)
      values (p_shop,p_round,backer.uid,backer.member_id,round(allocation.amount*100/gap,2),allocation.amount,
        case when result_side=gap_side then 'Win' else 'Lose' end,net_result,
        case when result_side=gap_side then coverage_charge else 0 end,balance);
    end if;
  end loop;

  select water_margin into margin from public.system_settings where shop_id = p_shop order by id limit 1;
  if margin is not null and margin not between 0 and 1 then raise exception 'ROUND_MARGIN_INVALID'; end if;
  for bill in select * from public.bets
    where shop_id = p_shop and round_id = p_round and status = 'Active'
    order by bet_id for update
  loop
    payout_amount := 0;
    matched_fee := 0;
    player_coverage_fee := 0;
    if bill.bet_type=result_side and winning_total>0 then
      -- Apportion fees across winning bills to the cent without losing rounding remainders.
      matched_fee := round((cumulative+bill.amount)*matched_total*coalesce(margin,0.05)/winning_total,2)
        - round(cumulative*matched_total*coalesce(margin,0.05)/winning_total,2);
      if result_side<>gap_side then
        player_coverage_fee := round((cumulative+bill.amount)*gross_coverage_fee/winning_total,2)
          - round(cumulative*gross_coverage_fee/winning_total,2);
      end if;
      cumulative := cumulative+bill.amount;
      payout_amount := 2*bill.amount-matched_fee-player_coverage_fee;
    end if;
    if payout_amount > 0 and not coalesce(bill.cash_table,false) then
      if bill.play_mode = 'table' then
        update public.tables set credit = coalesce(credit, 0) + payout_amount
          where shop_id = p_shop and table_no = bill.table_no;
        if not found then raise exception 'ROUND_PAYOUT_TARGET_MISSING'; end if;
      else
        update public.users set credit_balance = coalesce(credit_balance, 0) + payout_amount
          where shop_id = p_shop and uid = bill.uid;
        if not found then raise exception 'ROUND_PAYOUT_TARGET_MISSING'; end if;
      end if;
    end if;
    update public.bets set status = case when bill.bet_type = result_side then 'Win' else 'Lose' end, payout = payout_amount,
      matched_water_fee=matched_fee, coverage_water_fee=player_coverage_fee
      where shop_id = p_shop and round_id = p_round and bet_id = bill.bet_id;
  end loop;
  update public.rounds set status = 'Ended', weight = p_weight, result = result_side, settlement_weight = p_weight, settled_at=calculated_at
    where shop_id = p_shop and round_id = p_round;
  return 'ENDED';
end;
$finalize$;


-- Keep legacy callers on the same settlement checks.
create or replace function public.finalize_balanced_round(p_shop text,p_round text,p_weight numeric)
returns text language sql security invoker set search_path='' as $$
  select public.finalize_staff_round(p_shop,p_round,p_weight);
$$;

create or replace function public.begin_round_settlement(p_shop text,p_round text,p_weight numeric,p_resolver text)
returns text language sql security invoker set search_path='' as $$
  select 'ROUND_REVIEW_REQUIRED'::text;
$$;

create function public.daily_round_coverage_report(p_shop text,p_day date)
returns jsonb language sql stable set search_path='' as $$
  with bounds as (
    select (p_day+time '06:00') at time zone 'Asia/Bangkok' as starts,
      (p_day+1+time '06:00') at time zone 'Asia/Bangkok' as ends
  ), round_bills as (
    select b.*,case when b.cash_table or b.play_mode='table' then 'table' else 'wallet' end as channel
    from public.rounds r join public.bets b using (shop_id,round_id) cross join bounds
    where r.shop_id=p_shop and r.settled_at>=starts and r.settled_at<ends and b.status in ('Win','Lose')
  ), payouts as (
    select b.channel,sum(b.amount) as stake,sum(payout) as payout,count(*) as bills,
      sum(matched_water_fee) as matched_fee,sum(coverage_water_fee) as player_fee,
      sum(coalesce(c.amount,0)) as referral
    from round_bills b left join public.referral_commission_credits c using (shop_id,bet_id)
    group by b.channel
  ), allocated as (
    select a.*,coalesce(u.display_name,u.member_id,a.recipient) as name,
      sum(b.amount) as exposure,sum(b.amount) filter (where b.channel='wallet') as wallet_exposure
    from shop_finance_private.coverage_allocations a join round_bills b using (shop_id,round_id)
    left join public.users u on u.shop_id=a.shop_id and u.uid=a.recipient
    where a.settled_at is not null and b.bet_type<>a.covered_side
    group by a.shop_id,a.round_id,a.recipient,u.display_name,u.member_id
  ), split as (
    select a.recipient,a.name,c.channel,
      case when c.channel='wallet' then share.amount else a.amount-share.amount end as amount,
      case when c.channel='wallet' then share.fee else a.fee-share.fee end as fee,
      case when c.channel='wallet' then share.pnl else a.pnl-share.pnl end as pnl
    from allocated a cross join (values ('wallet'),('table')) c(channel)
    cross join lateral (
      select round(a.amount*coalesce(a.wallet_exposure,0)/a.exposure,2) as amount,
        round(a.fee*coalesce(a.wallet_exposure,0)/a.exposure,2) as fee,
        round(a.pnl*coalesce(a.wallet_exposure,0)/a.exposure,2) as pnl
    ) share
  ), recipients as (
    select channel,recipient,case when recipient='' then 'ร้าน' else name end as name,
      sum(amount) as covered,sum(fee) as fee,sum(pnl) as pnl,
      sum(case when pnl + fee>0 then pnl+fee else 0 end) as won,
      sum(case when pnl<0 then -pnl else 0 end) as lost
    from split where amount<>0 or fee<>0 or pnl<>0 group by channel,recipient,name
  ), report as (
    select d.channel,coalesce(p.stake,0) as stake,coalesce(p.payout,0) as payout,coalesce(p.bills,0) as bills,
      coalesce(p.matched_fee,0) as matched_fee,
      coalesce(p.player_fee,0)+coalesce(sum(r.fee),0) as coverage_fee,
      coalesce(p.referral,0) as referral,
      coalesce(p.matched_fee,0)+coalesce(p.player_fee,0)+coalesce(sum(r.fee),0)-coalesce(p.referral,0) as net_fee,
      coalesce(jsonb_agg(to_jsonb(r)-'channel' order by r.recipient) filter (where r.recipient is not null),'[]') as recipients
    from (values ('wallet'),('table')) d(channel) left join payouts p using (channel) left join recipients r using (channel)
    group by d.channel,p.stake,p.payout,p.bills,p.matched_fee,p.player_fee,p.referral
  )
  select jsonb_build_object('channels',jsonb_object_agg(channel,to_jsonb(report)-'channel'),
    'total_net_fee',sum(net_fee),'settled_bills',sum(bills)) from report;
$$;
revoke all on function public.daily_round_coverage_report(text,date) from public,anon,authenticated;
grant execute on function public.daily_round_coverage_report(text,date) to service_role;

commit;
