begin;

alter table public.bets add column player_scanned_table boolean not null default false;

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
  insert into public.bets (bet_id,shop_id,round_id,uid,table_no,bet_type,amount,status,play_mode,payout,cash_table,player_scanned_table)
    values (p_id,p_shop,p_round,p_uid,p_table,p_type,p_amount,'Active','table',0,true,not p_staff);
  update public.tables set credit = coalesce(credit,0) - p_amount where id = desk.id;
  return jsonb_build_object('code','PLACED','bet_id',p_id);
end;
$$;

drop trigger snapshot_private_bill_referral on public.bets;
create trigger snapshot_bill_referral before insert on public.bets
for each row when (
  (new.play_mode = 'private' and not coalesce(new.cash_table, false)) or new.player_scanned_table
)
execute function shop_finance_private.snapshot_bill_referral();

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
        and ((b.play_mode = 'private' and not coalesce(b.cash_table, false)) or b.player_scanned_table) and b.payout > 0
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


commit;
