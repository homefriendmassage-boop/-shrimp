create or replace function public.finalize_staff_round(p_shop text, p_round text, p_weight numeric)
returns text language plpgsql security invoker set search_path = '' as $finalize$
<<settlement>>
declare
  item public.rounds%rowtype;
  bill record;
  backer public.users%rowtype;
  gap numeric;
  allocation shop_finance_private.coverage_allocations%rowtype;
  matched_fee numeric;
  player_coverage_fee numeric;
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
  for bill in
    -- Match earlier winning bills first. Any part beyond the matched pool is
    -- covered by the reserved recipients, with the shop taking its share last.
    with winning_bills as (
      select b.bet_id, b.amount,
        sum(b.amount) over (
          order by b.created_at nulls last, b.bet_id rows unbounded preceding
        ) as through_stake
      from public.bets b
      where b.shop_id=p_shop and b.round_id=p_round and b.status='Active' and b.bet_type=result_side
    ), coverage_segments as (
      select a.amount, a.rate,
        matched_total + sum(a.amount) over (
          order by (a.recipient=''), a.recipient rows unbounded preceding
        ) - a.amount as start_stake
      from shop_finance_private.coverage_allocations a
      where a.shop_id=p_shop and a.round_id=p_round and a.settled_at=calculated_at
        and result_side<>gap_side
    )
    select b.*,
      coalesce(round(least(w.through_stake, matched_total)*coalesce(margin,0.05),2)
        - round(least(w.through_stake-w.amount, matched_total)*coalesce(margin,0.05),2),0) as bill_matched_fee,
      coalesce(c.fee,0) as bill_coverage_fee
    from public.bets b
    left join winning_bills w on w.bet_id=b.bet_id
    left join lateral (
      -- Differences of rounded cumulative fees retain each recipient’s exact
      -- configured fee even when its reservation spans more than one bill.
      select sum(
        round(least(w.through_stake - a.start_stake,a.amount)*a.rate/100,2)
        - round(greatest(w.through_stake - w.amount - a.start_stake,0)*a.rate/100,2)
      ) as fee
      from coverage_segments a
      where w.through_stake > a.start_stake and w.through_stake - w.amount < a.start_stake + a.amount
    ) c on true
    where b.shop_id=p_shop and b.round_id=p_round and b.status='Active'
    order by b.bet_id
  loop
    matched_fee := bill.bill_matched_fee;
    player_coverage_fee := bill.bill_coverage_fee;
    payout_amount := case when bill.bet_type=result_side
      then 2*bill.amount - matched_fee - player_coverage_fee else 0 end;
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
