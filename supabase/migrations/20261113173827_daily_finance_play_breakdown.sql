begin;

create or replace function public.daily_group_finance_report(p_shop text, p_day date)
returns jsonb language sql stable set search_path = '' as $$
  with bounds as (
    select (p_day + time '06:00') at time zone 'Asia/Bangkok' as starts,
      (p_day + 1 + time '06:00') at time zone 'Asia/Bangkok' as ends
  ), day_rounds as (
    select r.round_id,r.status,r.result from public.rounds r cross join bounds
    where r.shop_id=p_shop and r.created_at>=starts and r.created_at<ends
  ), report_bets as (
    select b.amount,b.payout,b.status,b.cash_table,
      case when b.cash_table or b.play_mode='table' then 'table'
           when b.play_mode='private' then 'online' end as channel
    from public.bets b join day_rounds r on r.round_id=b.round_id
    where b.shop_id=p_shop and (b.status in ('Active','Cancelled') or r.status='Ended')
  ), play as (
    select coalesce(sum(amount) filter (where status in ('Win','Lose')),0) as settled_stake,
      coalesce(sum(payout) filter (where status='Win'),0) as payout,
      coalesce(sum(amount) filter (where status='Cancelled'),0) as cancelled,
      count(*) filter (where status='Active') as pending,
      coalesce(sum(amount) filter (where status in ('Win','Lose') and cash_table),0) as cash_stake,
      coalesce(sum(amount) filter (where status in ('Win','Lose') and channel='online'),0) as online_stake,
      coalesce(sum(payout) filter (where status='Win' and channel='online'),0) as online_payout,
      count(*) filter (where status in ('Win','Lose') and channel='online') as online_bills,
      coalesce(sum(amount) filter (where status in ('Win','Lose') and channel='table'),0) as table_stake,
      coalesce(sum(payout) filter (where status='Win' and channel='table'),0) as table_payout,
      count(*) filter (where status in ('Win','Lose') and channel='table') as table_bills,
      count(*) filter (where status in ('Win','Lose') and channel is null) as unclassified_bills
    from report_bets
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
  ), wallet as (
    -- Include balances still owed on inactive accounts. Backer withdrawals use backer_wallet.
    select coalesce(sum(u.credit_balance),0) as customer_wallet_liability,
      statement_timestamp() as wallet_as_of
    from public.users u
    where u.shop_id=p_shop and u.role is distinct from 'Backer' and u.credit_balance>0
  ), stats as (
    select count(*) as rounds, count(*) filter (where status='Ended') as ended,
      count(*) filter (where status='Ended' and result='คู่') as even,
      count(*) filter (where status='Ended' and result='คี่') as odd
    from day_rounds
  )
  select to_jsonb(play) || to_jsonb(backer) || to_jsonb(movements) || to_jsonb(stats) || to_jsonb(wallet)
  from play cross join backer cross join movements cross join stats cross join wallet;
$$;

revoke all on function public.daily_group_finance_report(text,date) from public,anon,authenticated;
grant execute on function public.daily_group_finance_report(text,date) to service_role;

commit;
