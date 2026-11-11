create function public.activate_new_free_shop()
returns trigger
language plpgsql set search_path = ''
as $function$
begin
  update public.shops
  set status = 'active'
  where shop_id = new.shop_id and lower(status) = 'inactive';
  return new;
end;
$function$;

revoke execute on function public.activate_new_free_shop() from public, anon, authenticated;
grant execute on function public.activate_new_free_shop() to service_role;

create trigger activate_new_free_shop_on_plan
after insert on public.platform_shop_plan_requests
for each row
when (new.plan_code = 'free')
execute function public.activate_new_free_shop();

update public.shops s
set status = 'active'
from public.platform_shop_plan_requests p
where s.shop_id = 'SHOP_002' and p.shop_id = s.shop_id and p.plan_code = 'free'
  and p.trial_started_at is null and lower(s.status) = 'inactive';
