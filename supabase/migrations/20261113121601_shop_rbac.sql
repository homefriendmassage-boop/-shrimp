begin;

create table public.shop_role_audit (
  id bigint generated always as identity primary key,
  shop_id text not null references public.shops(shop_id),
  uid text not null,
  actor_uid text not null,
  old_role text, new_role text, old_status text, new_status text,
  created_at timestamptz not null default now()
);
create index shop_role_audit_shop_id_idx on public.shop_role_audit(shop_id,id desc);

create table public.shop_operation_audit (
  shop_id text not null references public.shops(shop_id),
  operation text not null,
  reference text not null,
  actor_uid text not null,
  details jsonb not null,
  created_at timestamptz not null default now(),
  primary key (shop_id,operation,reference)
);
alter table public.shop_role_audit enable row level security;
alter table public.shop_operation_audit enable row level security;
revoke all on public.shop_role_audit, public.shop_operation_audit from public, anon, authenticated;
grant select, insert on public.shop_role_audit, public.shop_operation_audit to service_role;

-- These relations are accessed through LINE-verified server routes.
revoke all on public.users, public.tables, public.rounds, public.bets, public.transactions,
  public.topup_requests, public.system_settings, public.backer_logs, public.membership_admins,
  public.membership_applications, public.slip_verifications, public.shops
  from public, anon, authenticated;

create function public.shop_actor_role(p_shop text,p_uid text)
returns text language sql stable set search_path = '' as $$
  select u.role from public.users u join public.shops s using (shop_id)
  where u.shop_id = p_shop and u.uid = p_uid and u.status = 'Active' and lower(s.status) = 'active';
$$;

create function public.set_shop_member_access(p_shop text,p_actor text,p_uid text,p_role text,p_status text)
returns text language plpgsql set search_path = '' as $$
declare
  member public.users%rowtype;
  next_role text;
  next_status text;
begin
  if p_role is not null and p_role not in ('Admin','Cashier','Operator','Promoter','Customer','Backer') or
     p_status is not null and p_status not in ('Active','Inactive') then return 'ROLE_INVALID'; end if;
  -- A shop row lock serializes all role changes for the shop.
  perform 1 from public.shops where shop_id = p_shop for update;
  if coalesce(public.shop_actor_role(p_shop,p_actor),'') not in ('Admin','Superadmin') then return 'ADMIN_REQUIRED'; end if;
  select * into member from public.users where shop_id = p_shop and uid = p_uid for update;
  if not found then return 'MEMBER_NOT_FOUND'; end if;
  if member.role = 'Superadmin' then return 'PROTECTED_ROLE'; end if;
  next_role := coalesce(p_role,member.role);
  next_status := coalesce(p_status,member.status);
  if next_role is not distinct from member.role and next_status is not distinct from member.status then return 'SAVED'; end if;
  if member.role = 'Admin' and member.status = 'Active'
    and (next_role is distinct from 'Admin' or next_status is distinct from 'Active')
    and not exists (select 1 from public.users where shop_id = p_shop and uid <> p_uid and role = 'Admin' and status = 'Active')
  then return 'LAST_SHOP_ADMIN'; end if;
  update public.users set role = next_role, status = next_status
    where shop_id = p_shop and uid = p_uid;
  insert into public.shop_role_audit (shop_id,uid,actor_uid,old_role,new_role,old_status,new_status)
    values (p_shop,p_uid,p_actor,member.role,next_role,member.status,next_status);
  return 'SAVED';
end;
$$;

create function public.cancel_shop_bill(p_shop text,p_actor text,p_id uuid,p_reason text)
returns text language plpgsql set search_path = '' as $$
declare
  bill public.bets%rowtype;
  previous jsonb;
  before_balance numeric;
  after_balance numeric;
begin
  if coalesce(public.shop_actor_role(p_shop,p_actor),'') not in ('Admin','Superadmin') then return 'ADMIN_REQUIRED'; end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 300 then return 'BILL_INVALID'; end if;
  select * into bill from public.bets where shop_id = p_shop and bet_id = p_id;
  if not found then return 'BILL_NOT_FOUND'; end if;
  perform 1 from public.rounds where shop_id = p_shop and round_id = bill.round_id for update;
  select * into bill from public.bets where shop_id = p_shop and bet_id = p_id for update;
  if bill.status = 'Cancelled' then
    select details into previous from public.shop_operation_audit
      where shop_id = p_shop and operation = 'cancel_bill' and reference = p_id::text and actor_uid = p_actor;
    if previous->>'reason' = btrim(p_reason) then return 'CANCELLED'; end if;
  end if;
  if bill.status is distinct from 'Active' or bill.amount is null or bill.amount <= 0 then return 'BET_NOT_ACTIVE'; end if;
  if bill.play_mode = 'table' then
    select credit into before_balance from public.tables where shop_id = p_shop and table_no = bill.table_no for update;
    if not found then raise exception 'BILL_TARGET_MISSING'; end if;
    if not bill.cash_table then
      update public.tables set credit = coalesce(credit,0) + bill.amount
        where shop_id = p_shop and table_no = bill.table_no;
    end if;
  else
    select credit_balance into before_balance from public.users where shop_id = p_shop and uid = bill.uid for update;
    if not found then raise exception 'BILL_TARGET_MISSING'; end if;
    update public.users set credit_balance = coalesce(credit_balance,0) + bill.amount
      where shop_id = p_shop and uid = bill.uid;
  end if;
  -- Existing cash-table trigger reverses the table stake when status changes.
  update public.bets set status = 'Cancelled', payout = 0 where shop_id = p_shop and bet_id = p_id;
  if bill.play_mode = 'table' then
    select credit into after_balance from public.tables where shop_id = p_shop and table_no = bill.table_no;
  else
    select credit_balance into after_balance from public.users where shop_id = p_shop and uid = bill.uid;
  end if;
  insert into public.shop_operation_audit (shop_id,operation,reference,actor_uid,details)
    values (p_shop,'cancel_bill',p_id::text,p_actor,jsonb_build_object('reason',btrim(p_reason),
      'amount',bill.amount,'before',before_balance,'after',after_balance));
  return 'CANCELLED';
