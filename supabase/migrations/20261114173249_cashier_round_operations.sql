begin;

create function public.open_staff_round(p_shop text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  last_round public.rounds%rowtype;
  current_time_at timestamptz;
  day_code text;
  shop_code text;
  old_number text[];
  sequence_no numeric := 1;
  duration integer;
  new_round text;
begin
  shop_code := substring(p_shop from '^SHOP_([0-9]{3,24})$');
  if shop_code is null then return jsonb_build_object('code','SHOP_INVALID'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('open-round:' || p_shop,0));
  select * into last_round from public.rounds where shop_id = p_shop
    order by created_at desc nulls last, round_id desc limit 1 for update;
  if found and last_round.status is distinct from 'Ended' then
    return jsonb_build_object('code','ROUND_PREVIOUS_UNFINISHED');
  end if;
  current_time_at := clock_timestamp();
  day_code := to_char(public.shop_accounting_day(current_time_at),'YYMMDD');
  old_number := regexp_match(last_round.round_id, '^R-' || day_code || '-' || shop_code || '-([0-9]+)$');
  if old_number is null then
    old_number := regexp_match(last_round.round_id, '^R-' || day_code || '-([0-9]+)(?:-SHOP_' || shop_code || ')?$');
  end if;
  if old_number is not null then sequence_no := old_number[1]::numeric + 1; end if;
  select round_duration into duration from public.system_settings where shop_id = p_shop order by id limit 1;
  new_round := 'R-' || day_code || '-' || shop_code || '-' || sequence_no::text;
  insert into public.rounds (shop_id,round_id,status,end_time_ms,resolver_type)
    values (p_shop,new_round,'Open',
      floor(extract(epoch from current_time_at) * 1000)::bigint + coalesce(nullif(duration,0),15)::bigint * 60000,'none');
  return jsonb_build_object('code','OPENED','round_id',new_round);
end;
$$;

create function public.finalize_staff_round(p_shop text, p_round text, p_weight numeric)
returns text language plpgsql security invoker set search_path = '' as $finalize$
declare
  item public.rounds%rowtype;
  bill public.bets%rowtype;
  backer public.users%rowtype;
  gap numeric;
  backer_gap numeric;
  gap_side text;
  fee numeric;
  pnl numeric;
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

  select * into item from public.rounds
  where shop_id = p_shop and round_id = p_round for update;
  if not found then return 'ROUND_NOT_FOUND'; end if;
  if item.status = 'Ended' and item.weight = p_weight and item.result = result_side then return 'ENDED'; end if;
  if item.status is distinct from 'Closed' then return 'ROUND_NOT_CLOSED'; end if;
  if item.settlement_weight is not null and item.settlement_weight <> p_weight then return 'ROUND_RESULT_MISMATCH'; end if;
  if coalesce(item.resolver_type,'') not in ('none','shop','backer') then return 'ROUND_REVIEW_REQUIRED'; end if;

  select coalesce(sum(amount) filter (where bet_type = 'คู่'), 0),
    coalesce(sum(amount) filter (where bet_type = 'คี่'), 0),
    count(*) filter (where status in ('Win', 'Lose')),
    count(*) filter (where status = 'Active'), count(*)
  into total_even, total_odd, settled_count, active_count, bill_count
  from public.bets where shop_id = p_shop and round_id = p_round and status is distinct from 'Cancelled';
  gap := abs(total_even - total_odd);
  if (gap > 0 and item.resolver_type = 'none') or settled_count + active_count <> bill_count then
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

  if item.resolver_type = 'backer' and gap > 0 then
    gap_side := case when total_even > total_odd then 'คี่' else 'คู่' end;
    for backer in select * from public.users
      where shop_id = p_shop and role = 'Backer' and backer_share > 0 order by uid for update
    loop
      backer_gap := gap * backer.backer_share / 100;
      fee := case when result_side = gap_side then backer_gap * coalesce(backer.backer_water_fee,10) / 100 else 0 end;
      pnl := case when result_side = gap_side then backer_gap - fee else -backer_gap end;
      balance := coalesce(backer.backer_wallet,0) + pnl;
      if balance < 0 then raise exception 'BACKER_BALANCE_INSUFFICIENT'; end if;
      update public.users set backer_wallet = balance where shop_id = p_shop and uid = backer.uid;
      insert into public.backer_logs (shop_id,round_id,uid,member_id,share_percent,gap_amount,result_status,
        pnl_amount,water_fee_deducted,wallet_balance_after)
      values (p_shop,p_round,backer.uid,backer.member_id,backer.backer_share,backer_gap,
        case when result_side = gap_side then 'Win' else 'Lose' end,pnl,fee,balance);
    end loop;
  end if;

  select water_margin into margin from public.system_settings where shop_id = p_shop;
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
          where shop_id = p_shop and uid = bill.uid;
        if not found then raise exception 'ROUND_PAYOUT_TARGET_MISSING'; end if;
      end if;
    end if;
    update public.bets set status = case when bill.bet_type = result_side then 'Win' else 'Lose' end, payout = payout_amount
      where shop_id = p_shop and round_id = p_round and bet_id = bill.bet_id;
  end loop;
  update public.rounds set status = 'Ended', weight = p_weight, result = result_side, settlement_weight = p_weight
    where shop_id = p_shop and round_id = p_round;
  return 'ENDED';
end;
$finalize$;

create function public.cash_table_round_summary(p_shop text,p_round text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('stake',coalesce(sum(b.amount),0),'payout',coalesce(sum(b.payout),0))
  from public.rounds r left join public.bets b on b.shop_id = r.shop_id and b.round_id = r.round_id
    and b.cash_table and b.status in ('Win','Lose')
  where r.shop_id = p_shop and r.round_id = p_round and r.status = 'Ended'
  group by r.round_id;
$$;

revoke all on function public.open_staff_round(text), public.finalize_staff_round(text,text,numeric),
  public.cash_table_round_summary(text,text)
  from public, anon, authenticated;
grant execute on function public.open_staff_round(text), public.finalize_staff_round(text,text,numeric),
  public.cash_table_round_summary(text,text)
  to service_role;

commit;
