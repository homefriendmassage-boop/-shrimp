create function public.guard_confirmed_wallet_withdrawal()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.type='ถอนเงิน' and not exists (
    select 1 from public.wallet_withdrawal_confirmations c
    where c.id=new.withdrawal_confirmation_id and c.shop_id=new.shop_id and c.uid=new.uid
      and c.amount=new.amount and c.request_id is null and c.expires_at>now()
  ) then
    raise exception 'WITHDRAWAL_CONFIRMATION_REQUIRED';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_confirmed_wallet_withdrawal() from public,anon,authenticated;
grant execute on function public.guard_confirmed_wallet_withdrawal() to service_role;

create trigger guard_confirmed_wallet_withdrawal
before insert on public.topup_requests for each row execute function public.guard_confirmed_wallet_withdrawal();