end;
$$;

create function public.adjust_shop_balance(p_shop text,p_actor text,p_id uuid,p_target text,p_target_type text,p_type text,p_amount numeric)
returns jsonb language plpgsql set search_path = '' as $$
declare
  actor_role text := public.shop_actor_role(p_shop,p_actor);
  actor_name text;
  member public.users%rowtype;
  desk public.tables%rowtype;
  prior public.shop_operation_audit%rowtype;
  before_balance numeric;
  after_balance numeric;
begin
  if coalesce(actor_role,'') not in ('Admin','Superadmin','Cashier') or
    (actor_role = 'Cashier' and (p_target_type is distinct from 'table' or p_type is distinct from 'deposit'))
  then return jsonb_build_object('code','ADMIN_REQUIRED'); end if;
  if p_id is null or p_amount is null or p_amount not between 0.01 and 999999999 or p_amount <> round(p_amount,2)
    or p_type is null or p_type not in ('deposit','withdraw') or p_target_type is null or p_target_type not in ('table','user')
  then return jsonb_build_object('code','AMOUNT_INVALID'); end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shop || ':balance:' || p_id::text,0));
  select * into prior from public.shop_operation_audit
    where shop_id = p_shop and operation = 'adjust_balance' and reference = p_id::text;
  if found then
    if prior.actor_uid = p_actor and prior.details->>'target' = p_target and prior.details->>'target_type' = p_target_type
      and prior.details->>'type' = p_type and (prior.details->>'amount')::numeric = p_amount
    then return jsonb_build_object('code','RECORDED','balance',prior.details->'after'); end if;
    return jsonb_build_object('code','REQUEST_CONFLICT');
  end if;

  if p_target_type = 'table' then
    select * into desk from public.tables where shop_id = p_shop and table_no = p_target for update;
    if not found or desk.cash_limit is not null then return jsonb_build_object('code','TABLE_INVALID'); end if;
    before_balance := coalesce(desk.credit,0);
  else
    select * into member from public.users where shop_id = p_shop and member_id = p_target and status = 'Active' for update;
    if not found then return jsonb_build_object('code','MEMBER_NOT_FOUND'); end if;
    before_balance := coalesce(case when member.role = 'Backer' then member.backer_wallet else member.credit_balance end,0);
  end if;
  after_balance := before_balance + case when p_type = 'deposit' then p_amount else -p_amount end;
  if after_balance < 0 then return jsonb_build_object('code','WALLET_INSUFFICIENT_BALANCE'); end if;
  if p_target_type = 'table' then
    update public.tables set credit = after_balance where id = desk.id;
  elsif member.role = 'Backer' then
    update public.users set backer_wallet = after_balance where shop_id = p_shop and uid = member.uid;
  else
    update public.users set credit_balance = after_balance,
      total_deposit = case when p_type = 'deposit' then coalesce(total_deposit,0) + p_amount else total_deposit end
      where shop_id = p_shop and uid = member.uid;
  end if;
  select display_name into actor_name from public.users where shop_id = p_shop and uid = p_actor;
  insert into public.transactions (shop_id,target_id,type,amount,admin_name,target_type)
    values (p_shop,case when p_target_type = 'table' then 'โต๊ะ ' || p_target else p_target end,
      p_type,p_amount,coalesce(actor_name,p_actor),p_target_type);
  insert into public.shop_operation_audit (shop_id,operation,reference,actor_uid,details)
    values (p_shop,'adjust_balance',p_id::text,p_actor,jsonb_build_object('target',p_target,'target_type',p_target_type,
      'type',p_type,'amount',p_amount,'before',before_balance,'after',after_balance));
  return jsonb_build_object('code','RECORDED','balance',after_balance);
end;
$$;

create function public.request_promoter_commission(p_shop text,p_uid text,p_id uuid,p_type text,p_amount numeric)
returns text language plpgsql set search_path = '' as $$
declare
  member public.users%rowtype;
  prior jsonb;
  request_id text;
begin
  if coalesce(public.shop_actor_role(p_shop,p_uid),'') not in ('Promoter','Admin','Superadmin','Cashier') then return 'ACCESS_DENIED'; end if;
  if p_id is null or p_type is null or p_type not in ('cash','credit') or p_amount is null
    or p_amount not between 0.01 and 999999999 or p_amount <> round(p_amount,2) then return 'AMOUNT_INVALID'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shop || ':commission:' || p_id::text,0));
  select details into prior from public.shop_operation_audit where shop_id = p_shop
    and operation = 'request_commission' and reference = p_id::text and actor_uid = p_uid;
  if found then
    if prior->>'type' = p_type and (prior->>'amount')::numeric = p_amount then return 'QUEUED'; end if;
    return 'REQUEST_CONFLICT';
  end if;
  select * into member from public.users where shop_id = p_shop and uid = p_uid for update;
  if coalesce(member.commission_balance,0) < p_amount then return 'WALLET_INSUFFICIENT_BALANCE'; end if;
  update public.users set commission_balance = commission_balance - p_amount where shop_id = p_shop and uid = p_uid;
  insert into public.topup_requests (shop_id,uid,member_id,display_name,type,amount,method,fee_option,status)
    values (p_shop,p_uid,member.member_id,member.display_name,case when p_type = 'cash' then 'ถอนค่าคอม' else 'ฝากเงิน' end,
      p_amount,'ค่าคอมมิชชั่น','commission_transfer','Pending') returning id::text into request_id;
  insert into public.shop_operation_audit (shop_id,operation,reference,actor_uid,details)
    values (p_shop,'request_commission',p_id::text,p_uid,jsonb_build_object('request',request_id,
      'type',p_type,'amount',p_amount,'before',member.commission_balance,'after',member.commission_balance-p_amount));
  return 'QUEUED';
