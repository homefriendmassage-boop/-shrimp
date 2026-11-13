begin;

alter table public.topup_requests
  add column withdrawal_receipt_path text,
  add column withdrawal_rejection_reason text,
  add column withdrawal_notice_key uuid;

create function public.decide_player_withdrawal(p_shop text,p_request text,p_staff text,p_receipt text,p_reason text)
returns jsonb language plpgsql set search_path = '' as $$
declare
  item public.topup_requests%rowtype;
  staff_name text;
  approved jsonb;
begin
  select display_name into staff_name from public.users
    where shop_id=p_shop and uid=p_staff and status='Active' and role in ('Admin','Superadmin','Operator');
  if not found then return jsonb_build_object('code','ADMIN_REQUIRED'); end if;

  select * into item from public.topup_requests
    where shop_id=p_shop and id::text=p_request and type='ถอนเงิน' for update;
  if not found then return jsonb_build_object('code','REQUEST_NOT_PENDING'); end if;
  if item.status='Pending' then
    if p_receipt is not null and p_reason is null then
      if p_receipt !~ ('^' || p_shop || '/withdrawal-receipts/' || p_request || '/[a-f0-9-]{36}[.](jpg|png)$')
        then return jsonb_build_object('code','WITHDRAWAL_RECEIPT_INVALID'); end if;
      approved := public.approve_wallet_withdrawal(p_shop,p_request,p_staff);
      if approved->>'code' is distinct from 'APPROVED' then return approved; end if;
      update public.topup_requests set withdrawal_receipt_path=p_receipt,withdrawal_notice_key=gen_random_uuid()
        where shop_id=p_shop and id=item.id returning * into item;
    elsif p_receipt is null and length(btrim(p_reason)) between 1 and 300 then
      update public.topup_requests set status='Rejected',admin_name=coalesce(staff_name,p_staff),
        withdrawal_rejection_reason=btrim(p_reason),withdrawal_notice_key=gen_random_uuid()
        where shop_id=p_shop and id=item.id returning * into item;
    else
      return jsonb_build_object('code','WITHDRAWAL_RECEIPT_REQUIRED');
    end if;
  elsif item.withdrawal_notice_key is null
    or (item.status='Approved' and p_reason is not null)
    or (item.status='Rejected' and p_reason is null) then
    return jsonb_build_object('code','REQUEST_NOT_PENDING');
  end if;
  return jsonb_build_object('code','DECIDED','uid',item.uid,'member_id',item.member_id,'type',item.type,
    'amount',item.amount,'status',item.status,'receipt_path',item.withdrawal_receipt_path,
    'rejection_reason',item.withdrawal_rejection_reason,'notice_key',item.withdrawal_notice_key);
end;
$$;

revoke all on function public.decide_player_withdrawal(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.decide_player_withdrawal(text,text,text,text,text) to service_role;

CREATE OR REPLACE FUNCTION public.queue_round_notices()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  notice_kind text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  notice_kind := case new.status when 'Open' then 'opened' when 'Closed' then 'closed' when 'Ended' then 'result' end;
  if notice_kind is null or (tg_op = 'INSERT' and notice_kind <> 'opened') then return new; end if;
  insert into public.round_notice_batches(round_id, shop_id, kind, batch_no, recipients)
  select new.round_id, new.shop_id, notice_kind, batch_no, array_agg(line_uid order by line_uid)
  from (
    select a.line_uid, ((row_number() over (order by a.line_uid) - 1) / 500)::int as batch_no
    from public.membership_applications a
    join public.users u on u.shop_id = a.shop_id and u.uid = a.line_uid
    cross join lateral (select public.resolve_shop_oa_recipient(a.shop_id, a.line_uid) as uid) oa
    where oa.uid is not null and a.shop_id = new.shop_id and a.state = 'Approved' and u.status = 'Active'
      and a.line_uid ~ '^U[0-9a-fA-F]{32}$'

  ) eligible
  group by batch_no
  on conflict do nothing;
  return new;
end $function$;

commit;
