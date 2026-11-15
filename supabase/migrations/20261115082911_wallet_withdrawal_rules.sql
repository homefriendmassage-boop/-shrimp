begin;

alter table public.users add column last_wallet_topup_at timestamptz;

-- Stamp the deposit within the same update as the balance, including manual top-ups.
create function shop_finance_private.stamp_wallet_topup()
returns trigger language plpgsql set search_path='' as $$
begin
  new.last_wallet_topup_at := clock_timestamp();
  return new;
end;
$$;
create trigger stamp_wallet_topup before update of total_deposit,credit_balance on public.users
for each row when (
  coalesce(new.total_deposit,0)>coalesce(old.total_deposit,0)
  and coalesce(new.credit_balance,0)>coalesce(old.credit_balance,0)
)
execute function shop_finance_private.stamp_wallet_topup();

create index withdrawal_daily_member_idx on public.topup_requests(shop_id,uid,type,created_at)
  where type in ('ถอนเงิน','ถอนโบนัส');
create index wallet_deposit_member_idx on public.transactions(shop_id,target_id,created_at desc)
  where target_type='user' and type='deposit';
create index wallet_play_after_topup_idx on public.bets(shop_id,uid,created_at)
  where play_mode='private' and status in ('Win','Lose');

create function public.check_wallet_withdrawal_rules(p_shop text,p_uid text,p_kind text,p_amount numeric)
returns text language plpgsql set search_path='' as $$
declare
  member public.users%rowtype;
  last_topup timestamptz;
  accounting_day date := public.shop_accounting_day(statement_timestamp());
  request_type text;
begin
  if p_amount is null or p_amount < 100 then return 'WALLET_MINIMUM'; end if;
  if p_amount>999999999 or mod(p_amount,100) is distinct from 0 then return 'WITHDRAWAL_WHOLE_HUNDREDS'; end if;
  if p_kind is null or p_kind not in ('cash','bonus') then return 'WITHDRAWAL_INVALID'; end if;
  select * into member from public.users where shop_id=p_shop and uid=p_uid and status='Active';
  if not found then return 'PLAYER_ACCESS_REQUIRED'; end if;

  request_type := case when p_kind='bonus' then 'ถอนโบนัส' else 'ถอนเงิน' end;
  if exists (select 1 from public.topup_requests
    where shop_id=p_shop and uid=p_uid and type=request_type
      and created_at >= ((accounting_day + time '06:00') at time zone 'Asia/Bangkok')
      and created_at < (((accounting_day+1) + time '06:00') at time zone 'Asia/Bangkok'))
  then return 'WITHDRAWAL_DAILY_LIMIT'; end if;

  if p_kind='cash' and member.role is distinct from 'Backer' then
    last_topup := member.last_wallet_topup_at;
    if last_topup is null then
      select max(created_at) into last_topup from public.transactions
      where shop_id=p_shop and target_type='user' and target_id=member.member_id and type='deposit';
    end if;
    if last_topup is not null and not exists (
      select 1 from public.bets b join public.rounds r using (shop_id,round_id)
      where b.shop_id=p_shop and b.uid=p_uid and b.created_at>=last_topup
        and b.play_mode='private' and b.cash_table is not true
        and b.status in ('Win','Lose') and r.status='Ended')
    then return 'WITHDRAWAL_PLAY_REQUIRED'; end if;
  end if;
  return 'ALLOWED';
end;
$$;

revoke all on function public.check_wallet_withdrawal_rules(text,text,text,numeric) from public,anon,authenticated;
grant execute on function public.check_wallet_withdrawal_rules(text,text,text,numeric) to service_role;

create or replace function public.guard_confirmed_wallet_withdrawal()
returns trigger language plpgsql set search_path='' as $$
declare
  rule text;
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
  if new.type in ('ถอนเงิน','ถอนโบนัส') then
    perform 1 from public.users where shop_id=new.shop_id and uid=new.uid for update;
    rule := public.check_wallet_withdrawal_rules(new.shop_id,new.uid,
      case when new.type='ถอนโบนัส' then 'bonus' else 'cash' end,new.amount);
    if rule<>'ALLOWED' then raise exception '%', rule; end if;
    new.created_at := statement_timestamp();
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
  rule text;
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
  rule := public.check_wallet_withdrawal_rules(p_shop,p_uid,draft.wallet_kind,draft.amount);
  if rule<>'ALLOWED' then return rule; end if;
  request_type := case when draft.wallet_kind='bonus' then 'ถอนโบนัส' else 'ถอนเงิน' end;
  if draft.wallet_kind='bonus' then
    required_balance := draft.amount + round(draft.amount * 0.10, 2);
    fee := 'bonus_10_percent';
  else
    required_balance := draft.amount;
    fee := 'ไม่หักค่าน้ำ';
  end if;
  if required_balance + coalesce((select sum(amount + case when request_type='ถอนโบนัส'
      then round(amount * 0.10,2) else 0 end) from public.topup_requests
      where shop_id=p_shop and uid=p_uid and type=request_type and status='Pending'),0) >
    coalesce(case when draft.wallet_kind='bonus' then member.commission_balance
      when member.role='Backer' then member.backer_wallet else member.credit_balance end,0)
    then return 'WALLET_INSUFFICIENT_BALANCE'; end if;
  begin
    insert into public.topup_requests(shop_id,uid,member_id,display_name,type,amount,method,fee_option,slip_url,status,withdrawal_confirmation_id)
      values(p_shop,p_uid,member.member_id,regexp_replace(coalesce(member.display_name,member.member_id),'[<>&"'' ]',' ','g'),
      request_type,draft.amount,'โอนเงิน',coalesce(fee,'หักค่าน้ำ'),'','Pending',p_id)
      returning id into queued;
  exception when raise_exception then
    if sqlerrm in ('WALLET_MINIMUM','WITHDRAWAL_WHOLE_HUNDREDS','WITHDRAWAL_DAILY_LIMIT','WITHDRAWAL_PLAY_REQUIRED') then
      return sqlerrm;
    end if;
    raise;
  end;
  update public.wallet_withdrawal_confirmations set request_id=queued where id=p_id;
  return 'QUEUED';
end;
$$;

commit;
