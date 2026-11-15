begin;

create function public.wallet_withdrawal_eligibility(
  p_shop text,p_uid text,p_kind text,p_amount numeric,p_at timestamptz default clock_timestamp()
)
returns text language plpgsql set search_path='' as $$
declare
  request_type text;
  day_start timestamptz;
  last_topup timestamptz;
begin
  if p_kind is null or p_kind not in ('cash','bonus') or p_amount is null
    or p_amount::text in ('NaN','Infinity','-Infinity') then
    return 'WITHDRAWAL_INVALID';
  end if;
  if p_amount < 100 then return 'WALLET_MINIMUM'; end if;
  if mod(p_amount,100) <> 0 then return 'WITHDRAWAL_WHOLE_HUNDREDS'; end if;

  request_type := case when p_kind='bonus' then 'ถอนโบนัส' else 'ถอนเงิน' end;
  day_start := (public.shop_accounting_day(p_at) + time '06:00') at time zone 'Asia/Bangkok';
  if exists (
    select 1 from public.topup_requests
    where shop_id=p_shop and uid=p_uid and type=request_type
      and created_at >= day_start and created_at < day_start + interval '24 hours'
  ) then
    return 'WITHDRAWAL_DAILY_LIMIT';
  end if;

  if p_kind='cash' then
    select max(t.created_at) into last_topup
    from public.users u
    join public.transactions t on t.shop_id=u.shop_id and t.target_id=u.member_id
    where u.shop_id=p_shop and u.uid=p_uid
      and t.type='deposit' and t.target_type='user' and t.cash_table_no is null and t.amount>0;

    if last_topup is not null and not exists (
      select 1 from public.bets b
      join public.rounds r on r.shop_id=b.shop_id and r.round_id=b.round_id
      where b.shop_id=p_shop and b.uid=p_uid and b.play_mode='private'
        and b.created_at > last_topup and b.amount>0
        and b.status in ('Win','Lose') and r.status='Ended'
    ) then
      return 'WITHDRAWAL_PLAY_REQUIRED';
    end if;
  end if;
  return 'ELIGIBLE';
end;
$$;

revoke all on function public.wallet_withdrawal_eligibility(text,text,text,numeric,timestamptz) from public,anon,authenticated;
grant execute on function public.wallet_withdrawal_eligibility(text,text,text,numeric,timestamptz) to service_role;

create or replace function public.confirm_wallet_withdrawal(p_shop text,p_uid text,p_id uuid)
returns text language plpgsql set search_path='' as $$
declare
  draft public.wallet_withdrawal_confirmations%rowtype;
  member public.users%rowtype;
  fee text;
  queued integer;
  request_type text;
  required_balance numeric;
  requested_at timestamptz;
  eligibility text;
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
  -- Take the timestamp after locking the member so both concurrent confirmations
  -- and requests waiting across the accounting-day boundary use the correct day.
  requested_at := clock_timestamp();
  eligibility := public.wallet_withdrawal_eligibility(p_shop,p_uid,draft.wallet_kind,draft.amount,requested_at);
  if eligibility <> 'ELIGIBLE' then return eligibility; end if;
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
  insert into public.topup_requests(shop_id,uid,member_id,display_name,type,amount,method,fee_option,slip_url,status,withdrawal_confirmation_id,created_at)
    values(p_shop,p_uid,member.member_id,regexp_replace(coalesce(member.display_name,member.member_id),'[<>&"'' ]',' ','g'),
    request_type,draft.amount,'โอนเงิน',coalesce(fee,'หักค่าน้ำ'),'','Pending',p_id,requested_at)
    returning id into queued;
  update public.wallet_withdrawal_confirmations set request_id=queued where id=p_id;
  return 'QUEUED';
end;
$$;

commit;
