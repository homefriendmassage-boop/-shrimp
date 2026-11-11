begin;

alter table public.bets drop constraint bets_uid_fkey;
alter table public.topup_requests drop constraint topup_requests_uid_fkey;
alter table public.backer_logs drop constraint backer_logs_uid_fkey;
alter table public.slip_verifications drop constraint slip_verifications_uid_fkey;
alter table public.wallet_slip_credits drop constraint wallet_slip_credits_uid_fkey;

alter table public.users drop constraint users_pkey;
alter table public.users add constraint users_pkey primary key (shop_id, uid);

alter table public.bets add constraint bets_shop_uid_fkey
  foreign key (shop_id, uid) references public.users (shop_id, uid);

alter table public.topup_requests add constraint topup_requests_shop_uid_fkey
  foreign key (shop_id, uid) references public.users (shop_id, uid);

alter table public.backer_logs add constraint backer_logs_shop_uid_fkey
  foreign key (shop_id, uid) references public.users (shop_id, uid);

alter table public.slip_verifications add constraint slip_verifications_shop_uid_fkey
  foreign key (shop_id, uid) references public.users (shop_id, uid);

alter table public.wallet_slip_credits add constraint wallet_slip_credits_shop_uid_fkey
  foreign key (shop_id, uid) references public.users (shop_id, uid);

CREATE OR REPLACE FUNCTION public.sync_approved_player()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.state = 'Approved' then
    insert into public.users (uid, shop_id, member_id, display_name, role, status)
    values (new.line_uid, new.shop_id, new.member_id, new.display_name, 'Customer', 'Active')
    on conflict (shop_id, uid) do update set member_id = excluded.member_id
      where users.member_id is null or users.member_id = excluded.member_id;
    if not found then
      raise exception 'Cannot link the approved member to an existing player account';
    end if;
  end if;
  return new;
end $function$;

create function public.create_platform_shop(p_shop text, p_name text, p_owner text, p_owner_name text)
returns text
language plpgsql
security invoker
set search_path = ''
as $create_shop$
begin
  insert into public.shops (shop_id, shop_name, status)
    values (p_shop, p_name, 'Inactive')
    on conflict (shop_id) do nothing;
  if not found then return 'SHOP_EXISTS'; end if;

  insert into public.users (uid, shop_id, member_id, display_name, role, status)
    values (p_owner, p_shop, 'M0000', p_owner_name, 'Admin', 'Active');

  insert into public.system_settings (shop_id) values (p_shop)
    on conflict (shop_id) do nothing;
  return 'CREATED';
end;
$create_shop$;

revoke all on function public.create_platform_shop(text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_platform_shop(text, text, text, text) to service_role;

commit;
