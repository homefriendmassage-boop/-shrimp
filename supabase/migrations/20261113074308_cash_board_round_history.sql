begin;

create or replace function public.read_public_cash_board(p_shop text)
returns jsonb language sql stable set search_path = '' as $$
  with shop as (
    select shop_name from public.shops where shop_id = p_shop and lower(status) = 'active'
  ), current_round as (
    select round_id, status, end_time_ms from public.rounds where shop_id = p_shop
    order by created_at desc nulls last, round_id desc limit 1
  ), round_bets as (
    select b.bet_type, b.amount, b.play_mode, b.table_no, b.bet_id
    from public.bets b join current_round r using (round_id)
    where b.shop_id = p_shop and b.status <> 'Cancelled'
  ), accounting_day as (
    select public.shop_accounting_day(now()) as day
  ), finished as (
    select r.round_id, r.weight, r.result, r.created_at
    from public.rounds r cross join accounting_day d
    where r.shop_id = p_shop and r.status = 'Ended'
      and r.created_at >= (d.day + time '06:00') at time zone 'Asia/Bangkok'
      and r.created_at < (d.day + 1 + time '06:00') at time zone 'Asia/Bangkok'
  ), round_stats as (
    select r.round_id, r.weight, r.result, r.created_at,
      coalesce(sum(b.amount) filter (where b.bet_type = 'คู่'),0) as even,
      coalesce(sum(b.amount) filter (where b.bet_type = 'คี่'),0) as odd
    from finished r left join public.bets b
      on b.round_id = r.round_id and b.shop_id = p_shop and b.status <> 'Cancelled'
    group by r.round_id, r.weight, r.result, r.created_at
  ), daily as (
    select count(*) as rounds, count(*) filter (where result = 'คู่') as even,
      count(*) filter (where result = 'คี่') as odd,
      coalesce(sum(even),0) + coalesce(sum(odd),0) as total
    from round_stats
  )
  select jsonb_build_object(
    'shop_name', shop.shop_name,
    'round', (select to_jsonb(r) from current_round r),
    'totals', (select jsonb_build_object(
      'even', coalesce(sum(amount) filter (where bet_type = 'คู่'),0),
      'odd', coalesce(sum(amount) filter (where bet_type = 'คี่'),0),
      'even_count', count(distinct case when play_mode = 'table' then 'table:' || table_no else bet_id::text end) filter (where bet_type = 'คู่'),
      'odd_count', count(distinct case when play_mode = 'table' then 'table:' || table_no else bet_id::text end) filter (where bet_type = 'คี่'),
      'tables', coalesce(jsonb_agg(distinct table_no order by table_no) filter (where play_mode = 'table'), '[]'::jsonb)
    ) from round_bets),
    'last_result', (select jsonb_build_object('round_id',round_id,'weight',weight,'result',result)
      from public.rounds where shop_id = p_shop and status = 'Ended'
      order by created_at desc nulls last, round_id desc limit 1),
    'accounting_day', (select day from accounting_day),
    'daily', (select to_jsonb(d) from daily d),
    'history', (select coalesce(jsonb_agg(to_jsonb(r) - 'created_at'
      order by r.created_at desc, r.round_id desc), '[]'::jsonb) from round_stats r)
  ) from shop;
$$;

commit;
