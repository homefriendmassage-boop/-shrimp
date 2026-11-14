begin;

create or replace function public.read_player_live_state(p_shop text, p_uid text, p_table text, p_results boolean)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with allowed as (
    select u.credit_balance
    from public.users u
    join public.shops s on s.shop_id = u.shop_id
    join public.membership_applications a on a.shop_id = u.shop_id and a.line_uid = u.uid
    where u.shop_id = p_shop and u.uid = p_uid and u.status = 'Active'
      and a.state = 'Approved' and lower(s.status) = 'active'
  ), current_round as (
    select r.round_id, r.status, r.end_time_ms, r.weight, r.result
    from public.rounds r
    where r.shop_id = p_shop
    order by r.created_at desc nulls last, r.round_id desc
    limit 1
  ), last_result as (
    select r.round_id, r.weight, r.result
    from public.rounds r
    where r.shop_id = p_shop and r.status = 'Ended'
    order by r.created_at desc nulls last, r.round_id desc
    limit 1
  ), totals as (
    select
      coalesce(sum(b.amount) filter (where b.bet_type = 'คู่'), 0) as even,
      coalesce(sum(b.amount) filter (where b.bet_type = 'คี่'), 0) as odd,
      coalesce(sum(b.amount), 0) as total,
      count(distinct case when b.play_mode = 'table' and b.table_no is not null and b.table_no <> '-'
        then 'table:' || b.table_no else 'bet:' || b.bet_id::text end)
        filter (where b.bet_type = 'คู่') as even_count,
      count(distinct case when b.play_mode = 'table' and b.table_no is not null and b.table_no <> '-'
        then 'table:' || b.table_no else 'bet:' || b.bet_id::text end)
        filter (where b.bet_type = 'คี่') as odd_count
    from public.bets b join current_round r on r.round_id = b.round_id
    where b.shop_id = p_shop and b.status is distinct from 'Cancelled'
  )
  select jsonb_build_object(
    'credit', coalesce(allowed.credit_balance, 0),
    'table_credit', (select coalesce(t.credit, 0) from public.tables t
      where t.shop_id = p_shop and t.table_no = p_table),
    'round', (select to_jsonb(r) from current_round r),
    'last_result', (select to_jsonb(r) from last_result r),
    'daily_results', case when p_results then (
      select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc, r.round_id desc), '[]'::jsonb)
      from (
        select round_id, weight, result, created_at
        from public.rounds
        where shop_id = p_shop and status = 'Ended'
          and created_at >= ((public.shop_accounting_day(now()) + time '06:00') at time zone 'Asia/Bangkok')
          and created_at < ((public.shop_accounting_day(now()) + 1 + time '06:00') at time zone 'Asia/Bangkok')
      ) r
    ) else null end,
    'totals', (select to_jsonb(t) from totals t)
  )
  from allowed;
$$;

revoke all on function public.read_player_live_state(text,text,text,boolean) from public, anon, authenticated;
grant execute on function public.read_player_live_state(text,text,text,boolean) to service_role;

commit;
