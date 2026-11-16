create or replace function public.move_backer_funds(p_shop text,p_actor text,p_recipient text,p_amount numeric,p_kind text,p_request uuid)
returns text language plpgsql set search_path='' as $$
declare
  account public.users%rowtype;
  previous shop_finance_private.coverage_wallet_movements%rowtype;
  staff_name text;
  next_balance numeric;
begin
  if p_request is null or p_kind is null or p_kind not in ('deposit','withdraw') or p_amount is null
    or p_amount not between 100 and 999999999 or p_amount<>round(p_amount,2) then return 'COVERAGE_INVALID'; end if;
  select coalesce(display_name,member_id,'Admin') into staff_name from public.users
    where shop_id=p_shop and uid=p_actor and status='Active' and role in ('Admin','Superadmin');
  if not found then return 'ADMIN_REQUIRED'; end if;
  perform 1 from public.shops where shop_id=p_shop for update;
  select * into previous from shop_finance_private.coverage_wallet_movements
    where shop_id=p_shop and request_id=p_request;
  if found then
    return case when previous.recipient=p_recipient and previous.actor_uid=p_actor
      and previous.amount=p_amount and previous.kind=p_kind then 'RECORDED' else 'COVERAGE_INVALID' end;
  end if;
  if p_kind = 'withdraw' and not exists (
    select 1 from shop_finance_private.banker_payout_requests r
    where r.shop_id = p_shop and r.request_id = p_request and r.recipient = p_recipient
      and r.amount = p_amount and r.status = 'pending'
  ) then return 'BANKER_PAYOUT_QUEUE_REQUIRED'; end if;
  select * into account from public.users
    where shop_id=p_shop and uid=p_recipient and status='Active' and role='Backer' for update;
  if not found then return 'COVERAGE_INVALID'; end if;
  next_balance := coalesce(account.backer_wallet,0) + case when p_kind='deposit' then p_amount else -p_amount end;
  if next_balance<0 then return 'COVERAGE_WALLET_TOO_LOW'; end if;
  update public.users set backer_wallet=next_balance where shop_id=p_shop and uid=p_recipient;
  insert into shop_finance_private.coverage_wallet_movements(shop_id,request_id,recipient,actor_uid,amount,kind)
    values (p_shop,p_request,p_recipient,p_actor,p_amount,p_kind);
  insert into public.transactions(shop_id,target_id,type,amount,admin_name,target_type)
    values (p_shop,account.member_id,p_kind,p_amount,staff_name,'user');
  return 'RECORDED';
end;
$$;
revoke all on function public.move_backer_funds(text,text,text,numeric,text,uuid) from public,anon,authenticated;
grant execute on function public.move_backer_funds(text,text,text,numeric,text,uuid) to service_role;

create or replace function public.record_banker_payout(
  p_shop text, p_actor text, p_action text, p_request uuid,
  p_recipient text, p_amount numeric
)
returns text language plpgsql set search_path = '' as $$
declare
  request shop_finance_private.banker_payout_requests%rowtype;
  balance numeric;
  pending_total numeric;
  movement text;
begin
  if p_request is null or p_action is null or p_action not in ('request','pay','cancel') then
    return 'BANKER_PAYOUT_INVALID';
  end if;

  perform 1 from public.users where shop_id = p_shop and uid = p_actor
    and status = 'Active' and (role in ('Admin','Superadmin')
      or (role = 'Backer' and p_action = 'request' and uid = p_recipient));
  if not found then return 'ADMIN_REQUIRED'; end if;

  -- Use the same shop lock as settlement and manual banker wallet movements.
  perform 1 from public.shops where shop_id = p_shop for update;
  select * into request from shop_finance_private.banker_payout_requests
    where shop_id = p_shop and request_id = p_request;

  if p_action = 'request' then
    if p_amount is null or p_amount not between 100 and 999999999 or p_amount <> round(p_amount,2) then
      return 'BANKER_PAYOUT_INVALID';
    end if;
    if request.request_id is not null then
      if request.recipient = p_recipient and request.amount = p_amount and request.requested_by = p_actor then
        return 'RECORDED';
      end if;
      return 'BANKER_PAYOUT_INVALID';
    end if;
    select coalesce(backer_wallet,0) into balance from public.users
      where shop_id = p_shop and uid = p_recipient and role = 'Backer' and status = 'Active';
    if not found then return 'BANKER_PAYOUT_INVALID'; end if;
    select coalesce(sum(amount),0) into pending_total from shop_finance_private.banker_payout_requests
      where shop_id = p_shop and recipient = p_recipient and status = 'pending';
    if p_amount + pending_total > balance then return 'COVERAGE_WALLET_TOO_LOW'; end if;

    insert into shop_finance_private.banker_payout_requests (shop_id, request_id, recipient, amount, requested_by)
      values (p_shop, p_request, p_recipient, p_amount, p_actor);
    return 'RECORDED';
  end if;

  if request.request_id is null then return 'BANKER_PAYOUT_INVALID'; end if;
  if (p_action = 'pay' and request.status = 'paid') or (p_action = 'cancel' and request.status = 'cancelled') then
    return 'RECORDED';
  end if;
  if request.status <> 'pending' then return 'BANKER_PAYOUT_RESOLVED'; end if;

  if p_action = 'pay' then
    movement := public.move_backer_funds(p_shop, p_actor, request.recipient, request.amount, 'withdraw', p_request);
    if movement <> 'RECORDED' then return movement; end if;
  end if;
  update shop_finance_private.banker_payout_requests
    set status = case when p_action = 'pay' then 'paid' else 'cancelled' end,
        resolved_at = clock_timestamp(), resolved_by = p_actor
    where shop_id = p_shop and request_id = p_request;
  return 'RECORDED';
end;
$$;

create function public.daily_staff_round_report(p_shop text, p_day date)
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
      count(*) filter (where t.type = 'withdraw') as withdrawal_count
    from public.transactions t cross join bounds
    where t.shop_id = p_shop and t.created_at >= starts and t.created_at < ends
      and t.target_type is distinct from 'table' and t.cash_table_no is null
  ), round_totals as (
    select coalesce(jsonb_agg(to_jsonb(r) || to_jsonb(b) || to_jsonb(a) order by r.report_at desc, r.round_id), '[]'::jsonb) as items
    from rounds r
  cross join lateral (
    select coalesce(sum(amount) filter (where status in ('Win','Lose')),0) as gross,
      coalesce(sum(payout) filter (where status in ('Win','Lose')),0) as payout,
      coalesce(sum(amount) filter (where status = 'Cancelled'),0) as cancelled
    from public.bets where shop_id = p_shop and round_id = r.round_id
  ) b
  cross join lateral (
    select coalesce(sum(pnl_amount),0) as banker_pnl from public.backer_logs
    where shop_id = p_shop and round_id = r.round_id
  ) a
  )
  select jsonb_build_object('rounds', round_totals.items, 'wallet', to_jsonb(wallet))
  from round_totals cross join wallet;
$$;
revoke all on function public.daily_staff_round_report(text,date) from public,anon,authenticated;
grant execute on function public.daily_staff_round_report(text,date) to service_role;