end;
$$;

create function public.reject_shop_wallet_request(p_shop text,p_actor text,p_request text,p_reason text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  item public.topup_requests%rowtype;
  actor_role text := public.shop_actor_role(p_shop,p_actor);
  actor_name text;
  before_balance numeric;
  after_balance numeric;
begin
  if coalesce(actor_role,'') not in ('Admin','Superadmin','Cashier') then return jsonb_build_object('code','ADMIN_REQUIRED'); end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 300 then return jsonb_build_object('code','WALLET_REQUEST_INVALID'); end if;
  select * into item from public.topup_requests where shop_id = p_shop and id::text = p_request for update;
  if not found or item.status is distinct from 'Pending' then return jsonb_build_object('code','REQUEST_NOT_PENDING'); end if;
  if actor_role = 'Cashier' and (item.type not in ('ฝากเงิน','ถอนเงิน') or item.wallet_slip_id is not null or
    coalesce(item.fee_option,'') in ('slip_review','commission_transfer') or
    (item.type = 'ฝากเงิน' and item.method is distinct from 'เงินสด') or
    (item.type = 'ถอนเงิน' and item.withdrawal_confirmation_id is null))
  then return jsonb_build_object('code','ADMIN_REQUIRED'); end if;
  if item.type = 'ถอนค่าคอม' or item.fee_option = 'commission_transfer' then
    select coalesce(commission_balance,0) into before_balance from public.users where shop_id = p_shop and uid = item.uid for update;
    if not found then raise exception 'WALLET_TARGET_MISSING'; end if;
    after_balance := before_balance + item.amount;
    update public.users set commission_balance = after_balance where shop_id = p_shop and uid = item.uid;
  end if;
  select display_name into actor_name from public.users where shop_id = p_shop and uid = p_actor;
  update public.topup_requests set status = 'Rejected', admin_name = coalesce(actor_name,p_actor)
    where shop_id = p_shop and id = item.id;
  insert into public.shop_operation_audit (shop_id,operation,reference,actor_uid,details)
    values (p_shop,'wallet_reject',p_request,p_actor,jsonb_build_object('reason',btrim(p_reason),
      'before',before_balance,'after',after_balance));
  return jsonb_build_object('code','REJECTED','uid',item.uid,'type',item.type,'amount',item.amount,'status','Rejected',
    'rejection_reason',btrim(p_reason));
end;
$$;

create or replace function public.approve_wallet_deposit(p_shop text, p_request text, p_staff text)
returns jsonb
language plpgsql security invoker set search_path = '' as $wallet_approve$
declare
  item public.topup_requests%rowtype;
  member public.users%rowtype;
  staff_name text;
  actor_role text := public.shop_actor_role(p_shop,p_staff);
  before_balance numeric;
  after_balance numeric;
begin
  select display_name into staff_name from public.users
    where shop_id = p_shop and uid = p_staff and status = 'Active'
      and actor_role in ('Admin','Superadmin','Cashier');
  if not found then return jsonb_build_object('code', 'ADMIN_REQUIRED'); end if;

  select * into item from public.topup_requests
    where shop_id = p_shop and id::text = p_request for update;
  if not found or item.status is distinct from 'Pending' or item.type is distinct from 'ฝากเงิน' then
    return jsonb_build_object('code', 'REQUEST_NOT_PENDING');
  end if;
  if actor_role = 'Cashier' and (item.wallet_slip_id is not null or
      coalesce(item.fee_option,'') in ('slip_review','commission_transfer') or
      (item.type = 'ฝากเงิน' and item.method is distinct from 'เงินสด') or
      (item.type = 'ถอนเงิน' and item.withdrawal_confirmation_id is null) or item.type = 'ถอนค่าคอม') then
    return jsonb_build_object('code','ADMIN_REQUIRED');
  end if;
  if item.amount is null or item.amount::text in ('NaN', 'Infinity', '-Infinity')
      or item.amount <= 0 or item.amount::numeric <> round(item.amount::numeric, 2) then
    return jsonb_build_object('code', 'INVALID_AMOUNT');
  end if;

  select * into member from public.users
    where shop_id = p_shop and uid = item.uid and member_id = item.member_id
      and status = 'Active' and role in ('Admin','Superadmin','Operator','Promoter','Customer','Backer','Cashier') for update;
  if not found then
    return jsonb_build_object('code', 'PLAYER_ACCESS_REQUIRED');
  end if;

  if member.role = 'Backer' then
    before_balance := coalesce(member.backer_wallet,0);
    update public.users set backer_wallet = before_balance + item.amount
      where shop_id = p_shop and uid = item.uid returning backer_wallet into after_balance;
  else
    before_balance := coalesce(member.credit_balance,0);
    update public.users set credit_balance = before_balance + item.amount,
      total_deposit = coalesce(total_deposit,0) + item.amount
      where shop_id = p_shop and uid = item.uid returning credit_balance into after_balance;
  end if;
  insert into public.transactions (shop_id, target_id, type, amount, admin_name, target_type)
    values (p_shop, item.member_id, 'deposit', item.amount, coalesce(staff_name, 'Admin'), 'user');
  update public.topup_requests set status = 'Approved', admin_name = coalesce(staff_name, 'Admin')
    where id = item.id and shop_id = p_shop;

  insert into public.shop_operation_audit (shop_id,operation,reference,actor_uid,details)
    values (p_shop,'wallet_approve',p_request,p_staff,jsonb_build_object('type',item.type,'amount',item.amount,
      'before',before_balance,'after',after_balance));
  return jsonb_build_object('code', 'APPROVED', 'uid', item.uid, 'type', item.type,
    'member_id', item.member_id, 'amount', item.amount, 'status', 'Approved');
end;
$wallet_approve$;

create or replace function public.approve_wallet_withdrawal(p_shop text, p_request text, p_staff text)
returns jsonb
language plpgsql
set search_path = ''
as $wallet_approve$
declare
  item public.topup_requests%rowtype;
  member public.users%rowtype;
  staff_name text;
  actor_role text := public.shop_actor_role(p_shop,p_staff);
  before_balance numeric;
  after_balance numeric;
begin
  select display_name into staff_name from public.users
    where shop_id = p_shop and uid = p_staff and status = 'Active'
      and actor_role in ('Admin','Superadmin','Cashier');
  if not found then return jsonb_build_object('code', 'ADMIN_REQUIRED'); end if;

  select * into item from public.topup_requests
    where shop_id = p_shop and id::text = p_request for update;
  if not found or item.status is distinct from 'Pending'
      or item.type is null or item.type not in ('ถอนเงิน', 'ถอนค่าคอม') then
    return jsonb_build_object('code', 'REQUEST_NOT_PENDING');
  end if;
  if actor_role = 'Cashier' and (item.wallet_slip_id is not null or
      coalesce(item.fee_option,'') in ('slip_review','commission_transfer') or
      (item.type = 'ฝากเงิน' and item.method is distinct from 'เงินสด') or
      (item.type = 'ถอนเงิน' and item.withdrawal_confirmation_id is null) or item.type = 'ถอนค่าคอม') then
    return jsonb_build_object('code','ADMIN_REQUIRED');
  end if;
  if item.amount is null or item.amount::text in ('NaN', 'Infinity', '-Infinity')
      or item.amount <= 0 or item.amount <> round(item.amount, 2) then
    return jsonb_build_object('code', 'INVALID_AMOUNT');
  end if;

  select * into member from public.users
    where shop_id = p_shop and uid = item.uid and member_id = item.member_id
      and status = 'Active' and role in ('Admin','Superadmin','Operator','Promoter','Customer','Backer','Cashier') for update;
  if not found then return jsonb_build_object('code', 'PLAYER_ACCESS_REQUIRED'); end if;

  if item.type = 'ถอนเงิน' then
    if member.role = 'Backer' then
      before_balance := coalesce(member.backer_wallet,0);
      if coalesce(member.backer_wallet, 0) < item.amount then
        return jsonb_build_object('code', 'WALLET_INSUFFICIENT_BALANCE');
      end if;
      update public.users set backer_wallet = backer_wallet - item.amount
        where shop_id = p_shop and uid = item.uid returning backer_wallet into after_balance;
    else
      before_balance := coalesce(member.credit_balance,0);
      if coalesce(member.credit_balance, 0) < item.amount then
        return jsonb_build_object('code', 'WALLET_INSUFFICIENT_BALANCE');
      end if;
      update public.users set credit_balance = credit_balance - item.amount
        where shop_id = p_shop and uid = item.uid returning credit_balance into after_balance;
    end if;
    insert into public.transactions (shop_id, target_id, type, amount, admin_name, target_type)
      values (p_shop, item.member_id, 'withdraw', item.amount, coalesce(staff_name, 'Admin'), 'user');
  end if;
  -- Commission withdrawals are deducted by the existing request flow.
  update public.topup_requests set status = 'Approved', admin_name = coalesce(staff_name, 'Admin')
    where id = item.id and shop_id = p_shop;

  insert into public.shop_operation_audit (shop_id,operation,reference,actor_uid,details)
    values (p_shop,'wallet_approve',p_request,p_staff,jsonb_build_object('type',item.type,'amount',item.amount,
      'before',before_balance,'after',after_balance));
  return jsonb_build_object('code', 'APPROVED', 'uid', item.uid, 'type', item.type,
    'member_id', item.member_id, 'amount', item.amount, 'status', 'Approved');
end;
$wallet_approve$;

create or replace function public.record_cash_table_payment(
  p_shop text, p_table text, p_id uuid, p_type text, p_amount numeric, p_staff text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  desk public.tables%rowtype;
  prior public.transactions%rowtype;
  balance numeric;
  before_balance numeric;
  actor_role text := public.shop_actor_role(p_shop,p_staff);
  actor_name text;
begin
  if coalesce(actor_role,'') not in ('Admin','Superadmin','Cashier','Operator')
    or (actor_role = 'Operator' and p_type is distinct from 'deposit') then
    return jsonb_build_object('code','ADMIN_REQUIRED');
  end if;
  if p_id is null or p_type is null or p_type not in ('deposit','withdraw')
    or p_amount is null or p_amount not between 0.01 and 999999999 or p_amount <> round(p_amount,2) then
    return jsonb_build_object('code','AMOUNT_INVALID');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_id::text,0));
  select * into desk from public.tables where shop_id = p_shop and table_no = p_table for update;
  if not found or desk.cash_limit is null then return jsonb_build_object('code','CASH_TABLE_REQUIRED'); end if;
  select * into prior from public.transactions where cash_entry_id = p_id;
  if found then
    if exists (select 1 from public.shop_operation_audit where shop_id = p_shop and operation = 'table_cash'
      and reference = p_id::text and actor_uid = p_staff) and prior.shop_id = p_shop and prior.cash_table_no = p_table and prior.type = p_type and prior.amount = p_amount then
      return jsonb_build_object('code','RECORDED','balance',desk.credit);
    end if;
    return jsonb_build_object('code','AMOUNT_INVALID');
  end if;
  if exists (select 1 from public.bets where shop_id = p_shop and table_no = p_table and cash_table and status = 'Active') then
    return jsonb_build_object('code','CASH_TABLE_WAITING_RESULT');
  end if;
  balance := coalesce(desk.credit,0);
  if (p_type = 'deposit' and p_amount > -balance) or (p_type = 'withdraw' and p_amount > balance) then
    return jsonb_build_object('code','CASH_AMOUNT_EXCEEDS_BALANCE');
  end if;
  before_balance := balance;
  balance := balance + case when p_type = 'deposit' then p_amount else -p_amount end;
  update public.tables set credit = balance where id = desk.id;
  select display_name into actor_name from public.users where shop_id = p_shop and uid = p_staff;
  insert into public.transactions (shop_id,target_id,type,amount,admin_name,target_type,cash_table_no,cash_entry_id)
    values (p_shop,'โต๊ะ ' || p_table,p_type,p_amount,coalesce(actor_name,p_staff),'table',p_table,p_id);
  insert into public.shop_operation_audit (shop_id,operation,reference,actor_uid,details)
    values (p_shop,'table_cash',p_id::text,p_staff,jsonb_build_object('table',p_table,'type',p_type,
      'amount',p_amount,'before',before_balance,'after',balance));
  return jsonb_build_object('code','RECORDED','balance',balance);
