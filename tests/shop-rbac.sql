-- Apply the migration chain to a disposable database, then run this file.
begin;
do $test$
declare
  shop_a constant text := 'SHOP_RBAC_TEST_A';
  shop_b constant text := 'SHOP_RBAC_TEST_B';
  owner_a constant text := 'U00000000000000000000000000000001';
  owner_b constant text := 'U00000000000000000000000000000002';
  staff constant text := 'U00000000000000000000000000000003';
  customer constant text := 'U00000000000000000000000000000004';
  promoter constant text := 'U00000000000000000000000000000005';
  operator constant text := 'U00000000000000000000000000000006';
  backer constant text := 'U00000000000000000000000000000007';
  balance_id uuid := gen_random_uuid();
  receipt_id uuid := gen_random_uuid();
  commission_id uuid := gen_random_uuid();
  bill_id uuid := gen_random_uuid();
  settled_bill_id uuid := gen_random_uuid();
  ordinary text;
  unusual text;
  claim_id uuid := gen_random_uuid();
  before_change jsonb;
begin
  insert into public.shops(shop_id,shop_name,status) values (shop_a,'A','active'),(shop_b,'B','active');
  insert into public.users(shop_id,uid,member_id,display_name,role,status,credit_balance,total_deposit,commission_balance)
    values (shop_a,owner_a,'M0000','Owner A','Admin','Active',10,10,0),
      (shop_b,owner_b,'M0000','Owner B','Admin','Active',20,20,0),
      (shop_a,staff,'M0001','Cashier A','Cashier','Active',100,100,12),
      (shop_b,staff,'M0001','Customer B','Customer','Active',200,200,22),
      (shop_a,customer,'M0002','Customer','Customer','Active',100,100,0),
      (shop_a,promoter,'M0003','Promoter','Promoter','Active',100,100,50),
      (shop_a,operator,'M0004','Operator','Operator','Active',100,100,0),
      (shop_a,backer,'M0005','Backer','Backer','Active',0,0,0);
  update public.users set backer_wallet=200,backer_share=100 where shop_id=shop_a and uid=backer;

  if has_table_privilege('anon','public.users','SELECT') or has_table_privilege('authenticated','public.users','UPDATE') then raise exception 'Data API still permits a direct users operation'; end if;
  if has_function_privilege('authenticated','public.set_shop_member_access(text,text,text,text,text)','EXECUTE') then raise exception 'Data API still permits a direct users operation'; end if;
  if has_function_privilege('anon','public.adjust_shop_balance(text,text,uuid,text,text,text,numeric)','EXECUTE') then raise exception 'Data API still permits a direct users operation'; end if;
  if public.shop_actor_role(shop_a,staff) is distinct from 'Cashier' or
     public.shop_actor_role(shop_b,staff) is distinct from 'Customer' then raise exception 'Role leaked across shops'; end if;
  if public.set_shop_member_access(shop_b,owner_a,staff,'Admin',null) <> 'ADMIN_REQUIRED' then raise exception 'Unsafe role change permitted'; end if;
  if public.set_shop_member_access(shop_a,staff,customer,'Admin',null) <> 'ADMIN_REQUIRED' then raise exception 'Unsafe role change permitted'; end if;
  if public.set_shop_member_access(shop_a,owner_a,owner_a,'Cashier',null) <> 'LAST_SHOP_ADMIN' then raise exception 'Unsafe role change permitted'; end if;
  select to_jsonb(u)-'role'-'status' into before_change from public.users u where shop_id=shop_a and uid=staff;
  if public.set_shop_member_access(shop_a,owner_a,staff,'Operator','Inactive') <> 'SAVED' then raise exception 'Role change or revocation failed'; end if;
  if public.shop_actor_role(shop_a,staff) is not null then raise exception 'Role change or revocation failed'; end if;
  if public.set_shop_member_access(shop_a,owner_a,staff,'Cashier','Active') <> 'SAVED' then raise exception 'Role change or revocation failed'; end if;
  if before_change is distinct from (select to_jsonb(u)-'role'-'status' from public.users u where shop_id=shop_a and uid=staff) then raise exception 'Role changes modified member/wallet data or lost audit history'; end if;
  if (select count(*) from public.shop_role_audit where shop_id=shop_a and uid=staff and actor_uid=owner_a) <> 2 then raise exception 'Role changes modified member/wallet data or lost audit history'; end if;

  if public.adjust_shop_balance(shop_a,staff,balance_id,'M0002','user','deposit',10)->>'code' <> 'ADMIN_REQUIRED' then raise exception 'Wallet adjustment lost authorization, audit or idempotency'; end if;
  if public.adjust_shop_balance(shop_a,operator,balance_id,'M0002','user','deposit',10)->>'code' <> 'ADMIN_REQUIRED' then raise exception 'Wallet adjustment lost authorization, audit or idempotency'; end if;
  if public.adjust_shop_balance(shop_a,owner_a,balance_id,'M0002','user','deposit',10)->>'code' <> 'RECORDED' then raise exception 'Wallet adjustment lost authorization, audit or idempotency'; end if;
  if public.adjust_shop_balance(shop_a,owner_a,balance_id,'M0002','user','deposit',10)->>'code' <> 'RECORDED' then raise exception 'Wallet adjustment lost authorization, audit or idempotency'; end if;
  if public.adjust_shop_balance(shop_a,owner_a,balance_id,'M0002','user','deposit',11)->>'code' <> 'REQUEST_CONFLICT' then raise exception 'Wallet adjustment lost authorization, audit or idempotency'; end if;
  if (select credit_balance from public.users where shop_id=shop_a and uid=customer) <> 110 then raise exception 'Wallet adjustment lost authorization, audit or idempotency'; end if;

  insert into public.tables(shop_id,table_no,credit,cash_limit) values (shop_a,'1',-40,100);
  if public.record_cash_table_payment(shop_a,'1',receipt_id,'withdraw',10,operator)->>'code' <> 'ADMIN_REQUIRED' then raise exception 'Operator table receipts were not guarded'; end if;
  if public.record_cash_table_payment(shop_a,'1',receipt_id,'deposit',50,operator)->>'code' <> 'CASH_AMOUNT_EXCEEDS_BALANCE' then raise exception 'Operator table receipts were not guarded'; end if;
  if public.record_cash_table_payment(shop_a,'1',receipt_id,'deposit',10,operator)->>'code' <> 'RECORDED' then raise exception 'Operator table receipts were not guarded'; end if;
  if public.record_cash_table_payment(shop_a,'1',receipt_id,'deposit',10,operator)->>'code' <> 'RECORDED' then raise exception 'Operator table receipts were not guarded'; end if;
  if (select credit from public.tables where shop_id=shop_a and table_no='1') <> -30 then raise exception 'Operator table receipts were not guarded'; end if;

  insert into public.topup_requests(shop_id,uid,member_id,display_name,type,method,amount,status)
    values (shop_a,customer,'M0002','Customer','ฝากเงิน','เงินสด',25,'Pending') returning id::text into ordinary;
  insert into public.topup_requests(shop_id,uid,member_id,display_name,type,method,amount,status)
    values (shop_a,customer,'M0002','Customer','ฝากเงิน','โอนเงิน',5,'Pending') returning id::text into unusual;
  if public.approve_wallet_deposit(shop_a,staff,staff)->>'code' <> 'REQUEST_NOT_PENDING' then raise exception 'Wallet approval access or idempotency failed'; end if;
  if public.approve_wallet_deposit(shop_a,unusual,staff)->>'code' <> 'ADMIN_REQUIRED' then raise exception 'Wallet approval access or idempotency failed'; end if;
  if public.reject_shop_wallet_request(shop_a,staff,unusual,'ตรวจรายการ')->>'code' <> 'ADMIN_REQUIRED' then raise exception 'Wallet approval access or idempotency failed'; end if;
  if public.approve_wallet_deposit(shop_a,ordinary,operator)->>'code' <> 'ADMIN_REQUIRED' then raise exception 'Wallet approval access or idempotency failed'; end if;
  if public.approve_wallet_deposit(shop_b,ordinary,owner_b)->>'code' <> 'REQUEST_NOT_PENDING' then raise exception 'Wallet approval access or idempotency failed'; end if;
  if public.approve_wallet_deposit(shop_a,ordinary,staff)->>'code' <> 'APPROVED' then raise exception 'Wallet approval access or idempotency failed'; end if;
  if public.approve_wallet_deposit(shop_a,ordinary,staff)->>'code' <> 'REQUEST_NOT_PENDING' then raise exception 'Wallet approval access or idempotency failed'; end if;
  if (select credit_balance from public.users where shop_id=shop_a and uid=customer) <> 135 then raise exception 'Wallet approval access or idempotency failed'; end if;

  insert into public.wallet_withdrawal_confirmations(id,delivery_key,shop_id,uid,amount,bank_code,bank_number)
    values(claim_id,gen_random_uuid(),shop_a,customer,10,'004','1234567890');
  insert into public.topup_requests(shop_id,uid,member_id,display_name,type,method,amount,status,withdrawal_confirmation_id)
    values (shop_a,customer,'M0002','Customer','ถอนเงิน','โอนเงิน',10,'Pending',claim_id)
    returning id::text into ordinary;
  if public.approve_wallet_withdrawal(shop_a,ordinary,staff)->>'code' <> 'APPROVED' then raise exception 'Confirmed withdrawal failed'; end if;
  if public.approve_wallet_withdrawal(shop_a,ordinary,staff)->>'code' <> 'REQUEST_NOT_PENDING' then raise exception 'Confirmed withdrawal failed'; end if;
  if (select credit_balance from public.users where shop_id=shop_a and uid=customer) <> 125 then raise exception 'Confirmed withdrawal failed'; end if;

  if public.request_promoter_commission(shop_a,customer,commission_id,'credit',10) <> 'ACCESS_DENIED' then raise exception 'Referral commission request failed'; end if;
  if public.request_promoter_commission(shop_a,promoter,commission_id,'credit',10) <> 'QUEUED' then raise exception 'Referral commission request failed'; end if;
  if public.request_promoter_commission(shop_a,promoter,commission_id,'credit',10) <> 'QUEUED' then raise exception 'Referral commission request failed'; end if;
  select id::text into ordinary from public.topup_requests where shop_id=shop_a and uid=promoter and fee_option='commission_transfer';
  if (select commission_balance from public.users where shop_id=shop_a and uid=promoter) <> 40 then raise exception 'Commission rejection was not atomic'; end if;
  if public.reject_shop_wallet_request(shop_a,owner_a,ordinary,'ขอคืนค่าคอม')->>'code' <> 'REJECTED' then raise exception 'Commission rejection was not atomic'; end if;
  if public.reject_shop_wallet_request(shop_a,owner_a,ordinary,'ขอคืนค่าคอม')->>'code' <> 'REQUEST_NOT_PENDING' then raise exception 'Commission rejection was not atomic'; end if;
  if (select commission_balance from public.users where shop_id=shop_a and uid=promoter) <> 50 then raise exception 'Commission rejection was not atomic'; end if;

  insert into public.rounds(shop_id,round_id,status,resolver_type)
    values (shop_a,'R-RBAC-CANCEL','Closed','none'),(shop_a,'R-RBAC-SETTLE','Closed','backer');
  insert into public.bets(bet_id,shop_id,round_id,uid,play_mode,table_no,bet_type,amount,status,cash_table)
    values (bill_id,shop_a,'R-RBAC-CANCEL',customer,'private','-','คู่',10,'Active',false),
      (settled_bill_id,shop_a,'R-RBAC-SETTLE',customer,'private','-','คู่',20,'Active',false);
  if public.cancel_shop_bill(shop_a,staff,bill_id,'ผิดโต๊ะ') <> 'ADMIN_REQUIRED' then raise exception 'Bill cancellation refunded the wrong amount'; end if;
  if public.cancel_shop_bill(shop_a,owner_a,bill_id,'ผิดโต๊ะ') <> 'CANCELLED' then raise exception 'Bill cancellation refunded the wrong amount'; end if;
  if public.cancel_shop_bill(shop_a,owner_a,bill_id,'ผิดโต๊ะ') <> 'CANCELLED' then raise exception 'Bill cancellation refunded the wrong amount'; end if;
  if (select credit_balance from public.users where shop_id=shop_a and uid=customer) <> 135 then raise exception 'Bill cancellation refunded the wrong amount'; end if;
  if public.finalize_shop_round(shop_a,'R-RBAC-SETTLE',22,operator) <> 'ADMIN_REQUIRED' then raise exception 'Round settlement was not atomic or did not preserve payout rules'; end if;
  if public.finalize_shop_round(shop_a,'R-RBAC-SETTLE',22,staff) <> 'ENDED' then raise exception 'Round settlement was not atomic or did not preserve payout rules'; end if;
  if public.finalize_shop_round(shop_a,'R-RBAC-SETTLE',22,staff) <> 'ENDED' then raise exception 'Round settlement was not atomic or did not preserve payout rules'; end if;
  if (select credit_balance from public.users where shop_id=shop_a and uid=customer) <> 174 then raise exception 'Round settlement was not atomic or did not preserve payout rules'; end if;
  if (select backer_wallet from public.users where shop_id=shop_a and uid=backer) <> 180 then raise exception 'Round settlement was not atomic or did not preserve payout rules'; end if;
end;
$test$;
rollback;
