create function public.approve_wallet_withdrawal(p_shop text, p_request text, p_staff text)
returns jsonb
language plpgsql
set search_path = ''
as $wallet_approve$
declare
  item public.topup_requests%rowtype;
  member public.users%rowtype;
  staff_name text;
begin
  select display_name into staff_name from public.users
    where shop_id = p_shop and uid = p_staff and status = 'Active'
      and role in ('Admin', 'Superadmin', 'Operator');
  if not found then return jsonb_build_object('code', 'ADMIN_REQUIRED'); end if;

  select * into item from public.topup_requests
    where shop_id = p_shop and id::text = p_request for update;
  if not found or item.status is distinct from 'Pending'
      or item.type is null or item.type not in ('ถอนเงิน', 'ถอนค่าคอม') then
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

  if item.type = 'ถอนเงิน' then
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

revoke all on function public.approve_wallet_withdrawal(text,text,text) from public, anon, authenticated;
grant execute on function public.approve_wallet_withdrawal(text,text,text) to service_role;
