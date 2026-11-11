alter table public.platform_shop_plan_requests
  add column trial_started_at timestamptz,
  add column trial_ends_at timestamptz,
  add constraint platform_shop_trial_dates_valid check (
    (trial_started_at is null and trial_ends_at is null)
    or (plan_code = 'free' and trial_started_at is not null and trial_ends_at is not null
      and trial_ends_at = trial_started_at + interval '240 hours')
  );

grant update (trial_started_at, trial_ends_at) on public.platform_shop_plan_requests to service_role;

create function public.start_platform_shop_trial()
returns trigger
language plpgsql set search_path = ''
as $function$
begin
  update public.platform_shop_plan_requests
  set trial_started_at = statement_timestamp(),
      trial_ends_at = statement_timestamp() + interval '240 hours'
  where shop_id = new.shop_id and plan_code = 'free' and trial_started_at is null;
  return new;
end;
$function$;

revoke execute on function public.start_platform_shop_trial() from public, anon, authenticated;
grant execute on function public.start_platform_shop_trial() to service_role;

create trigger start_platform_shop_trial_on_activation
after update of status on public.shops
for each row
when (new.status = 'active' and old.status is distinct from new.status)
execute function public.start_platform_shop_trial();
