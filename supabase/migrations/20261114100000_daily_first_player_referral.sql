begin;

create table shop_finance_private.player_referral_days (
  shop_id text not null,
  player_uid text not null,
  business_day date not null,
  referrer_uid text not null,
  claimed_at timestamptz not null,
  primary key (shop_id, player_uid, business_day),
  check (player_uid <> referrer_uid)
);
alter table shop_finance_private.player_referral_days enable row level security;

create function public.claim_daily_player_referral(p_shop text, p_player text, p_member text)
returns void language sql security definer set search_path = '' as $$
  insert into shop_finance_private.player_referral_days
    (shop_id, player_uid, business_day, referrer_uid, claimed_at)
  select p_shop, p_player,
    ((statement_timestamp() at time zone 'Asia/Bangkok') - interval '6 hours')::date,
    promoter.uid, statement_timestamp()
  from public.users promoter
  join public.shops shop on shop.shop_id = promoter.shop_id and lower(shop.status) = 'active'
  where promoter.shop_id = p_shop and promoter.member_id = p_member
    and promoter.uid <> p_player and promoter.role = 'Promoter' and promoter.status = 'Active'
  on conflict (shop_id, player_uid, business_day) do nothing;
$$;
revoke all on function public.claim_daily_player_referral(text,text,text) from public, anon, authenticated;
grant execute on function public.claim_daily_player_referral(text,text,text) to service_role;

-- Existing bills retain their original settlement rule. Every new private bill
-- records the referral present when it was accepted, including an empty referral.
alter table public.bets
  add column daily_referral_recorded boolean not null default false,
  add column daily_referrer_uid text;

create function shop_finance_private.snapshot_bill_referral()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.daily_referral_recorded := true;
  select claim.referrer_uid into new.daily_referrer_uid
  from shop_finance_private.player_referral_days claim
  where claim.shop_id = new.shop_id and claim.player_uid = new.uid
    and claim.business_day = ((new.created_at at time zone 'Asia/Bangkok') - interval '6 hours')::date
    and claim.claimed_at <= new.created_at;
  return new;
end $$;
revoke all on function shop_finance_private.snapshot_bill_referral() from public, anon, authenticated, service_role;

create trigger snapshot_private_bill_referral before insert on public.bets
for each row when (new.play_mode = 'private' and not coalesce(new.cash_table, false))
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

commit;
