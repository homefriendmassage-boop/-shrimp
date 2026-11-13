begin;

alter table public.wallet_withdrawal_confirmations
  add column wallet_kind text not null default 'cash' check (wallet_kind in ('cash','bonus'));

create table shop_finance_private.bonus_withdrawals (
  shop_id text not null,
  request_id integer not null,
  amount numeric not null check (amount >= 100),
  fee numeric not null check (fee = round(amount * 0.10, 2)),
  approved_at timestamptz not null default statement_timestamp(),
  primary key (shop_id,request_id)
);
alter table shop_finance_private.bonus_withdrawals enable row level security;
grant usage on schema shop_finance_private to service_role;
grant select,insert on shop_finance_private.bonus_withdrawals to service_role;

update public.system_settings set min_bet=greatest(min_bet,100),
  max_bet=case when max_bet is not null then greatest(max_bet,min_bet,100) end
  where min_bet is null or min_bet<100 or max_bet<greatest(min_bet,100);
alter table public.system_settings alter column min_bet set default 100;
alter table public.system_settings add constraint bet_minimum_100 check (min_bet >= 100 and (max_bet is null or max_bet >= min_bet));

create function shop_finance_private.require_bill_minimum() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.amount < 100 then raise exception 'BET_MINIMUM'; end if;
  return new;
end;
$$;
create trigger require_bill_minimum before insert on public.bets
for each row execute function shop_finance_private.require_bill_minimum();

create function shop_finance_private.require_slip_minimum() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.amount < 100 then raise exception 'WALLET_MINIMUM'; end if;
  return new;
end;
$$;
create trigger require_slip_minimum before insert on public.wallet_slip_credits
for each row execute function shop_finance_private.require_slip_minimum();

create or replace function public.guard_confirmed_wallet_withdrawal()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.type in ('ฝากเงิน','ถอนเงิน','ถอนโบนัส','ถอนค่าคอม') and new.amount < 100 then
    raise exception 'WALLET_MINIMUM';
  end if;
  if new.type in ('ถอนเงิน','ถอนโบนัส') and not exists (
    select 1 from public.wallet_withdrawal_confirmations c
    where c.id=new.withdrawal_confirmation_id and c.shop_id=new.shop_id and c.uid=new.uid
      and c.wallet_kind = case when new.type='ถอนโบนัส' then 'bonus' else 'cash' end
      and c.amount=new.amount and c.request_id is null and c.expires_at>now()
  ) then
    raise exception 'WITHDRAWAL_CONFIRMATION_REQUIRED';
  end if;
  return new;
end;
$$;
create or replace function public.confirm_wallet_withdrawal(p_shop text,p_uid text,p_id uuid)
returns text language plpgsql set search_path='' as $$
declare
  draft public.wallet_withdrawal_confirmations%rowtype;
  member public.users%rowtype;
  fee text;
  queued integer;
  request_type text;
  required_balance numeric;
