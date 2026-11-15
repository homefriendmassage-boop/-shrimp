create or replace function public.set_coverage_fund(p_shop text,p_actor text,p_recipient text,p_funded numeric,p_rate numeric)
returns text language plpgsql set search_path='' as $$
declare
  d date;
  wallet numeric;
  reserved numeric;
  settled_pnl numeric;
begin
  if p_recipient is null or p_funded is null or p_funded not between 0 and 999999999
    or p_funded <> round(p_funded,2) or p_rate not between 0 and 100
    or p_rate <> round(p_rate,2) then return 'COVERAGE_INVALID'; end if;
  perform 1 from public.shops where shop_id=p_shop for update;
  if not found then return 'SHOP_INVALID'; end if;
  d := public.shop_accounting_day(clock_timestamp());
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
    values (p_shop,d,p_recipient,p_funded,coalesce(p_rate,0),p_actor)
  on conflict (shop_id,day,recipient) do update set funded=excluded.funded,
    rate=coalesce(p_rate,coverage_funds.rate),
    actor_uid=excluded.actor_uid,updated_at=clock_timestamp();
  return 'SAVED';
end;
$$;

create function public.close_round_with_coverage(p_shop text,p_round text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  item public.rounds%rowtype;
  coverage_day date;
  pool jsonb;
  signed_gap numeric;
  needed numeric;
  remaining numeric;
  held numeric;
  target_side text;
  closed_now boolean;
  prior_valid boolean;
  team record;
  amount numeric;
  assignments jsonb := '{}'::jsonb;
  result text;
begin
  perform 1 from public.shops where shop_id=p_shop for update;
  select * into item from public.rounds where shop_id=p_shop
    order by created_at desc nulls last,round_id desc limit 1 for update;
  if not found or item.round_id is distinct from p_round or item.status not in ('Open','Closed')
    or item.settlement_weight is not null
    or exists(select 1 from public.bets where shop_id=p_shop and round_id=p_round and status in ('Win','Lose'))
    or exists(select 1 from public.backer_logs where shop_id=p_shop and round_id=p_round)
  then return jsonb_build_object('code','ROUND_NOT_CLOSED'); end if;

  closed_now := item.status='Open';
  if closed_now then
    update public.rounds set status='Closed' where shop_id=p_shop and round_id=p_round;
  end if;
  perform 1 from public.bets where shop_id=p_shop and round_id=p_round and status='Active'
    order by bet_id for update;
  perform 1 from public.users where shop_id=p_shop and role='Backer' and status='Active'
    order by uid for update;
  coverage_day := public.shop_accounting_day(clock_timestamp());
  pool := public.read_round_coverage(p_shop,p_round);
  signed_gap := (pool->>'even')::numeric-(pool->>'odd')::numeric;
  needed := abs(signed_gap);
  target_side := case when signed_gap>0 then 'คี่' else 'คู่' end;
  select coalesce(sum(a.amount),0),
    coalesce(bool_and(a.day=coverage_day and a.covered_side=target_side
      and a.amount<=coalesce(shop_finance_private.coverage_available(p_shop,coverage_day,a.recipient,p_round),0)),true)
    into held,prior_valid
    from shop_finance_private.coverage_allocations a
    where a.shop_id=p_shop and a.round_id=p_round and a.settled_at is null;
  remaining := needed;
  if not (prior_valid and held=needed and (case when needed=0 then item.resolver_type='none'
    else item.resolver_type in ('shop','backer') end) is true) then
    -- Fill from the strongest funded backers first. The shop covers only the remainder within its own limit.
    for team in
      select f.recipient,shop_finance_private.coverage_available(p_shop,coverage_day,f.recipient,p_round) as available
      from shop_finance_private.coverage_funds f
      where f.shop_id=p_shop and f.day=coverage_day and f.funded>0
      order by (f.recipient=''),available desc nulls last,f.recipient
    loop
      exit when remaining=0;
      amount := least(remaining,coalesce(team.available,0));
      if amount>0 then
        assignments := assignments || jsonb_build_object(team.recipient,amount);
        remaining := remaining-amount;
      end if;
    end loop;
    if remaining=0 then
      result := public.reserve_round_coverage(p_shop,p_round,assignments);
      if result is distinct from 'RESERVED' then
        raise exception '%', coalesce(result,'COVERAGE_UNAVAILABLE');
      end if;
    else
      delete from shop_finance_private.coverage_allocations
        where shop_id=p_shop and round_id=p_round and settled_at is null;
      update public.rounds set resolver_type=null where shop_id=p_shop and round_id=p_round;
    end if;
  else
    remaining := 0;
  end if;

  return jsonb_build_object(
    'code',case when remaining=0 then 'RESERVED' else 'BACKER_BALANCE_INSUFFICIENT' end,
    'closed_now',closed_now,'shortfall',remaining,
    'coverage',public.read_round_coverage(p_shop,p_round)
  );
end;
$$;

revoke all on function public.close_round_with_coverage(text,text) from public,anon,authenticated;
grant execute on function public.close_round_with_coverage(text,text) to service_role;
