create function public.place_player_private_bet(
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
  if not found or player.role = 'Promoter' then
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

create function public.cancel_player_private_bet(p_shop text, p_uid text, p_id uuid)
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

revoke all on function public.place_player_private_bet(text,text,text,uuid,text,numeric),
  public.cancel_player_private_bet(text,text,uuid) from public, anon, authenticated;
grant execute on function public.place_player_private_bet(text,text,text,uuid,text,numeric),
  public.cancel_player_private_bet(text,text,uuid) to service_role;
