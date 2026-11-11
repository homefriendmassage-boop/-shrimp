create table public.platform_shop_plan_requests (
  shop_id text primary key references public.shops(shop_id) on delete cascade,
  plan_code text not null check (plan_code in ('free', 'starter', 'basic', 'pro')),
  created_at timestamptz not null default now()
);

alter table public.platform_shop_plan_requests enable row level security;
revoke all on public.platform_shop_plan_requests from public, anon, authenticated;
grant select, insert on public.platform_shop_plan_requests to service_role;

create function public.redeem_platform_shop_invite_with_plan(
  p_invite uuid, p_name text, p_owner text, p_owner_name text, p_phone text, p_plan text
)
returns jsonb
language plpgsql set search_path = ''
as $function$
declare
  result jsonb;
  saved_plan text;
begin
  if p_plan is null or p_plan not in ('free', 'starter', 'basic', 'pro') then
    return jsonb_build_object('code', 'PLAN_INVALID');
  end if;
  result := public.redeem_platform_shop_invite(p_invite, p_name, p_owner, p_owner_name, p_phone);
  if result->>'code' is distinct from 'CREATED' then return result; end if;

  insert into public.platform_shop_plan_requests (shop_id, plan_code)
  values (result->>'shop_id', p_plan) on conflict (shop_id) do nothing;

  select plan_code into strict saved_plan from public.platform_shop_plan_requests
  where shop_id = result->>'shop_id';

  return result || jsonb_build_object('plan_code', saved_plan);
end;
$function$;

revoke execute on function public.redeem_platform_shop_invite_with_plan(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.redeem_platform_shop_invite_with_plan(uuid, text, text, text, text, text) to service_role;