end;
$$;

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
      and (case when p_staff then u.role in ('Admin','Superadmin','Cashier','Operator') else
        u.role in ('Admin','Superadmin','Operator','Promoter','Customer','Backer') and exists (
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

create or replace function public.place_player_private_bet(
  p_shop text, p_uid text, p_round text, p_id uuid, p_type text, p_amount numeric
) returns jsonb
language plpgsql security invoker set search_path = '' as $bet$
declare
  current_round public.rounds%rowtype;
  existing public.bets%rowtype;
  player public.users%rowtype;
  limits public.system_settings%rowtype;
begin
  if p_id is null or p_type is null or p_type not in ('คู่', 'คี่')
    or p_amount is null or p_amount not between 0.01 and 999999999
    or p_amount <> round(p_amount, 2) then
    return jsonb_build_object('code', 'BET_INVALID');
  end if;

  select r.* into current_round from public.rounds r
    where r.shop_id = p_shop
    order by r.created_at desc nulls last, r.round_id desc limit 1 for update;

  select u.* into player from public.users u
    join public.shops s on s.shop_id = u.shop_id
    join public.membership_applications a on a.shop_id = u.shop_id and a.line_uid = u.uid and a.member_id = u.member_id
    where u.shop_id = p_shop and u.uid = p_uid and u.status = 'Active'
      and a.state = 'Approved' and lower(s.status) = 'active'
    for update of u;
  if not found or coalesce(player.role,'') not in ('Admin','Superadmin','Operator','Promoter','Customer','Backer') then
    return jsonb_build_object('code', 'PLAYER_ACCESS_REQUIRED');
  end if;

  select * into existing from public.bets where bet_id = p_id;
  if found then
    if existing.shop_id = p_shop and existing.uid = p_uid and existing.round_id = p_round
      and existing.amount = p_amount and existing.bet_type = p_type and existing.play_mode = 'private' then
      return jsonb_build_object('code', 'PLACED', 'bet_id', p_id);
    end if;
    return jsonb_build_object('code', 'BET_INVALID');
  end if;

  if current_round.round_id is distinct from p_round or current_round.status is distinct from 'Open'
    or current_round.end_time_ms is null or current_round.end_time_ms <= extract(epoch from clock_timestamp()) * 1000 then
    return jsonb_build_object('code', 'ROUND_CLOSED');
  end if;
  select * into limits from public.system_settings where shop_id = p_shop;
  if p_amount not between coalesce(limits.min_bet, 20) and coalesce(limits.max_bet, 5000) then
    return jsonb_build_object('code', 'BET_LIMIT', 'min', coalesce(limits.min_bet, 20), 'max', coalesce(limits.max_bet, 5000));
  end if;
  if coalesce(player.credit_balance, 0) < p_amount then
    return jsonb_build_object('code', 'CREDIT_INSUFFICIENT');
  end if;
  insert into public.bets (bet_id, shop_id, round_id, uid, table_no, bet_type, amount, status, play_mode, payout)
    values (p_id, p_shop, p_round, p_uid, '-', p_type, p_amount, 'Active', 'private', 0);
  update public.users set credit_balance = credit_balance - p_amount where shop_id = p_shop and uid = p_uid;
  return jsonb_build_object('code', 'PLACED', 'bet_id', p_id);
end;
$bet$;

create or replace function public.cancel_player_private_bet(p_shop text, p_uid text, p_id uuid)
returns text language plpgsql security invoker set search_path = '' as $cancel$
declare
  current_round public.rounds%rowtype;
  item public.bets%rowtype;
begin
  select r.* into current_round from public.rounds r where r.shop_id = p_shop
    order by r.created_at desc nulls last, r.round_id desc limit 1 for update;
  perform 1 from public.users u join public.shops s on s.shop_id = u.shop_id
    where u.shop_id = p_shop and u.uid = p_uid and u.status = 'Active' and lower(s.status) = 'active'
    for update of u;
  if not found then return 'PLAYER_ACCESS_REQUIRED'; end if;
  select * into item from public.bets where bet_id = p_id and shop_id = p_shop and uid = p_uid and play_mode = 'private' for update;
  if not found then return 'BET_NOT_FOUND'; end if;
  if item.status = 'Cancelled' then return 'CANCELLED'; end if;
  if item.status is distinct from 'Active' or current_round.round_id is distinct from item.round_id
    or current_round.status is distinct from 'Open' or current_round.end_time_ms is null
    or current_round.end_time_ms <= extract(epoch from clock_timestamp()) * 1000 then
    return 'ROUND_CLOSED';
  end if;
  update public.bets set status = 'Cancelled' where bet_id = p_id and shop_id = p_shop and uid = p_uid;
  update public.users set credit_balance = coalesce(credit_balance, 0) + item.amount where shop_id = p_shop and uid = p_uid;
  return 'CANCELLED';
end;
$cancel$;

create function public.finalize_shop_round(p_shop text, p_round text, p_weight numeric, p_actor text)
returns text language plpgsql security invoker set search_path = '' as $finalize$
declare
  item public.rounds%rowtype;
  bill public.bets%rowtype;
  result_side text;
  total_even numeric;
  total_odd numeric;
  settled_count bigint;
  active_count bigint;
  bill_count bigint;
  margin numeric;
  commission numeric;
  payout_amount numeric;
  referral text;
  backer public.users%rowtype;
  gap numeric;
  gap_side text;
  share_amount numeric;
  backer_delta numeric;
  fee numeric;
  next_backer_balance numeric;
begin
  if coalesce(public.shop_actor_role(p_shop,p_actor),'') not in ('Admin','Superadmin','Cashier') then return 'ADMIN_REQUIRED'; end if;
  if p_weight is null or p_weight <= 0 or p_weight > 1000000 then
    return 'ROUND_WEIGHT_INVALID';
  end if;
  result_side := case when mod(p_weight, 2) = 0 then 'คู่' else 'คี่' end;

  select * into item from public.rounds
  where shop_id = p_shop and round_id = p_round for update;
  if not found then return 'ROUND_NOT_FOUND'; end if;
  if item.status = 'Ended' and item.weight = p_weight and item.result = result_side then return 'ENDED'; end if;
  if item.status is distinct from 'Closed' then return 'ROUND_NOT_CLOSED'; end if;
  if coalesce(item.resolver_type,'') not in ('none','shop','backer') then return 'ROUND_REVIEW_REQUIRED'; end if;

  select coalesce(sum(amount) filter (where bet_type = 'คู่'), 0),
    coalesce(sum(amount) filter (where bet_type = 'คี่'), 0),
    count(*) filter (where status in ('Win', 'Lose')),
    count(*) filter (where status = 'Active'), count(*)
  into total_even, total_odd, settled_count, active_count, bill_count
  from public.bets where shop_id = p_shop and round_id = p_round and status is distinct from 'Cancelled';
  if (item.resolver_type = 'none' and total_even <> total_odd) or settled_count + active_count <> bill_count then return 'ROUND_REVIEW_REQUIRED'; end if;

  if settled_count > 0 then
    if active_count <> 0 or item.resolver_type <> 'none' then return 'ROUND_REVIEW_REQUIRED'; end if;
    if exists (select 1 from public.bets where shop_id = p_shop and round_id = p_round and status in ('Win','Lose')
      and status is distinct from case when bet_type = result_side then 'Win' else 'Lose' end) then
      return 'ROUND_RESULT_MISMATCH';
    end if;
    update public.rounds set status = 'Ended', weight = p_weight, result = result_side
      where shop_id = p_shop and round_id = p_round;
    return 'RECOVERED';
  end if;

  select water_margin, comm_rate into margin, commission from public.system_settings where shop_id = p_shop;
  gap := abs(total_even - total_odd);
  gap_side := case when total_even > total_odd then 'คี่' else 'คู่' end;
  if item.resolver_type = 'backer' and gap > 0 then
    for backer in select * from public.users
      where shop_id = p_shop and role = 'Backer' and status = 'Active' and backer_share > 0
      order by uid for update
    loop
      share_amount := gap * backer.backer_share / 100;
      fee := case when result_side = gap_side then share_amount * coalesce(backer.backer_water_fee,10) / 100 else 0 end;
      backer_delta := case when result_side = gap_side then share_amount - fee else -share_amount end;
      next_backer_balance := coalesce(backer.backer_wallet,0) + backer_delta;
      if next_backer_balance < 0 then raise exception 'BACKER_INSUFFICIENT_BALANCE'; end if;
      update public.users set backer_wallet = next_backer_balance where shop_id = p_shop and uid = backer.uid;
      insert into public.backer_logs
        (shop_id,round_id,uid,member_id,share_percent,gap_amount,result_status,pnl_amount,water_fee_deducted,wallet_balance_after)
        values (p_shop,p_round,backer.uid,backer.member_id,backer.backer_share,share_amount,
          case when result_side = gap_side then 'Win' else 'Lose' end,backer_delta,fee,next_backer_balance);
    end loop;
  end if;
  for bill in select * from public.bets
    where shop_id = p_shop and round_id = p_round and status = 'Active'
    order by bet_id for update
  loop
    payout_amount := case when bill.bet_type = result_side
      then bill.amount + bill.amount * (1 - coalesce(margin, 0.05)) else 0 end;
    if bill.cash_table then payout_amount := round(payout_amount, 2); end if;
    if payout_amount > 0 and not bill.cash_table then
      if bill.play_mode = 'table' then
        update public.tables set credit = coalesce(credit, 0) + payout_amount
          where shop_id = p_shop and table_no = bill.table_no;
        if not found then raise exception 'ROUND_PAYOUT_TARGET_MISSING'; end if;
      else
        update public.users set credit_balance = coalesce(credit_balance, 0) + payout_amount
          where shop_id = p_shop and uid = bill.uid returning referrer_uid into referral;
        if not found then raise exception 'ROUND_PAYOUT_TARGET_MISSING'; end if;
        if referral is not null and referral <> '-' then
          update public.users set commission_balance = coalesce(commission_balance, 0) + bill.amount * coalesce(commission, 0.01)
            where shop_id = p_shop and member_id = referral;
        end if;
      end if;
    end if;
    update public.bets set status = case when bill.bet_type = result_side then 'Win' else 'Lose' end, payout = payout_amount
      where shop_id = p_shop and round_id = p_round and bet_id = bill.bet_id;
  end loop;
  update public.rounds set status = 'Ended', weight = p_weight, result = result_side
    where shop_id = p_shop and round_id = p_round;
  insert into public.shop_operation_audit (shop_id,operation,reference,actor_uid,details)
    values (p_shop,'finalize_round',p_round,p_actor,jsonb_build_object('weight',p_weight,'result',result_side,'resolver',item.resolver_type));
  return 'ENDED';
end;
$finalize$;


-- Referrals attach to the application, then carry forward during approval.
alter table public.membership_applications add column referral_member_id text;
create function public.apply_shop_referral()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.state = 'Approved' and old.state is distinct from 'Approved' and new.referral_member_id is not null then
    update public.users set referrer_uid = new.referral_member_id
      where shop_id = new.shop_id and uid = new.line_uid and coalesce(referrer_uid,'-') = '-';
  end if;
  return new;
end;
$$;
create trigger zzzzzz_apply_shop_referral after update of state on public.membership_applications
  for each row execute function public.apply_shop_referral();

create or replace function public.credit_verified_wallet_slip(
  p_id uuid, p_shop text, p_uid text, p_ref text, p_hash text,
  p_amount numeric, p_bank text, p_number text, p_path text, p_slip_at timestamptz
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  member public.users%rowtype;
  before_balance numeric;
  after_balance numeric;
begin
  if p_ref is null or length(p_ref) not between 1 and 160
      or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2)
      or p_hash is null or p_hash !~ '^[a-f0-9]{64}$'
      or p_path is null then
    return 'INVALID_SLIP';
  end if;
  if not exists (
    select 1 from public.wallet_receiving_accounts a
    join public.shops s on s.shop_id = a.shop_id
    where a.shop_id = p_shop and a.enabled and lower(s.status) = 'active'
      and a.bank_code = p_bank and a.bank_number = p_number
      and a.auto_credit_from <= now() and p_slip_at >= a.auto_credit_from
      and p_slip_at <= now() + interval '1 minute'
  ) then
    return 'RECEIVER_MISMATCH';
  end if;

  select u.* into member from public.users u
  where u.uid = p_uid and u.shop_id = p_shop and u.status = 'Active'
    and u.role in ('Admin','Superadmin','Operator','Promoter','Customer','Backer')
    and exists (
      select 1 from public.membership_applications a
      where a.line_uid = u.uid and a.shop_id = u.shop_id
        and a.member_id = u.member_id and a.state = 'Approved'
    )
  for update;
  if not found then return 'PLAYER_ACCESS_REQUIRED'; end if;

  if exists (select 1 from public.wallet_slip_credits
      where shop_id = p_shop and uid = p_uid and image_hash = p_hash) then
    return 'ALREADY_CREDITED';
  end if;

  if exists (select 1 from public.slip_verifications where transaction_ref = p_ref) then
    return 'DUPLICATE_SLIP';
  end if;

  insert into public.wallet_slip_credits (transaction_ref, shop_id, uid, image_hash, amount)
  values (p_ref, p_shop, p_uid, p_hash, p_amount)
  on conflict do nothing;
  if not found then return 'DUPLICATE_SLIP'; end if;

  insert into public.slip_verifications (
    id, shop_id, uid, storage_path, claimed_amount, slip_amount,
    transaction_ref, receiver_matched, is_duplicate, status, verified_at
  ) values (
    p_id, p_shop, p_uid, p_path, p_amount, p_amount,
    p_ref, true, false, 'Verified', now()
  );

  if member.role = 'Backer' then
    before_balance := coalesce(member.backer_wallet,0);
    update public.users set backer_wallet = before_balance + p_amount
      where uid = p_uid and shop_id = p_shop returning backer_wallet into after_balance;
  else
    before_balance := coalesce(member.credit_balance,0);
    update public.users set credit_balance = before_balance + p_amount,
      total_deposit = coalesce(total_deposit,0) + p_amount
      where uid = p_uid and shop_id = p_shop returning credit_balance into after_balance;
  end if;
  insert into public.shop_operation_audit (shop_id,operation,reference,actor_uid,details)
    values (p_shop,'thunder_credit',p_ref,p_uid,jsonb_build_object('processor','Thunder','amount',p_amount,
      'before',before_balance,'after',after_balance));

  insert into public.transactions (shop_id, target_id, type, amount, admin_name, target_type)
  values (p_shop, member.member_id, 'deposit', p_amount, 'Thunder', 'user');

  return 'CREDITED';
end;
$$;


create or replace function public.queue_verified_wallet_slip(
  p_id uuid, p_shop text, p_uid text, p_ref text, p_claimed numeric, p_actual numeric,
  p_bank text, p_number text, p_path text, p_slip_at timestamptz, p_reason text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  member public.users%rowtype;
  review_status text;
begin
  if p_id is null or p_ref is null or length(p_ref) not between 1 and 160
      or p_claimed is null or p_actual is null or p_claimed not between 0.01 and 999999999.99
      or p_actual not between 0.01 and 999999999.99
      or p_claimed <> round(p_claimed, 2) or p_actual <> round(p_actual, 2)
      or p_path is null or p_path not like p_shop || '/' || p_uid || '/' || p_id::text || '.%'
      or p_reason is null or p_reason not in ('AMOUNT_MISMATCH', 'RECEIVER_UNCONFIRMED', 'AMOUNT_AND_RECEIVER')
      or (p_claimed <> p_actual) is distinct from (p_reason in ('AMOUNT_MISMATCH', 'AMOUNT_AND_RECEIVER')) then
    return 'INVALID_SLIP';
  end if;

  if not exists (
    select 1 from public.wallet_receiving_accounts a
    join public.shops s on s.shop_id = a.shop_id
    where a.shop_id = p_shop and a.enabled and lower(s.status) = 'active'
      and a.bank_code = p_bank and a.bank_number = p_number
      and a.auto_credit_from <= now() and p_slip_at >= a.auto_credit_from
      and p_slip_at <= now() + interval '1 minute'
  ) then return 'SLIP_NOT_VERIFIED'; end if;

  select u.* into member from public.users u
  where u.uid = p_uid and u.shop_id = p_shop and u.status = 'Active'
    and u.role in ('Admin','Superadmin','Operator','Promoter','Customer','Backer')
    and exists (
      select 1 from public.membership_applications a
      where a.line_uid = u.uid and a.shop_id = u.shop_id
        and a.member_id = u.member_id and a.state = 'Approved'
    )
  for update;
  if not found then return 'PLAYER_ACCESS_REQUIRED'; end if;

  if exists (select 1 from public.platform_billing_orders where transaction_ref = p_ref) then
    return 'DUPLICATE_SLIP';
  end if;

  -- Both wallet paths reserve the same unique transaction reference.
  insert into public.slip_verifications (
    id, shop_id, uid, storage_path, claimed_amount, slip_amount, transaction_ref,
    receiver_matched, is_duplicate, status, error_code, verified_at
  ) values (
    p_id, p_shop, p_uid, p_path, p_claimed, p_actual, p_ref,
    p_reason = 'AMOUNT_MISMATCH', false, 'ReviewRequired', p_reason, now()
  ) on conflict (transaction_ref) where transaction_ref is not null do nothing;

  if not found then
    select t.status into review_status
    from public.slip_verifications v
    join public.topup_requests t on t.wallet_slip_id = v.id
    where v.transaction_ref = p_ref and t.shop_id = p_shop and t.uid = p_uid;
    return case review_status
      when 'Pending' then 'REVIEW_ALREADY_QUEUED'
      when 'Approved' then 'ALREADY_CREDITED'
      else 'DUPLICATE_SLIP' end;
  end if;

  insert into public.topup_requests (
    shop_id, uid, member_id, display_name, type, amount, method, fee_option, status, wallet_slip_id
  ) values (
    p_shop, p_uid, member.member_id,
    regexp_replace(coalesce(nullif(member.display_name, ''), member.member_id), '[<>&"'']', ' ', 'g'),
    'ฝากเงิน', p_actual, 'โอนเงิน', 'slip_review', 'Pending', p_id
  );
  return 'REVIEW_QUEUED';
end;
$$;


-- Authenticate the DB-triggered notification without exposing the secret via the Data API.
create table public.shop_internal_webhook (
  name text primary key,
  secret text not null check (secret ~ '^[0-9a-f]{64}$'),
  endpoint text check (endpoint ~ '^https://[a-z0-9]+[.]supabase[.]co/functions/v1/notify-topup$')
);
alter table public.shop_internal_webhook enable row level security;
revoke all on public.shop_internal_webhook from public, anon, authenticated;
grant select on public.shop_internal_webhook to service_role;
insert into public.shop_internal_webhook (name,secret)
values ('notify-topup', replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-',''));

create or replace function public.handle_notify_topup()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  webhook_secret text;
  webhook_endpoint text;
begin
  if new.status is distinct from 'Pending' then return new; end if;
  select secret,endpoint into webhook_secret,webhook_endpoint from public.shop_internal_webhook where name = 'notify-topup';
  if webhook_endpoint is null then return new; end if;
  perform net.http_post(
    url := webhook_endpoint,
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || webhook_secret),
    body := jsonb_build_object('shop_id',new.shop_id,'request_id',new.id)
  );
  return new;
exception when undefined_function or invalid_schema_name then
  -- Notification delivery is asynchronous and cannot block a wallet insert.
  return new;
end;
$$;

revoke all on function public.shop_actor_role(text,text), public.set_shop_member_access(text,text,text,text,text),
  public.cancel_shop_bill(text,text,uuid,text), public.adjust_shop_balance(text,text,uuid,text,text,text,numeric),
  public.request_promoter_commission(text,text,uuid,text,numeric),
  public.reject_shop_wallet_request(text,text,text,text), public.finalize_shop_round(text,text,numeric,text),
  public.apply_shop_referral() from public, anon, authenticated;
grant execute on function public.shop_actor_role(text,text), public.set_shop_member_access(text,text,text,text,text),
  public.cancel_shop_bill(text,text,uuid,text), public.adjust_shop_balance(text,text,uuid,text,text,text,numeric),
  public.request_promoter_commission(text,text,uuid,text,numeric),
  public.reject_shop_wallet_request(text,text,text,text), public.finalize_shop_round(text,text,numeric,text)
  to service_role;
grant usage on sequence public.shop_role_audit_id_seq to service_role;
revoke all on function public.assign_canonical_member_id(), public.enqueue_membership_notification(),
  public.handle_notify_topup(), public.queue_round_notices(), public.sync_approved_player(), public.sync_member_picture(),
  public.shop_accounting_day(timestamptz) from public, anon, authenticated;
grant execute on function public.assign_canonical_member_id(), public.enqueue_membership_notification(),
  public.handle_notify_topup(), public.queue_round_notices(), public.sync_approved_player(), public.sync_member_picture(),
  public.shop_accounting_day(timestamptz) to service_role;

commit;
