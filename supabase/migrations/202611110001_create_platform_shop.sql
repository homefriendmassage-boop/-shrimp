begin;

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
    values (p_owner, p_shop, 'M0000', p_owner_name, 'Admin', 'Active')
    on conflict (uid) do nothing;
  if not found then
    raise exception using errcode = 'P0001', message = 'OWNER_UID_IN_USE';
  end if;

  insert into public.system_settings (shop_id) values (p_shop)
    on conflict (shop_id) do nothing;
  return 'CREATED';
exception
  when raise_exception then
    if sqlerrm = 'OWNER_UID_IN_USE' then return 'OWNER_UID_IN_USE'; end if;
    raise;
end;
$create_shop$;

revoke all on function public.create_platform_shop(text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_platform_shop(text, text, text, text) to service_role;

commit;
