begin;

alter table public.tables
  add column table_name text check (char_length(btrim(table_name)) between 1 and 40),
  add column is_open boolean not null default true,
  add column is_hidden boolean not null default false;

create or replace function public.place_player_cash_table_bet(
  p_shop text, p_uid text, p_round text, p_id uuid, p_type text, p_amount numeric,
  p_table text, p_day date, p_staff boolean
) returns jsonb language plpgsql set search_path = '' as $$
declare
  current_round public.rounds%rowtype;
  existing public.bets%rowtype;
  desk public.tables%rowtype;
  limits public.system_settings%rowtype;
begin
  if p_id is null or p_type is null or p_type not in ('คู่', 'คี่')
    or p_amount is null or p_amount not between 0.01 and 999999999
    or p_amount <> round(p_amount, 2) then return jsonb_build_object('code','BET_INVALID'); end if;
  select r.* into current_round from public.rounds r where r.shop_id = p_shop
    order by r.created_at desc nulls last, r.round_id desc limit 1 for update;
  if not exists (
    select 1 from public.users u join public.shops s on s.shop_id = u.shop_id
    where u.shop_id = p_shop and u.uid = p_uid and u.status = 'Active'
      and lower(s.status) = 'active'
      and (case when p_staff then u.role in ('Admin','Superadmin','Operator') else
        u.role is distinct from 'Promoter' and exists (
          select 1 from public.membership_applications a where a.shop_id = u.shop_id
            and a.line_uid = u.uid and a.member_id = u.member_id and a.state = 'Approved'
        ) end)
  ) then return jsonb_build_object('code','PLAYER_ACCESS_REQUIRED'); end if;

  select * into existing from public.bets where bet_id = p_id;
  if found then
    if existing.shop_id = p_shop and existing.uid = p_uid and existing.round_id = p_round
      and existing.amount = p_amount and existing.bet_type = p_type and existing.cash_table
      and existing.table_no = p_table then return jsonb_build_object('code','PLACED','bet_id',p_id); end if;
    return jsonb_build_object('code','BET_INVALID');
  end if;
  if p_day is distinct from public.shop_accounting_day(clock_timestamp()) then
    return jsonb_build_object('code','TABLE_QR_EXPIRED');
  end if;
  if current_round.round_id is distinct from p_round or current_round.status is distinct from 'Open'
    or current_round.end_time_ms is null or current_round.end_time_ms <= extract(epoch from clock_timestamp()) * 1000 then
    return jsonb_build_object('code','ROUND_CLOSED');
  end if;
  select * into limits from public.system_settings where shop_id = p_shop;
  if p_amount not between coalesce(limits.min_bet,20) and coalesce(limits.max_bet,5000) then
    return jsonb_build_object('code','BET_LIMIT','min',coalesce(limits.min_bet,20),'max',coalesce(limits.max_bet,5000));
  end if;
  select * into desk from public.tables where shop_id = p_shop and table_no = p_table for update;
  if not found or desk.cash_limit is null then return jsonb_build_object('code','CASH_TABLE_REQUIRED'); end if;
  if not desk.is_open or desk.is_hidden then return jsonb_build_object('code','TABLE_CLOSED'); end if;
  if coalesce(desk.credit,0) - p_amount < -desk.cash_limit then
    return jsonb_build_object('code','TABLE_CREDIT_LIMIT');
  end if;
  insert into public.bets (bet_id,shop_id,round_id,uid,table_no,bet_type,amount,status,play_mode,payout,cash_table)
    values (p_id,p_shop,p_round,p_uid,p_table,p_type,p_amount,'Active','table',0,true);
  update public.tables set credit = coalesce(credit,0) - p_amount where id = desk.id;
  return jsonb_build_object('code','PLACED','bet_id',p_id);
end;
$$;

create function public.cash_table_round_total(p_shop text, p_table text, p_round text)
returns numeric language sql stable set search_path = '' as $$
  select coalesce(sum(amount), 0) from public.bets
  where shop_id = p_shop and table_no = p_table and round_id = p_round
    and play_mode = 'table' and status <> 'Cancelled';
$$;

create function public.create_cash_table_range(p_shop text, p_count integer, p_limit numeric)
returns integer language plpgsql set search_path = '' as $$
declare added integer;
begin
  if p_count is null or p_count not between 1 and 100 or p_limit is null
    or p_limit not between 0.01 and 999999999 or p_limit <> round(p_limit, 2) then
    raise exception 'TABLE_RANGE_INVALID';
  end if;

  insert into public.tables (shop_id, table_no, credit, cash_limit)
  select p_shop, number::text, 0, p_limit
  from generate_series(1, p_count) as numbers(number)
  where not exists (
    select 1 from public.tables t where t.shop_id = p_shop
      and ltrim(t.table_no, '0') = number::text
  )
  on conflict (shop_id, table_no) do nothing;
  get diagnostics added = row_count;
  return added;
end;
$$;

create function public.read_public_cash_board(p_shop text)
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
  ), daily as (
    select count(*) filter (where result = 'คู่') as even,
      count(*) filter (where result = 'คี่') as odd
    from public.rounds where shop_id = p_shop and status = 'Ended'
      and created_at >= (public.shop_accounting_day(now()) + time '06:00') at time zone 'Asia/Bangkok'
      and created_at < (public.shop_accounting_day(now()) + 1 + time '06:00') at time zone 'Asia/Bangkok'
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
    'daily', (select to_jsonb(d) from daily d)
  ) from shop;
$$;

revoke all on function public.create_cash_table_range(text,integer,numeric), public.read_public_cash_board(text),
  public.cash_table_round_total(text,text,text)
  from public, anon, authenticated;
grant execute on function public.create_cash_table_range(text,integer,numeric), public.read_public_cash_board(text),
  public.cash_table_round_total(text,text,text)
  to service_role;

commit;
