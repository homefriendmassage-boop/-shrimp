begin;

alter table public.membership_applications add column referral_member_id text;

create or replace function public.sync_approved_player()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.state = 'Approved' then
    insert into public.users (uid, shop_id, member_id, display_name, role, status, referrer_uid)
    values (new.line_uid, new.shop_id, new.member_id, new.display_name, 'Customer', 'Active', coalesce(new.referral_member_id, '-'))
    on conflict (shop_id, uid) do update set member_id = excluded.member_id
      where users.member_id is null or users.member_id = excluded.member_id;
    if not found then
      raise exception 'Cannot link the approved member to an existing player account';
    end if;
  end if;
  return new;
end $$;

create table public.referral_commission_credits (
  shop_id text not null,
  bet_id uuid not null,
  round_id text not null,
  referrer_uid text not null,
  amount numeric not null check (amount > 0),
  credited_at timestamptz not null default statement_timestamp(),
  primary key (shop_id, bet_id)
);
create index referral_commission_wallet_idx on public.referral_commission_credits(shop_id, referrer_uid, credited_at desc);
create index referral_commission_daily_idx on public.referral_commission_credits(shop_id, credited_at);
alter table public.referral_commission_credits enable row level security;
revoke all on public.referral_commission_credits from public, anon, authenticated, service_role;
grant select on public.referral_commission_credits to service_role;

create schema if not exists shop_finance_private;
revoke all on schema shop_finance_private from public, anon, authenticated, service_role;

create function shop_finance_private.credit_round_referrals()
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
      join public.users promoter on promoter.shop_id = b.shop_id and promoter.member_id = player.referrer_uid
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
    update public.users set credit_balance = coalesce(credit_balance,0) + credited.total
      where shop_id = new.shop_id and uid = credited.referrer_uid
        and role = 'Promoter' and status = 'Active';
    if not found then raise exception 'REFERRAL_WALLET_UNAVAILABLE'; end if;
  end loop;
  return null;
end $$;
revoke all on function shop_finance_private.credit_round_referrals() from public, anon, authenticated, service_role;

create trigger credit_referrals_on_round_end after update of status on public.rounds
for each row when (old.status = 'Closed' and new.status = 'Ended')
execute function shop_finance_private.credit_round_referrals();

create function public.daily_referral_commission(p_shop text, p_day date)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('referral_commission',coalesce(sum(amount),0),
    'referral_bills',count(*),'referral_recipients',count(distinct referrer_uid))
  from public.referral_commission_credits
  where shop_id = p_shop
    and credited_at >= ((p_day + time '06:00') at time zone 'Asia/Bangkok')
    and credited_at < ((p_day + 1 + time '06:00') at time zone 'Asia/Bangkok');
$$;
revoke all on function public.daily_referral_commission(text,date) from public, anon, authenticated;
grant execute on function public.daily_referral_commission(text,date) to service_role;

create or replace function public.finalize_balanced_round(p_shop text, p_round text, p_weight numeric)
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
  payout_amount numeric;
begin
  if p_weight is null or p_weight <= 0 or p_weight > 1000000 then
    return 'ROUND_WEIGHT_INVALID';
  end if;
  result_side := case when mod(p_weight, 2) = 0 then 'คู่' else 'คี่' end;

  select * into item from public.rounds
  where shop_id = p_shop and round_id = p_round for update;
  if not found then return 'ROUND_NOT_FOUND'; end if;
  if item.status = 'Ended' and item.weight = p_weight and item.result = result_side then return 'ENDED'; end if;
  if item.status is distinct from 'Closed' then return 'ROUND_NOT_CLOSED'; end if;
  if item.resolver_type is distinct from 'none' then return 'ROUND_REVIEW_REQUIRED'; end if;

  select coalesce(sum(amount) filter (where bet_type = 'คู่'), 0),
    coalesce(sum(amount) filter (where bet_type = 'คี่'), 0),
    count(*) filter (where status in ('Win', 'Lose')),
    count(*) filter (where status = 'Active'), count(*)
  into total_even, total_odd, settled_count, active_count, bill_count
  from public.bets where shop_id = p_shop and round_id = p_round and status is distinct from 'Cancelled';
  if total_even <> total_odd or settled_count + active_count <> bill_count then return 'ROUND_REVIEW_REQUIRED'; end if;

  if settled_count > 0 then
    if active_count <> 0 then return 'ROUND_REVIEW_REQUIRED'; end if;
    if exists (select 1 from public.bets where shop_id = p_shop and round_id = p_round and status in ('Win','Lose')
      and status is distinct from case when bet_type = result_side then 'Win' else 'Lose' end) then
      return 'ROUND_RESULT_MISMATCH';
    end if;
    perform set_config('shop_finance.skip_referral_recovery','on',true);
    update public.rounds set status = 'Ended', weight = p_weight, result = result_side
      where shop_id = p_shop and round_id = p_round;
    perform set_config('shop_finance.skip_referral_recovery','off',true);
    return 'RECOVERED';
  end if;

  select water_margin into margin from public.system_settings where shop_id = p_shop;
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
          where shop_id = p_shop and uid = bill.uid;
        if not found then raise exception 'ROUND_PAYOUT_TARGET_MISSING'; end if;
      end if;
    end if;
    update public.bets set status = case when bill.bet_type = result_side then 'Win' else 'Lose' end, payout = payout_amount
      where shop_id = p_shop and round_id = p_round and bet_id = bill.bet_id;
  end loop;
  update public.rounds set status = 'Ended', weight = p_weight, result = result_side
    where shop_id = p_shop and round_id = p_round;
  return 'ENDED';
