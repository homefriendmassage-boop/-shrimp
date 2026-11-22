create or replace function public.daily_staff_round_report(p_shop text, p_day date)
returns jsonb language sql stable set search_path = '' as $$
  with bounds as (
    select (p_day + time '06:00') at time zone 'Asia/Bangkok' as starts,
      (p_day + 1 + time '06:00') at time zone 'Asia/Bangkok' as ends
  ), rounds as (
    select r.round_id, r.result, r.weight, r.status, r.settled_at is null as legacy_date,
      coalesce(r.settled_at, r.created_at) as report_at
    from public.rounds r cross join bounds
    where r.shop_id = p_shop and r.status = 'Ended'
      and coalesce(r.settled_at, r.created_at) >= starts
      and coalesce(r.settled_at, r.created_at) < ends
  ), wallet as (
    select coalesce(sum(t.amount) filter (where t.type = 'deposit'),0) as deposits,
      coalesce(sum(t.amount) filter (where t.type = 'withdraw'),0) as withdrawals,
      count(*) filter (where t.type = 'deposit') as deposit_count,
      count(*) filter (where t.type = 'withdraw') as withdrawal_count,
      coalesce(sum(t.amount) filter (where t.target_type = 'user' and t.type = 'deposit'),0) as member_deposits,
      coalesce(sum(t.amount) filter (where t.target_type = 'user' and t.type = 'withdraw'),0) as member_withdrawals
    from public.transactions t cross join bounds
    where t.shop_id = p_shop and t.created_at >= starts and t.created_at < ends
      and t.target_type is distinct from 'table' and t.cash_table_no is null
  ), round_totals as (
    select coalesce(jsonb_agg(to_jsonb(r) || to_jsonb(b) || to_jsonb(a) order by r.report_at desc, r.round_id), '[]'::jsonb) as items
    from rounds r
  cross join lateral (
    select coalesce(sum(amount) filter (where status in ('Win','Lose')),0) as gross,
      coalesce(sum(payout) filter (where status in ('Win','Lose')),0) as payout,
      coalesce(sum(amount) filter (where status = 'Cancelled'),0) as cancelled,
      coalesce(sum(amount) filter (where status in ('Win','Lose') and cash_table is not true and play_mode = 'private'),0) as wallet_stake,
      coalesce(sum(payout) filter (where status in ('Win','Lose') and cash_table is not true and play_mode = 'private'),0) as wallet_payout,
      coalesce(sum(matched_water_fee) filter (where status in ('Win','Lose')),0) as matched_fee,
      coalesce(sum(coverage_water_fee) filter (where status in ('Win','Lose')),0) as player_coverage_fee
    from public.bets where shop_id = p_shop and round_id = r.round_id
  ) b
  cross join lateral (
    select coalesce(sum(pnl_amount),0) as banker_pnl,
      coalesce(sum(water_fee_deducted),0) as banker_fee
    from public.backer_logs
    where shop_id = p_shop and round_id = r.round_id
  ) a
  )
  select jsonb_build_object('rounds', round_totals.items, 'wallet', to_jsonb(wallet))
  from round_totals cross join wallet;
$$;
