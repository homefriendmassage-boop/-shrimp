begin;

-- Customer-facing round IDs carry their shop code. Existing round IDs stay stable.
-- Scope retry keys to the shop while retaining globally unique internal row IDs.
alter table public.transactions drop constraint transactions_cash_entry_id_key,
  add constraint transactions_shop_cash_entry_key unique (shop_id,cash_entry_id);
alter table public.wallet_withdrawal_confirmations
  drop constraint wallet_withdrawal_confirmations_delivery_key_key,
  add constraint wallet_withdrawal_confirmations_shop_delivery_key unique (shop_id,delivery_key);

-- Release with shop-payments, whose upsert targets the composite key.
-- Keep real bank transaction references globally unique to stop double credit.
alter table public.rounds add constraint rounds_shop_round_key unique (shop_id,round_id);
alter table public.bets add constraint bets_shop_round_fkey
  foreign key (shop_id,round_id) references public.rounds(shop_id,round_id);
alter table public.backer_logs add constraint backer_logs_shop_round_fkey
  foreign key (shop_id,round_id) references public.rounds(shop_id,round_id);
alter table public.round_notice_batches add constraint round_notice_batches_shop_round_fkey
  foreign key (shop_id,round_id) references public.rounds(shop_id,round_id) on delete cascade;
create or replace function public.record_cash_table_payment(
  p_shop text, p_table text, p_id uuid, p_type text, p_amount numeric, p_staff text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  desk public.tables%rowtype;
  prior public.transactions%rowtype;
  balance numeric;
begin
  if p_id is null or p_type is null or p_type not in ('deposit','withdraw')
    or p_amount is null or p_amount not between 0.01 and 999999999 or p_amount <> round(p_amount,2) then
    return jsonb_build_object('code','AMOUNT_INVALID');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_shop || p_id::text,0));
  select * into desk from public.tables where shop_id = p_shop and table_no = p_table for update;
  if not found or desk.cash_limit is null then return jsonb_build_object('code','CASH_TABLE_REQUIRED'); end if;
  select * into prior from public.transactions where shop_id = p_shop and cash_entry_id = p_id;
  if found then
    if prior.shop_id = p_shop and prior.cash_table_no = p_table and prior.type = p_type and prior.amount = p_amount then
      return jsonb_build_object('code','RECORDED','balance',desk.credit);
    end if;
    return jsonb_build_object('code','AMOUNT_INVALID');
  end if;
  if exists (select 1 from public.bets where shop_id = p_shop and table_no = p_table and cash_table and status = 'Active') then
    return jsonb_build_object('code','CASH_TABLE_WAITING_RESULT');
  end if;
  balance := coalesce(desk.credit,0);
  if (p_type = 'deposit' and p_amount > -balance) or (p_type = 'withdraw' and p_amount > balance) then
    return jsonb_build_object('code','CASH_AMOUNT_EXCEEDS_BALANCE');
  end if;
  balance := balance + case when p_type = 'deposit' then p_amount else -p_amount end;
  update public.tables set credit = balance where id = desk.id;
  insert into public.transactions (shop_id,target_id,type,amount,admin_name,target_type,cash_table_no,cash_entry_id)
    values (p_shop,'โต๊ะ ' || p_table,p_type,p_amount,p_staff,'table',p_table,p_id);
  return jsonb_build_object('code','RECORDED','balance',balance);
end;
$$;


commit;