end;
$finalize$;

create or replace function public.daily_group_finance_report(p_shop text, p_day date)
returns jsonb language sql stable set search_path = '' as $$
  with bounds as (
    select (p_day + time '06:00') at time zone 'Asia/Bangkok' as starts,
      (p_day + 1 + time '06:00') at time zone 'Asia/Bangkok' as ends
  ), day_rounds as (
    select r.round_id,r.status,r.result from public.rounds r cross join bounds
    where r.shop_id=p_shop and r.created_at>=starts and r.created_at<ends
  ), report_bets as (
    select b.amount,b.payout,b.status,b.cash_table,
      case when b.cash_table or b.play_mode='table' then 'table'
           when b.play_mode='private' then 'online' end as channel
    from public.bets b join day_rounds r on r.round_id=b.round_id
    where b.shop_id=p_shop and (b.status in ('Active','Cancelled') or r.status='Ended')
  ), play as (
    select coalesce(sum(amount) filter (where status in ('Win','Lose')),0) as settled_stake,
      coalesce(sum(payout) filter (where status='Win'),0) as payout,
      coalesce(sum(amount) filter (where status='Cancelled'),0) as cancelled,
      count(*) filter (where status='Active') as pending,
      coalesce(sum(amount) filter (where status in ('Win','Lose') and cash_table),0) as cash_stake,
      coalesce(sum(amount) filter (where status in ('Win','Lose') and channel='online'),0) as online_stake,
      coalesce(sum(payout) filter (where status='Win' and channel='online'),0) as online_payout,
      count(*) filter (where status in ('Win','Lose') and channel='online') as online_bills,
      coalesce(sum(amount) filter (where status in ('Win','Lose') and channel='table'),0) as table_stake,
      coalesce(sum(payout) filter (where status='Win' and channel='table'),0) as table_payout,
      count(*) filter (where status in ('Win','Lose') and channel='table') as table_bills,
      count(*) filter (where status in ('Win','Lose') and channel is null) as unclassified_bills
    from report_bets
  ), backer as (
    select coalesce(sum(b.pnl_amount),0) as pnl from public.backer_logs b
    join day_rounds r on r.round_id=b.round_id
    where b.shop_id=p_shop and r.status='Ended'
  ), movements as (
    select coalesce(sum(t.amount) filter (where t.cash_table_no is not null and t.type='deposit'),0) as cash_in,
      coalesce(sum(t.amount) filter (where t.cash_table_no is not null and t.type='withdraw'),0) as cash_out,
      coalesce(sum(t.amount) filter (where t.target_type='user' and t.cash_table_no is null and t.type='deposit'),0) as credit_in,
      coalesce(sum(t.amount) filter (where t.target_type='user' and t.cash_table_no is null and t.type='withdraw'),0) as credit_out,
      coalesce(sum(t.amount) filter (where t.target_type='table' and t.cash_table_no is null and t.type='deposit'),0) as table_credit_in,
      coalesce(sum(t.amount) filter (where t.target_type='table' and t.cash_table_no is null and t.type='withdraw'),0) as table_credit_out
    from public.transactions t cross join bounds
    where t.shop_id=p_shop and t.created_at>=starts and t.created_at<ends
  ), wallet as (
    -- Include balances still owed on inactive accounts. Backer withdrawals use backer_wallet.
    select coalesce(sum(u.credit_balance),0) as customer_wallet_liability,
      statement_timestamp() as wallet_as_of
    from public.users u
    where u.shop_id=p_shop and u.role is distinct from 'Backer' and u.credit_balance>0
  ), stats as (
    select count(*) as rounds, count(*) filter (where status='Ended') as ended,
      count(*) filter (where status='Ended' and result='คู่') as even,
      count(*) filter (where status='Ended' and result='คี่') as odd
    from day_rounds
  )
  select to_jsonb(play) || to_jsonb(backer) || to_jsonb(movements) || to_jsonb(stats) || to_jsonb(wallet) || public.daily_referral_commission(p_shop,p_day)
  from play cross join backer cross join movements cross join stats cross join wallet;
$$;

revoke all on function public.daily_group_finance_report(text,date) from public,anon,authenticated;
grant execute on function public.daily_group_finance_report(text,date) to service_role;

commit;
