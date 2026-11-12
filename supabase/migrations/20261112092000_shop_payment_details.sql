create table public.shop_payment_profiles (
  shop_id text primary key references public.shops(shop_id),
  bank_code text not null check (bank_code ~ '^[0-9]{3}$'),
  bank_number text not null check (bank_number ~ '^[0-9]{6,20}$'),
  account_name text not null,
  promptpay text not null check (promptpay ~ '^(0[0-9]{9}|[0-9]{13}|[0-9]{15})$')
);
alter table public.shop_payment_profiles enable row level security;
revoke all on public.shop_payment_profiles from public, anon, authenticated;
grant select,insert,update on public.shop_payment_profiles to service_role;
grant insert,update on public.wallet_receiving_accounts to service_role;

create function public.set_shop_payment_profile(p_shop text,p_bank text,p_number text,p_name text,p_promptpay text)
returns text language plpgsql set search_path='' as $$
begin
  if exists (select 1 from public.platform_billing_receiver
      where (verified_bank_code=p_bank and verified_bank_number=p_number) or transfer_number=p_promptpay)
    or exists (select 1 from public.shop_payment_profiles where promptpay=p_promptpay and shop_id<>p_shop)
  then return 'RECEIVER_CONFLICT'; end if;
  insert into public.wallet_receiving_accounts(shop_id,bank_code,bank_number,enabled,auto_credit_from)
    values(p_shop,p_bank,p_number,true,now())
    on conflict(bank_code,bank_number) do update
    set enabled=true,auto_credit_from=coalesce(wallet_receiving_accounts.auto_credit_from,now())
    where wallet_receiving_accounts.shop_id=p_shop;
  if not found then return 'RECEIVER_CONFLICT'; end if;
  insert into public.shop_payment_profiles values(p_shop,p_bank,p_number,p_name,p_promptpay)
    on conflict(shop_id) do update set bank_code=excluded.bank_code,bank_number=excluded.bank_number,
      account_name=excluded.account_name,promptpay=excluded.promptpay;
  return 'SAVED';
exception when unique_violation then return 'RECEIVER_CONFLICT';
end;
$$;
create unique index shop_payment_profiles_promptpay_unique on public.shop_payment_profiles(promptpay);

create table public.wallet_withdrawal_confirmations (
  id uuid primary key default gen_random_uuid(),
  delivery_key uuid not null unique,
  shop_id text not null,
  uid text not null,
  amount numeric(11,2) not null check (amount>0),
  bank_code text not null check (bank_code ~ '^[0-9]{3}$'),
  bank_number text not null check (bank_number ~ '^[0-9]{6,20}$'),
  expires_at timestamptz not null default now()+interval '30 minutes',
  request_id integer unique references public.topup_requests(id),
  foreign key (shop_id,uid) references public.users(shop_id,uid)
);
alter table public.wallet_withdrawal_confirmations enable row level security;
revoke all on public.wallet_withdrawal_confirmations from public, anon, authenticated;
grant select,insert,update on public.wallet_withdrawal_confirmations to service_role;
alter table public.topup_requests add column withdrawal_confirmation_id uuid unique
  references public.wallet_withdrawal_confirmations(id);

create function public.confirm_wallet_withdrawal(p_shop text,p_uid text,p_id uuid)
returns text language plpgsql set search_path='' as $$
declare
  draft public.wallet_withdrawal_confirmations%rowtype;
  member public.users%rowtype;
  fee text;
  queued integer;
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
  if draft.amount + coalesce((select sum(amount) from public.topup_requests
      where shop_id=p_shop and uid=p_uid and type='ถอนเงิน' and status='Pending'),0) >
      coalesce(case when member.role='Backer' then member.backer_wallet else member.credit_balance end,0)
    then return 'WALLET_INSUFFICIENT_BALANCE'; end if;
  select withdrawal_fee_mode into fee from public.system_settings where shop_id=p_shop order by id desc limit 1;
  insert into public.topup_requests(shop_id,uid,member_id,display_name,type,amount,method,fee_option,slip_url,status,withdrawal_confirmation_id)
    values(p_shop,p_uid,member.member_id,regexp_replace(coalesce(member.display_name,member.member_id),'[<>&"'' ]',' ','g'),
    'ถอนเงิน',draft.amount,'โอนเงิน',case when fee='none' then 'ไม่หักค่าน้ำ' else 'หักค่าน้ำ' end,'','Pending',p_id)
    returning id into queued;
  update public.wallet_withdrawal_confirmations set request_id=queued where id=p_id;
  return 'QUEUED';
end;
$$;

revoke all on function public.set_shop_payment_profile(text,text,text,text,text),
  public.confirm_wallet_withdrawal(text,text,uuid) from public,anon,authenticated;
grant execute on function public.set_shop_payment_profile(text,text,text,text,text),
  public.confirm_wallet_withdrawal(text,text,uuid) to service_role;
