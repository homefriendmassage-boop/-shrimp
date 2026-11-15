create or replace function public.cash_table_round_summary(p_shop text, p_round text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with ended_round as (
    select r.shop_id, r.round_id
    from public.rounds r
    where r.shop_id = p_shop and r.round_id = p_round and r.status = 'Ended'
  ), settled_bills as (
    select b.table_no, b.cash_table, b.play_mode, b.amount, coalesce(b.payout, 0) as payout
    from ended_round r
    join public.bets b on b.shop_id = r.shop_id and b.round_id = r.round_id
    where b.status in ('Win', 'Lose')
  ), cash_by_table as (
    -- The cash table ledger subtracts the stake on placement and adds the payout on settlement.
    select b.table_no, sum(b.amount) as stake, sum(b.payout) as payout,
      sum(b.payout - b.amount) as net
    from settled_bills b
    where b.cash_table
    group by b.table_no
  ), cash_totals as (
    select coalesce(sum(c.stake), 0) as stake,
      coalesce(sum(c.payout), 0) as payout,
      coalesce(sum(c.net) filter (where c.net > 0), 0) as cash_pay,
      coalesce(sum(-c.net) filter (where c.net < 0), 0) as cash_receive,
      coalesce(jsonb_agg(jsonb_build_object(
        'number', c.table_no, 'name', t.table_name,
        'pay', greatest(c.net, 0), 'receive', greatest(-c.net, 0)
      ) order by c.table_no), '[]'::jsonb) as tables
    from cash_by_table c
    left join public.tables t on t.shop_id = p_shop and t.table_no = c.table_no
  ), wallet_totals as (
    select coalesce(sum(b.amount), 0) as stake, coalesce(sum(b.payout), 0) as payout
    from settled_bills b
    where b.cash_table is not true and b.play_mode = 'private'
  )
  select jsonb_build_object(
    'stake', c.stake, 'payout', c.payout,
    'cash_pay', c.cash_pay, 'cash_receive', c.cash_receive, 'tables', c.tables,
    'wallet_stake', w.stake, 'wallet_payout', w.payout
  )
  from ended_round
  cross join cash_totals c
  cross join wallet_totals w;
$$;
