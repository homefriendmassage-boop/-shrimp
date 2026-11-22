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
  ), member_movements as (
    select t.target_id as member_id,
      coalesce(sum(t.amount) filter (where t.type = 'deposit'),0) as deposits,
      coalesce(sum(t.amount) filter (where t.type = 'withdraw'),0) as paid
    from public.transactions t cross join bounds
    where t.shop_id = p_shop and t.target_type = 'user' and t.cash_table_no is null
      and t.type in ('deposit','withdraw') and t.created_at >= starts and t.created_at < ends
    group by t.target_id
  ), member_play as (
    select b.uid, coalesce(sum(b.payout),0) - coalesce(sum(b.amount),0) as net
    from public.bets b join rounds r on r.round_id = b.round_id
    where b.shop_id = p_shop and b.status in ('Win','Lose')
      and b.cash_table is not true and b.play_mode = 'private'
    group by b.uid
  ), pending as (
    select q.uid,
      coalesce(sum(q.amount) filter (where q.type = 'ถอนเงิน'),0) as wallet_pending,
      coalesce(sum(q.amount) filter (where q.type = 'ถอนโบนัส'),0) as bonus_pending
    from public.topup_requests q
    where q.shop_id = p_shop and q.status = 'Pending' and q.type in ('ถอนเงิน','ถอนโบนัส')
    group by q.uid
  ), referral_income as (
    select c.referrer_uid as uid, sum(c.amount) as earned
    from public.referral_commission_credits c cross join bounds
    where c.shop_id = p_shop and c.credited_at >= starts and c.credited_at < ends
    group by c.referrer_uid
  ), referral_payment as (
    select q.uid, sum(w.amount) as paid, sum(w.fee) as fee
    from shop_finance_private.bonus_withdrawals w
    join public.topup_requests q on q.shop_id = w.shop_id and q.id = w.request_id
    cross join bounds
    where w.shop_id = p_shop and w.approved_at >= starts and w.approved_at < ends
    group by q.uid
  ), reconciliation as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'member_id', u.member_id, 'deposits', coalesce(m.deposits,0),
      'play_net', coalesce(g.net,0), 'paid', coalesce(m.paid,0),
      'pending', coalesce(p.wallet_pending,0), 'balance', coalesce(u.credit_balance,0)
    ) order by u.member_id) filter (where u.role is distinct from 'Backer'
      and (m.member_id is not null or g.uid is not null or coalesce(p.wallet_pending,0) <> 0
        or coalesce(u.credit_balance,0) <> 0)), '[]'::jsonb) as players,
    coalesce(jsonb_agg(jsonb_build_object(
      'member_id', u.member_id, 'earned', coalesce(i.earned,0),
      'paid', coalesce(w.paid,0), 'fee', coalesce(w.fee,0),
      'pending', coalesce(p.bonus_pending,0), 'balance', coalesce(u.commission_balance,0)
    ) order by u.member_id) filter (where i.uid is not null or w.uid is not null
      or coalesce(p.bonus_pending,0) <> 0 or coalesce(u.commission_balance,0) <> 0), '[]'::jsonb) as referrals
    from public.users u
    left join member_movements m on m.member_id = u.member_id
    left join member_play g on g.uid = u.uid
    left join pending p on p.uid = u.uid
    left join referral_income i on i.uid = u.uid
    left join referral_payment w on w.uid = u.uid
    where u.shop_id = p_shop
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
  select jsonb_build_object('rounds', round_totals.items, 'wallet', to_jsonb(wallet),
    'reconciliation', to_jsonb(reconciliation))
  from round_totals cross join wallet cross join reconciliation;
$$;
