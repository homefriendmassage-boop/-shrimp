begin;

create function public.daily_group_finance_report(p_shop text, p_day date)
returns jsonb language sql stable set search_path = '' as $$
  with bounds as (
    select (p_day + time '06:00') at time zone 'Asia/Bangkok' as starts,
      (p_day + 1 + time '06:00') at time zone 'Asia/Bangkok' as ends
  ), day_rounds as (
    select r.round_id,r.status,r.result from public.rounds r cross join bounds
    where r.shop_id=p_shop and r.created_at>=starts and r.created_at<ends
  ), play as (
    select coalesce(sum(b.amount) filter (where b.status in ('Win','Lose')),0) as settled_stake,
      coalesce(sum(b.payout) filter (where b.status='Win'),0) as payout,
      coalesce(sum(b.amount) filter (where b.status='Cancelled'),0) as cancelled,
      count(*) filter (where b.status='Active') as pending,
      coalesce(sum(b.amount) filter (where b.status in ('Win','Lose') and b.cash_table),0) as cash_stake
    from public.bets b join day_rounds r on r.round_id=b.round_id where b.shop_id=p_shop and (b.status in ('Active','Cancelled') or r.status='Ended')
  ), backer as (
    select coalesce(sum(b.pnl_amount),0) as pnl from public.backer_logs b
    join day_rounds r on r.round_id=b.round_id
    where b.shop_id=p_shop and r.status='Ended'
  ), movements as (
    select coalesce(sum(t.amount) filter (where t.cash_table_no is not null and t.type='deposit'),0) as cash_in,
      coalesce(sum(t.amount) filter (where t.cash_table_no is not null and t.type='withdraw'),0) as cash_out,
      coalesce(sum(t.amount) filter (where t.target_type='user' and t.cash_table_no is null and t.type='deposit'),0) as credit_in,
      coalesce(sum(t.amount) filter (where t.target_type='user' and t.cash_table_no is null and t.type='withdraw'),0) as credit_out,
      coalesce(sum(t.amount) filter (where t.target_type='table' and t.cash_table_no is null and t.type='deposit'),0) as table_credit_in,
      coalesce(sum(t.amount) filter (where t.target_type='table' and t.cash_table_no is null and t.type='withdraw'),0) as table_credit_out
    from public.transactions t cross join bounds
    where t.shop_id=p_shop and t.created_at>=starts and t.created_at<ends
  ), stats as (
    select count(*) as rounds, count(*) filter (where status='Ended') as ended,
      count(*) filter (where status='Ended' and result='คู่') as even,
      count(*) filter (where status='Ended' and result='คี่') as odd
    from day_rounds
  )
  select to_jsonb(play) || to_jsonb(backer) || to_jsonb(movements) || to_jsonb(stats)
  from play cross join backer cross join movements cross join stats;
$$;

revoke all on function public.daily_group_finance_report(text,date) from public,anon,authenticated;
grant execute on function public.daily_group_finance_report(text,date) to service_role;

commit;
