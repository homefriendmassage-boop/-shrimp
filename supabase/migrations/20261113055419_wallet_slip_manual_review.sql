begin;

alter table public.topup_requests
  add column wallet_slip_id uuid unique references public.slip_verifications(id);

create or replace function public.guard_legacy_wallet_transfer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.wallet_slip_id is not null then
    if new.type is distinct from 'ฝากเงิน' or new.method is distinct from 'โอนเงิน'
        or new.status is distinct from 'Pending' or not exists (
          select 1 from public.slip_verifications v
          where v.id = new.wallet_slip_id and v.shop_id = new.shop_id and v.uid = new.uid
            and v.status = 'ReviewRequired' and v.slip_amount = new.amount
            and v.transaction_ref is not null and v.storage_path is not null
        ) then
      raise exception 'WALLET_REVIEW_INVALID';
    end if;
  elsif new.type = 'ฝากเงิน' and new.method = 'โอนเงิน' and new.status = 'Pending'
      and exists (
        select 1 from public.wallet_receiving_accounts a
        where a.shop_id = new.shop_id and a.enabled and a.auto_credit_from <= now()
      ) then
    raise exception 'WALLET_TRANSFER_REQUIRES_VERIFICATION';
  end if;
  return new;
end;
$$;

create function public.queue_verified_wallet_slip(
  p_id uuid, p_shop text, p_uid text, p_ref text, p_claimed numeric, p_actual numeric,
  p_bank text, p_number text, p_path text, p_slip_at timestamptz, p_reason text
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  member public.users%rowtype;
  review_status text;
begin
  if p_id is null or p_ref is null or length(p_ref) not between 1 and 160
      or p_claimed is null or p_actual is null or p_claimed not between 0.01 and 999999999.99
      or p_actual not between 0.01 and 999999999.99
      or p_claimed <> round(p_claimed, 2) or p_actual <> round(p_actual, 2)
      or p_path is null or p_path not like p_shop || '/' || p_uid || '/' || p_id::text || '.%'
      or p_reason is null or p_reason not in ('AMOUNT_MISMATCH', 'RECEIVER_UNCONFIRMED', 'AMOUNT_AND_RECEIVER')
      or (p_claimed <> p_actual) is distinct from (p_reason in ('AMOUNT_MISMATCH', 'AMOUNT_AND_RECEIVER')) then
    return 'INVALID_SLIP';
  end if;

  if not exists (
    select 1 from public.wallet_receiving_accounts a
    join public.shops s on s.shop_id = a.shop_id
    where a.shop_id = p_shop and a.enabled and lower(s.status) = 'active'
      and a.bank_code = p_bank and a.bank_number = p_number
      and a.auto_credit_from <= now() and p_slip_at >= a.auto_credit_from
      and p_slip_at <= now() + interval '1 minute'
  ) then return 'SLIP_NOT_VERIFIED'; end if;

  select u.* into member from public.users u
  where u.uid = p_uid and u.shop_id = p_shop and u.status = 'Active'
    and u.role is distinct from 'Backer'
    and exists (
      select 1 from public.membership_applications a
      where a.line_uid = u.uid and a.shop_id = u.shop_id
        and a.member_id = u.member_id and a.state = 'Approved'
    )
  for update;
  if not found then return 'PLAYER_ACCESS_REQUIRED'; end if;

  if exists (select 1 from public.platform_billing_orders where transaction_ref = p_ref) then
    return 'DUPLICATE_SLIP';
  end if;

  -- Both wallet paths reserve the same unique transaction reference.
  insert into public.slip_verifications (
    id, shop_id, uid, storage_path, claimed_amount, slip_amount, transaction_ref,
    receiver_matched, is_duplicate, status, error_code, verified_at
  ) values (
    p_id, p_shop, p_uid, p_path, p_claimed, p_actual, p_ref,
    p_reason = 'AMOUNT_MISMATCH', false, 'ReviewRequired', p_reason, now()
  ) on conflict (transaction_ref) where transaction_ref is not null do nothing;

  if not found then
    select t.status into review_status
    from public.slip_verifications v
    join public.topup_requests t on t.wallet_slip_id = v.id
    where v.transaction_ref = p_ref and t.shop_id = p_shop and t.uid = p_uid;
    return case review_status
      when 'Pending' then 'REVIEW_ALREADY_QUEUED'
      when 'Approved' then 'ALREADY_CREDITED'
      else 'DUPLICATE_SLIP' end;
  end if;

  insert into public.topup_requests (
    shop_id, uid, member_id, display_name, type, amount, method, fee_option, status, wallet_slip_id
  ) values (
    p_shop, p_uid, member.member_id,
    regexp_replace(coalesce(nullif(member.display_name, ''), member.member_id), '[<>&"'']', ' ', 'g'),
    'ฝากเงิน', p_actual, 'โอนเงิน', 'slip_review', 'Pending', p_id
  );
  return 'REVIEW_QUEUED';
end;
$$;

revoke all on function public.queue_verified_wallet_slip(uuid,text,text,text,numeric,numeric,text,text,text,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.queue_verified_wallet_slip(uuid,text,text,text,numeric,numeric,text,text,text,timestamptz,text)
  to service_role;

create function public.finish_wallet_slip_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.slip_verifications
  set status = case new.status when 'Approved' then 'Verified' else 'Rejected' end
  where id = new.wallet_slip_id and status = 'ReviewRequired';
  return new;
end;
$$;
revoke all on function public.finish_wallet_slip_review() from public, anon, authenticated;

create trigger finish_wallet_slip_review after update of status on public.topup_requests
for each row when (old.status = 'Pending' and new.status in ('Approved', 'Rejected') and new.wallet_slip_id is not null)
execute function public.finish_wallet_slip_review();

commit;
