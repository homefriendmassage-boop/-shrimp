begin;
do $test$
declare
  owner_uid text := 'U' || repeat('b',32);
  staff_uid text := 'U' || repeat('c',32);
  other_uid text := 'U' || repeat('d',32);
  invite uuid;
  branch uuid;
begin
  perform public.create_platform_shop('SHOP_TEST_OWNER_A','A',owner_uid,'Owner');
  perform public.create_platform_shop('SHOP_TEST_OWNER_B','B',owner_uid,'Owner');
  update public.shops set status='Active' where shop_id in ('SHOP_TEST_OWNER_A','SHOP_TEST_OWNER_B');
  insert into public.users (shop_id,uid,member_id,role,status,credit_balance)
    values ('SHOP_TEST_OWNER_A',staff_uid,'M0001','Customer','Active',15),
           ('SHOP_TEST_OWNER_B',staff_uid,'M0001','Customer','Active',80);
  insert into public.platform_shop_admin_invites (shop_id,issued_by,target_uid)
    values ('SHOP_TEST_OWNER_A',owner_uid,staff_uid) returning invite_id into invite;
  if (public.accept_shop_admin_invite(invite,other_uid)->>'code') is distinct from 'INVITE_INVALID'
     or (public.accept_shop_admin_invite(invite,staff_uid)->>'code') is distinct from 'ACCEPTED'
     or (public.accept_shop_admin_invite(invite,staff_uid)->>'code') is distinct from 'INVITE_USED' then
    raise exception 'Target binding, acceptance or replay prevention failed';
  end if;
  if not exists (select 1 from public.users where shop_id='SHOP_TEST_OWNER_A' and uid=staff_uid and role='Admin' and credit_balance=15)
     or not exists (select 1 from public.users where shop_id='SHOP_TEST_OWNER_B' and uid=staff_uid and role='Customer' and credit_balance=80) then
    raise exception 'Admin invitation changed another shop or balance';
  end if;
  insert into public.platform_shop_invites (created_by,own_branch)
    values (owner_uid,true) returning invite_id into branch;
  if (public.redeem_platform_shop_invite_with_plan(branch,'Branch',other_uid,'Other','0812345678','free')->>'code')
      is distinct from 'INVITE_INVALID'
     or (public.redeem_platform_shop_invite_with_plan(branch,'Branch',owner_uid,'Owner','0812345678','free')->>'code')
      is distinct from 'CREATED' then
    raise exception 'Branch invitation ownership check failed';
  end if;
end;
$test$;
rollback;
