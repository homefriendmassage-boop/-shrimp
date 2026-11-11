-- Run in a test database after applying the shop migration. Test rows roll back.
begin;

do $test$
declare
  shop_a text := 'SHOP_TEST_A_' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  shop_b text := 'SHOP_TEST_B_' || left(replace(gen_random_uuid()::text, '-', ''), 12);
  owner_uid text := 'U' || replace(gen_random_uuid()::text, '-', '');
  member_uid text := 'U' || replace(gen_random_uuid()::text, '-', '');
  deposit_id text;
  result jsonb;
  balance_a numeric;
  balance_b numeric;
begin
  if public.create_platform_shop(shop_a, 'Test shop A', owner_uid, 'Test owner') <> 'CREATED'
      or public.create_platform_shop(shop_b, 'Test shop B', owner_uid, 'Test owner') <> 'CREATED' then
    raise exception 'Could not provision two shops for the same LINE owner';
  end if;

  if public.create_platform_shop(shop_a, 'Duplicate', owner_uid, 'Test owner') <> 'SHOP_EXISTS' then
    raise exception 'Duplicate shop code was accepted';
  end if;

  update public.users set credit_balance = 10 where shop_id = shop_a and uid = owner_uid;
  update public.users set credit_balance = 20 where shop_id = shop_b and uid = owner_uid;

  insert into public.topup_requests (shop_id, uid, member_id, type, method, amount, status)
    values (shop_a, owner_uid, 'M0000', 'ฝากเงิน', 'เงินสด', 100, 'Pending')
    returning id::text into deposit_id;

  result := public.approve_wallet_deposit(shop_b, deposit_id, owner_uid);
  if result->>'code' is distinct from 'REQUEST_NOT_PENDING' then
    raise exception 'Shop B could access the deposit from Shop A';
  end if;

  result := public.approve_wallet_deposit(shop_a, deposit_id, owner_uid);
  if result->>'code' is distinct from 'APPROVED' then
    raise exception 'Shop A deposit failed: %', result->>'code';
  end if;

  select credit_balance into balance_a from public.users where shop_id = shop_a and uid = owner_uid;
  select credit_balance into balance_b from public.users where shop_id = shop_b and uid = owner_uid;
  if balance_a is distinct from 110 or balance_b is distinct from 20 then
    raise exception 'Wallet balances were not isolated: A %, B %', balance_a, balance_b;
  end if;

  if (select count(*) from public.transactions
      where shop_id = shop_a and target_id = 'M0000' and type = 'deposit' and amount = 100) <> 1
      or exists (select 1 from public.transactions where shop_id = shop_b and type = 'deposit') then
    raise exception 'Deposit ledger was not isolated';
  end if;

  insert into public.users (shop_id, uid, member_id, role, status)
    values (shop_a, member_uid, 'M0001', 'Customer', 'Active');
  begin
    insert into public.topup_requests (shop_id, uid, member_id, type, method, amount, status)
      values (shop_b, member_uid, 'M0001', 'ฝากเงิน', 'เงินสด', 1, 'Pending');
    raise exception 'Database accepted a member reference from another shop';
  exception
    when foreign_key_violation then null;
  end;
end;
$test$;

rollback;