begin
  select * into draft from public.wallet_withdrawal_confirmations
    where id=p_id and shop_id=p_shop and uid=p_uid for update;
  if not found then return 'WITHDRAWAL_INVALID'; end if;
  if draft.request_id is not null then return 'QUEUED'; end if;
  if draft.expires_at<=now() then return 'WITHDRAWAL_EXPIRED'; end if;
  if not exists (select 1 from public.shops where shop_id=p_shop and lower(status)='active') then return 'SHOP_NOT_AVAILABLE'; end if;
  select * into member from public.users u where u.shop_id=p_shop and u.uid=p_uid and u.status='Active'
    and exists(select 1 from public.membership_applications a where a.shop_id=p_shop and a.line_uid=p_uid
      and a.member_id=u.member_id and a.state='Approved') for update;
  if not found then return 'PLAYER_ACCESS_REQUIRED'; end if;
  if draft.amount < 100 then return 'WALLET_MINIMUM'; end if;
  request_type := case when draft.wallet_kind='bonus' then 'ถอนโบนัส' else 'ถอนเงิน' end;
  if draft.wallet_kind='bonus' then
    required_balance := draft.amount + round(draft.amount * 0.10, 2);
    fee := 'bonus_10_percent';
  else
    required_balance := draft.amount;
    select case when withdrawal_fee_mode='none' then 'ไม่หักค่าน้ำ' else 'หักค่าน้ำ' end into fee
      from public.system_settings where shop_id=p_shop order by id desc limit 1;
  end if;
  if required_balance + coalesce((select sum(amount + case when request_type='ถอนโบนัส'
      then round(amount * 0.10,2) else 0 end) from public.topup_requests
      where shop_id=p_shop and uid=p_uid and type=request_type and status='Pending'),0) >
    coalesce(case when draft.wallet_kind='bonus' then member.commission_balance
      when member.role='Backer' then member.backer_wallet else member.credit_balance end,0)
    then return 'WALLET_INSUFFICIENT_BALANCE'; end if;
  insert into public.topup_requests(shop_id,uid,member_id,display_name,type,amount,method,fee_option,slip_url,status,withdrawal_confirmation_id)
    values(p_shop,p_uid,member.member_id,regexp_replace(coalesce(member.display_name,member.member_id),'[<>&"'' ]',' ','g'),
    request_type,draft.amount,'โอนเงิน',coalesce(fee,'หักค่าน้ำ'),'','Pending',p_id)
    returning id into queued;
  update public.wallet_withdrawal_confirmations set request_id=queued where id=p_id;
  return 'QUEUED';
end;
$$;

create or replace function public.approve_wallet_withdrawal(p_shop text, p_request text, p_staff text)
returns jsonb
language plpgsql
set search_path = ''
as $wallet_approve$
declare
  item public.topup_requests%rowtype;
  member public.users%rowtype;
  staff_name text;
  bonus_fee numeric;
begin
  select display_name into staff_name from public.users
    where shop_id = p_shop and uid = p_staff and status = 'Active'
      and role in ('Admin', 'Superadmin', 'Operator');
  if not found then return jsonb_build_object('code', 'ADMIN_REQUIRED'); end if;

  select * into item from public.topup_requests
    where shop_id = p_shop and id::text = p_request for update;
  if not found or item.status is distinct from 'Pending'
      or item.type is null or item.type not in ('ถอนเงิน', 'ถอนค่าคอม', 'ถอนโบนัส') then
    return jsonb_build_object('code', 'REQUEST_NOT_PENDING');
  end if;
  if item.amount is null or item.amount::text in ('NaN', 'Infinity', '-Infinity')
      or item.amount <= 0 or item.amount <> round(item.amount, 2) then
    return jsonb_build_object('code', 'INVALID_AMOUNT');
  end if;

  select * into member from public.users
    where shop_id = p_shop and uid = item.uid and member_id = item.member_id
      and status = 'Active' for update;
  if not found then return jsonb_build_object('code', 'PLAYER_ACCESS_REQUIRED'); end if;

  if item.type = 'ถอนโบนัส' then
    bonus_fee := round(item.amount * 0.10, 2);
    if item.amount < 100 or item.withdrawal_confirmation_id is null then
      return jsonb_build_object('code','INVALID_AMOUNT');
    end if;
    if coalesce(member.commission_balance,0) < item.amount + bonus_fee then
      return jsonb_build_object('code','WALLET_INSUFFICIENT_BALANCE');
    end if;
    update public.users set commission_balance = commission_balance - item.amount - bonus_fee
      where shop_id=p_shop and uid=item.uid;
    insert into shop_finance_private.bonus_withdrawals(shop_id,request_id,amount,fee)
      values(p_shop,item.id,item.amount,bonus_fee);
  elsif item.type = 'ถอนเงิน' then
    if member.role = 'Backer' then
      if coalesce(member.backer_wallet, 0) < item.amount then
        return jsonb_build_object('code', 'WALLET_INSUFFICIENT_BALANCE');
      end if;
      update public.users set backer_wallet = backer_wallet - item.amount
        where shop_id = p_shop and uid = item.uid;
    else
      if coalesce(member.credit_balance, 0) < item.amount then
        return jsonb_build_object('code', 'WALLET_INSUFFICIENT_BALANCE');
      end if;
      update public.users set credit_balance = credit_balance - item.amount
        where shop_id = p_shop and uid = item.uid;
    end if;
    insert into public.transactions (shop_id, target_id, type, amount, admin_name, target_type)
      values (p_shop, item.member_id, 'withdraw', item.amount, coalesce(staff_name, 'Admin'), 'user');
  end if;
  -- Commission withdrawals are deducted by the existing request flow.
  update public.topup_requests set status = 'Approved', admin_name = coalesce(staff_name, 'Admin')
    where id = item.id and shop_id = p_shop;

  return jsonb_build_object('code', 'APPROVED', 'uid', item.uid, 'type', item.type,
    'member_id', item.member_id, 'amount', item.amount, 'status', 'Approved');
