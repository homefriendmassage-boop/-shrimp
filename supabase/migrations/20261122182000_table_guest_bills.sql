alter table public.tables
  add column parent_table_no text,
  add column guest_bill_closed boolean not null default false,
  add column qr_generation uuid,
  add column guest_uid text,
  add column guest_scan_day date,
  add constraint guest_bill_closed_state check (not guest_bill_closed or (not is_open and is_hidden)),
  add constraint guest_bill_parent_fk foreign key (shop_id,parent_table_no)
    references public.tables(shop_id,table_no);

create index tables_guest_parent_idx on public.tables (shop_id, parent_table_no) where parent_table_no is not null;
create unique index tables_open_guest_uid_idx on public.tables (shop_id, parent_table_no, guest_uid)
  where parent_table_no is not null and not guest_bill_closed and guest_uid is not null;
create sequence shop_finance_private.guest_bill_number minvalue 90000000 maxvalue 99999999;
grant usage on sequence shop_finance_private.guest_bill_number to service_role;

create table shop_finance_private.table_guest_scans (
  shop_id text not null,
  table_no text not null,
  day date not null,
  uid text not null,
  generation uuid,
  display_name text not null,
  picture text,
  primary key (shop_id, table_no, day, uid)
);
alter table shop_finance_private.table_guest_scans enable row level security;
revoke all on shop_finance_private.table_guest_scans from public, anon, authenticated;
grant select, insert, update, delete on shop_finance_private.table_guest_scans to service_role;

create function public.cash_table_guest_scan(
  p_shop text, p_table text, p_day date, p_generation uuid, p_uid text, p_name text, p_picture text
) returns jsonb language plpgsql set search_path = '' as $$
declare
  desk public.tables%rowtype;
  bill_no text;
  has_bills boolean;
  eligible boolean;
begin
  select * into desk from public.tables where shop_id = p_shop and table_no = p_table
    and parent_table_no is null for share;
  if not found or desk.qr_generation is distinct from p_generation
    or p_day is distinct from public.shop_accounting_day(clock_timestamp()) then
    return jsonb_build_object('code','TABLE_QR_INVALID');
  end if;
  if not desk.is_open or desk.is_hidden or desk.cash_limit is null then
    return jsonb_build_object('code','TABLE_CLOSED');
  end if;
  -- A released customer must be assigned to another bill by staff, even on the same QR.
  select exists (select from public.tables where shop_id=p_shop and parent_table_no=p_table
    and guest_uid=p_uid and guest_bill_closed and guest_scan_day=p_day
    and qr_generation is not distinct from desk.qr_generation) into eligible;
  if p_name is not null then
  insert into shop_finance_private.table_guest_scans(shop_id,table_no,day,uid,generation,display_name,picture)
  values(p_shop,p_table,p_day,p_uid,p_generation,left(coalesce(nullif(p_name,''),'สมาชิก LINE'),120),p_picture)
  on conflict (shop_id,table_no,day,uid) do nothing;
  end if;
  select table_no into bill_no from public.tables where shop_id=p_shop and parent_table_no=p_table
    and guest_uid=p_uid and not guest_bill_closed;
  select exists (select from public.tables where shop_id=p_shop and parent_table_no=p_table
    and not guest_bill_closed) into has_bills;
  return jsonb_build_object('code','OK','bill',coalesce(bill_no,case when not has_bills and not eligible then p_table end));
end;
$$;

create function public.manage_cash_table_guests(
  p_shop text, p_actor text, p_table text, p_action text, p_bill text, p_name text, p_guest text, p_expected uuid
) returns jsonb language plpgsql set search_path = '' as $$
declare
  desk public.tables%rowtype;
  bill public.tables%rowtype;
  incoming shop_finance_private.table_guest_scans%rowtype;
  next_no text;
  day_now date := public.shop_accounting_day(clock_timestamp());
