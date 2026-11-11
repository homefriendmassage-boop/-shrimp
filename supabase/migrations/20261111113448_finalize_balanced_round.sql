create function public.finalize_balanced_round(p_shop text, p_round text, p_weight numeric)
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
    if payout_amount > 0 then
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
revoke all on function public.finalize_balanced_round(text,text,numeric) from public, anon, authenticated;
grant execute on function public.finalize_balanced_round(text,text,numeric) to service_role;
