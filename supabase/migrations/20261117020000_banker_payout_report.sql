create table if not exists shop_finance_private.banker_payout_requests (
  shop_id text not null references public.shops(shop_id),
  request_id uuid not null,
  recipient text not null,
  amount numeric(14,2) not null check (amount between 100 and 999999999),
  requested_by text not null,
  created_at timestamptz not null default clock_timestamp(),
  status text not null default 'pending' check (status in ('pending','paid','cancelled')),
  resolved_at timestamptz,
  resolved_by text,
  primary key (shop_id, request_id)
);
alter table shop_finance_private.banker_payout_requests enable row level security;
grant select, insert, update on shop_finance_private.banker_payout_requests to service_role;
create index if not exists banker_payout_requests_recipient_idx
  on shop_finance_private.banker_payout_requests (shop_id, recipient, status);

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
    and status = 'Active' and role in ('Admin','Superadmin');
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

create or replace function public.daily_banker_payout_report(p_shop text, p_day date)
returns jsonb language sql stable set search_path = '' as $$
  with bounds as (
    select (p_day + time '06:00') at time zone 'Asia/Bangkok' as starts,
      (p_day + 1 + time '06:00') at time zone 'Asia/Bangkok' as ends
  ), results as (
    select a.recipient, sum(a.pnl) as pnl
    from shop_finance_private.coverage_allocations a cross join bounds
    where a.shop_id = p_shop and a.settled_at >= starts and a.settled_at < ends and a.recipient <> ''
    group by a.recipient
  ), held as (
    select recipient, sum(amount) as amount
    from shop_finance_private.coverage_allocations
    where shop_id = p_shop and settled_at is null and recipient <> ''
    group by recipient
  ), payments as (
    select m.recipient, sum(m.amount) as paid
    from shop_finance_private.coverage_wallet_movements m cross join bounds
    where m.shop_id = p_shop and m.kind = 'withdraw' and m.created_at >= starts and m.created_at < ends
    group by m.recipient
  ), requests as (
    select r.recipient,
      coalesce(sum(r.amount) filter (where r.created_at >= starts and r.created_at < ends and r.status <> 'cancelled'),0) as requested,
      coalesce(sum(r.amount) filter (where r.status = 'pending'),0) as pending,
      jsonb_agg(jsonb_build_object('id',r.request_id,'amount',r.amount,'status',r.status,'created_at',r.created_at)
        order by r.created_at, r.request_id) as items
    from shop_finance_private.banker_payout_requests r cross join bounds
    where r.shop_id = p_shop and (
      r.created_at >= starts and r.created_at < ends
      or r.resolved_at >= starts and r.resolved_at < ends
      or r.status = 'pending' and statement_timestamp() >= starts and statement_timestamp() < ends
    )
    group by r.recipient
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'uid',u.uid,'name',coalesce(u.display_name,u.member_id),'member_id',u.member_id,
    'active',u.status = 'Active' and u.role = 'Backer',
    'wallet',coalesce(u.backer_wallet,0),'pnl',coalesce(results.pnl,0),
    'available',greatest(coalesce(u.backer_wallet,0)-coalesce(held.amount,0),0),
    'requested',coalesce(requests.requested,0),'paid',coalesce(payments.paid,0),
    'pending',coalesce(requests.pending,0),'items',coalesce(requests.items,'[]'::jsonb)
  ) order by u.display_name,u.member_id,u.uid), '[]'::jsonb)
  from public.users u
  left join results on results.recipient = u.uid
  left join held on held.recipient = u.uid
  left join payments on payments.recipient = u.uid
  left join requests on requests.recipient = u.uid
  where u.shop_id = p_shop and (
    u.role = 'Backer' and u.status = 'Active'
    or results.recipient is not null or payments.recipient is not null or requests.recipient is not null
  );
$$;

revoke all on function public.record_banker_payout(text,text,text,uuid,text,numeric) from public,anon,authenticated;
revoke all on function public.daily_banker_payout_report(text,date) from public,anon,authenticated;
grant execute on function public.record_banker_payout(text,text,text,uuid,text,numeric) to service_role;
grant execute on function public.daily_banker_payout_report(text,date) to service_role;