begin
  if not exists (select from public.users u join public.shops s using(shop_id)
    where u.shop_id=p_shop and u.uid=p_actor and u.status='Active'
    and u.role in ('Admin','Superadmin','Cashier','Operator') and lower(s.status)='active')
  then return jsonb_build_object('code','ADMIN_REQUIRED'); end if;
  select * into desk from public.tables where shop_id=p_shop and table_no=p_table
    and parent_table_no is null for update;
  if not found or desk.cash_limit is null or desk.is_hidden then return jsonb_build_object('code','CASH_TABLE_REQUIRED'); end if;

  if p_action='list' then
    return jsonb_build_object('code','OK','generation',desk.qr_generation,'scans',coalesce((
      select jsonb_agg(jsonb_build_object('uid',s.uid,'name',s.display_name,'picture',s.picture) order by s.display_name,s.uid)
      from shop_finance_private.table_guest_scans s
      where s.shop_id=p_shop and s.table_no=p_table and s.day=day_now and s.generation is not distinct from desk.qr_generation
      and not exists (select from public.tables b where b.shop_id=p_shop and b.parent_table_no=p_table
        and not b.guest_bill_closed and b.guest_uid=s.uid)
    ),'[]'::jsonb));
  end if;
  if desk.qr_generation is distinct from p_expected then return jsonb_build_object('code','TABLE_QR_INVALID'); end if;
  if p_action='rotate' then
    if coalesce(desk.credit,0)<>0 or exists (select from public.tables
      where shop_id=p_shop and parent_table_no=p_table and not guest_bill_closed)
      or exists (select from public.bets where shop_id=p_shop and table_no=p_table and cash_table and status='Active')
    then return jsonb_build_object('code','GUEST_BILLS_UNSETTLED'); end if;
    delete from shop_finance_private.table_guest_scans where shop_id=p_shop and table_no=p_table;
    update public.tables set qr_generation=gen_random_uuid() where id=desk.id;
    return jsonb_build_object('code','OK');
  end if;

  if p_action in ('edit','close') then
    select * into bill from public.tables where shop_id=p_shop and parent_table_no=p_table
      and table_no=p_bill and not guest_bill_closed for update;
    if not found then return jsonb_build_object('code','GUEST_BILL_NOT_FOUND'); end if;
  end if;
  if p_action='close' then
    if coalesce(bill.credit,0)<>0 or exists (select from public.bets where shop_id=p_shop
      and table_no=p_bill and cash_table and status='Active')
    then return jsonb_build_object('code','GUEST_BILLS_UNSETTLED'); end if;
    update public.tables set guest_bill_closed=true,is_open=false,is_hidden=true,
      guest_scan_day=day_now,qr_generation=desk.qr_generation where id=bill.id;
    delete from shop_finance_private.table_guest_scans where shop_id=p_shop and table_no=p_table and uid=bill.guest_uid;
    return jsonb_build_object('code','OK');
  end if;
  if p_action not in ('add','edit') or p_name is null or char_length(btrim(p_name)) not between 1 and 40
    then return jsonb_build_object('code','GUEST_NAME_INVALID'); end if;
  if exists (select from public.tables where shop_id=p_shop and parent_table_no=p_table
    and not guest_bill_closed and id is distinct from bill.id
    and lower(table_name)=lower(btrim(p_name))) then return jsonb_build_object('code','GUEST_NAME_DUPLICATE'); end if;
  if p_action='add' and (coalesce(desk.credit,0)<>0 or exists (
    select from public.bets where shop_id=p_shop and table_no=p_table and cash_table and status='Active'))
  then return jsonb_build_object('code','GUEST_BILLS_UNSETTLED'); end if;
  if p_guest is not null and p_guest is distinct from bill.guest_uid then
    select * into incoming from shop_finance_private.table_guest_scans
      where shop_id=p_shop and table_no=p_table and day=day_now and uid=p_guest
      and generation is not distinct from desk.qr_generation;
    if not found or exists (select from public.tables where shop_id=p_shop and parent_table_no=p_table
      and not guest_bill_closed and guest_uid=p_guest) then return jsonb_build_object('code','GUEST_SCAN_NOT_FOUND'); end if;
    if bill.guest_uid is not null then return jsonb_build_object('code','GUEST_ALREADY_LINKED'); end if;
  end if;
  if p_action='edit' then
    update public.tables set table_name=btrim(p_name), guest_uid=coalesce(p_guest,guest_uid) where id=bill.id;
    return jsonb_build_object('code','OK','bill',p_bill);
  end if;
  loop
    next_no := nextval('shop_finance_private.guest_bill_number')::text;
    exit when not exists (select from public.tables where shop_id=p_shop and table_no=next_no);
  end loop;
  insert into public.tables(shop_id,table_no,table_name,parent_table_no,guest_uid,credit,cash_limit,is_open,is_hidden)
  values(p_shop,next_no,btrim(p_name),p_table,p_guest,0,desk.cash_limit,true,false);
  return jsonb_build_object('code','OK','bill',next_no);
end;
$$;

create function public.place_guest_cash_table_bet(
  p_shop text, p_uid text, p_round text, p_id uuid, p_type text, p_amount numeric,
  p_table text, p_day date, p_staff boolean, p_generation uuid
) returns jsonb language plpgsql set search_path = '' as $$
declare
  desk public.tables%rowtype;
  bill public.tables%rowtype;
  target text := p_table;
  prior public.bets%rowtype;