end;
$wallet_approve$;

create or replace function shop_finance_private.credit_round_referrals()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  rate numeric;
  credited record;
begin
  if current_setting('role', true) in ('anon','authenticated') then
    raise exception 'REFERRAL_SETTLEMENT_REQUIRES_SERVICE';
  end if;
  if current_setting('shop_finance.skip_referral_recovery', true) = 'on' then return null; end if;
  select comm_rate into rate from public.system_settings where shop_id = new.shop_id;
  rate := coalesce(rate, 0.01);
  if not (rate > 0 and rate <= 1) then return null; end if;
  for credited in
    with eligible as (
      select b.bet_id, promoter.uid, round(b.amount * rate, 2) as amount
      from public.bets b
      join public.users player on player.shop_id = b.shop_id and player.uid = b.uid
      join public.users promoter on promoter.shop_id = b.shop_id and (
        (b.daily_referral_recorded and promoter.uid = b.daily_referrer_uid) or
        (not b.daily_referral_recorded and promoter.member_id = player.referrer_uid)
      )
      where b.shop_id = new.shop_id and b.round_id = new.round_id and b.status = 'Win'
        and b.play_mode = 'private' and not coalesce(b.cash_table, false) and b.payout > 0
        and promoter.uid <> player.uid and promoter.role = 'Promoter' and promoter.status = 'Active'
    ), recorded as (
      insert into public.referral_commission_credits(shop_id,bet_id,round_id,referrer_uid,amount)
      select new.shop_id,bet_id,new.round_id,uid,amount from eligible where amount > 0
      on conflict (shop_id,bet_id) do nothing returning referrer_uid,amount
    )
    select referrer_uid, sum(amount) as total from recorded group by referrer_uid order by referrer_uid
  loop
    update public.users set commission_balance = coalesce(commission_balance,0) + credited.total
      where shop_id = new.shop_id and uid = credited.referrer_uid
        and role = 'Promoter' and status = 'Active';
    if not found then raise exception 'REFERRAL_WALLET_UNAVAILABLE'; end if;
  end loop;
  return null;
end $$;


create or replace function public.daily_referral_commission(p_shop text,p_day date)
returns jsonb language sql stable set search_path='' as $$
  with bounds as (
    select ((p_day + time '06:00') at time zone 'Asia/Bangkok') as starts,
      ((p_day + 1 + time '06:00') at time zone 'Asia/Bangkok') as ends
  ), referrals as (
    select coalesce(sum(amount),0) as referral_commission,count(*) as referral_bills,
      count(distinct referrer_uid) as referral_recipients
    from public.referral_commission_credits cross join bounds
    where shop_id=p_shop and credited_at>=starts and credited_at<ends
  ), withdrawals as (
    select coalesce(sum(amount),0) as bonus_withdrawn,coalesce(sum(fee),0) as bonus_fee_revenue
    from shop_finance_private.bonus_withdrawals cross join bounds
    where shop_id=p_shop and approved_at>=starts and approved_at<ends
  ), balance as (
    select coalesce(sum(commission_balance),0) as bonus_wallet_liability from public.users
    where shop_id=p_shop and commission_balance>0
  )
  select to_jsonb(referrals)||to_jsonb(withdrawals)||to_jsonb(balance)
  from referrals cross join withdrawals cross join balance;
$$;

commit;