begin
  -- Existing placement locks the latest round first. Keep the same order when
  -- also locking the physical table, so rotation and writes cannot interleave.
  perform 1 from public.rounds where shop_id=p_shop
    order by created_at desc nulls last,round_id desc limit 1 for update;
  select * into desk from public.tables where shop_id=p_shop and table_no=coalesce(
    (select parent_table_no from public.tables where shop_id=p_shop and table_no=p_table),p_table)
    for update;
  if not found or not desk.is_open or desk.is_hidden or desk.cash_limit is null then
    return jsonb_build_object('code','TABLE_CLOSED');
  end if;
  if p_staff then
    select * into bill from public.tables where shop_id=p_shop and table_no=p_table;
    if bill.guest_bill_closed then return jsonb_build_object('code','GUEST_BILL_NOT_FOUND'); end if;
  else
    if desk.table_no<>p_table or desk.qr_generation is distinct from p_generation
      then return jsonb_build_object('code','TABLE_QR_INVALID'); end if;
    select table_no into target from public.tables where shop_id=p_shop and parent_table_no=p_table
      and guest_uid=p_uid and not guest_bill_closed;
    target := coalesce(target,p_table);
  end if;
  select * into prior from public.bets where bet_id=p_id;
  if found and prior.shop_id=p_shop and prior.uid=p_uid and prior.round_id=p_round
    and prior.amount=p_amount and prior.bet_type=p_type and prior.cash_table and prior.table_no=target
    then return jsonb_build_object('code','PLACED','bet_id',p_id); end if;
  if target=desk.table_no and (exists (select from public.tables where shop_id=p_shop
      and parent_table_no=desk.table_no and not guest_bill_closed)
    or (not p_staff and exists (select from public.tables where shop_id=p_shop and parent_table_no=desk.table_no
      and guest_uid=p_uid and guest_bill_closed and guest_scan_day=p_day
    and qr_generation is not distinct from desk.qr_generation)))
    then return jsonb_build_object('code','GUEST_BILL_REQUIRED'); end if;
  return public.place_player_cash_table_bet(p_shop,p_uid,p_round,p_id,p_type,p_amount,target,p_day,p_staff);
end;
$$;

revoke all on function public.cash_table_guest_scan(text,text,date,uuid,text,text,text),
  public.manage_cash_table_guests(text,text,text,text,text,text,text,uuid),
  public.place_guest_cash_table_bet(text,text,text,uuid,text,numeric,text,date,boolean,uuid) from public,anon,authenticated;
grant execute on function public.cash_table_guest_scan(text,text,date,uuid,text,text,text),
  public.manage_cash_table_guests(text,text,text,text,text,text,text,uuid),
  public.place_guest_cash_table_bet(text,text,text,uuid,text,numeric,text,date,boolean,uuid) to service_role;

-- The add-after-close correction also writes cash bets. Apply the same
-- main-bill rule at insertion so a stale staff screen cannot bypass it.
create function shop_finance_private.require_cash_guest_bill()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.cash_table and exists (select from public.tables where shop_id=new.shop_id
    and parent_table_no=new.table_no and not guest_bill_closed) then
    raise exception 'GUEST_BILL_REQUIRED';
  end if;
  return new;
end;
$$;
create trigger require_cash_guest_bill before insert on public.bets
  for each row execute function shop_finance_private.require_cash_guest_bill();

create or replace function public.cash_table_daily_report(p_shop text,p_day date)
returns jsonb language sql stable set search_path = '' as $$
  with report_window as (
    select (p_day + time '06:00') at time zone 'Asia/Bangkok' as start_at,
           (p_day + 1 + time '06:00') at time zone 'Asia/Bangkok' as end_at
  ), bills as (
    select b.table_no, coalesce(sum(b.amount) filter (where b.status <> 'Cancelled'),0) as played,
      coalesce(sum(b.payout) filter (where b.status = 'Win'),0) as won,
      coalesce(sum(b.amount) filter (where b.status = 'Cancelled'),0) as cancelled,
      count(*) filter (where b.status = 'Active') as pending
    from public.bets b cross join report_window w
    where b.shop_id = p_shop and b.cash_table and b.created_at >= w.start_at and b.created_at < w.end_at
    group by b.table_no
  ), cash as (
    select t.cash_table_no as table_no, coalesce(sum(t.amount) filter (where t.type = 'deposit'),0) as received,
      coalesce(sum(t.amount) filter (where t.type = 'withdraw'),0) as paid
    from public.transactions t cross join report_window w
    where t.shop_id = p_shop and t.cash_table_no is not null and t.created_at >= w.start_at and t.created_at < w.end_at
    group by t.cash_table_no
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'table_no',ledger.table_no,'table_name',t.table_name,'parent_table_no',t.parent_table_no,'parent_table_name',parent.table_name,'played',coalesce(played,0),'won',coalesce(won,0),'cancelled',coalesce(cancelled,0),
    'pending',coalesce(pending,0),'received',coalesce(received,0),'paid',coalesce(paid,0)
  ) order by ledger.table_no),'[]'::jsonb)
  from (select * from bills full join cash using (table_no)) ledger
  left join public.tables t on t.shop_id=p_shop and t.table_no=ledger.table_no
  left join public.tables parent on parent.shop_id=p_shop and parent.table_no=t.parent_table_no;
$$;
