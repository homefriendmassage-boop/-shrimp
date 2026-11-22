alter table public.platform_shop_plan_requests
  drop constraint platform_shop_trial_dates_valid,
  add constraint platform_shop_trial_dates_valid check (
    (trial_started_at is null and trial_ends_at is null)
    or (plan_code = 'free' and trial_started_at is not null and trial_ends_at is not null
      and trial_ends_at >= trial_started_at + interval '240 hours')
  );

create table public.platform_shop_plan_extensions (
  shop_id text not null references public.shops(shop_id) on delete cascade,
  request_id uuid not null,
  actor text not null,
  days integer not null check (days between 1 and 365),
  reason text not null check (char_length(btrim(reason)) between 1 and 300),
  previous_until timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (shop_id, request_id)
);
alter table public.platform_shop_plan_extensions enable row level security;
revoke all on public.platform_shop_plan_extensions from public, anon, authenticated;
grant select, insert on public.platform_shop_plan_extensions to service_role;

create function public.extend_platform_shop_plan(
  p_shop text, p_days integer, p_reason text, p_actor text, p_request uuid
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  previous_expiry timestamptz;
  next_expiry timestamptz;
  prior public.platform_shop_plan_extensions%rowtype;
  paid boolean;
begin
  if p_shop is null or p_shop = 'SHOP_000' or p_days is null or p_days not between 1 and 365
     or p_reason is null or char_length(btrim(p_reason)) not between 1 and 300
     or p_actor is null or p_request is null then
    return jsonb_build_object('code','PLAN_EXTENSION_INVALID');
  end if;

  perform 1 from public.shops where shop_id = p_shop for update;
  if not found then return jsonb_build_object('code','SHOP_PLAN_NOT_EXTENDABLE'); end if;

  select * into prior from public.platform_shop_plan_extensions
    where shop_id = p_shop and request_id = p_request;
  if found then
    if prior.actor <> p_actor or prior.days <> p_days or prior.reason <> btrim(p_reason) then
      return jsonb_build_object('code','PLAN_EXTENSION_INVALID');
    end if;
    return jsonb_build_object('code','EXTENDED','expires_at',prior.expires_at);
  end if;

  select paid_until into previous_expiry from public.platform_billing_state
    where shop_id = p_shop and paid_until is not null for update;
  paid := found;
  if not paid then
    select trial_ends_at into previous_expiry from public.platform_shop_plan_requests
      where shop_id = p_shop and plan_code = 'free' for update;
  end if;
  if previous_expiry is null then return jsonb_build_object('code','SHOP_PLAN_NOT_EXTENDABLE'); end if;

  next_expiry := greatest(previous_expiry, clock_timestamp()) + p_days * interval '24 hours';
  if paid then
    update public.platform_billing_state set paid_until = next_expiry where shop_id = p_shop;
  else
    update public.platform_shop_plan_requests set trial_ends_at = next_expiry where shop_id = p_shop;
  end if;

  insert into public.platform_shop_plan_extensions
    (shop_id, request_id, actor, days, reason, previous_until, expires_at)
    values (p_shop, p_request, p_actor, p_days, btrim(p_reason), previous_expiry, next_expiry);
  return jsonb_build_object('code','EXTENDED','expires_at',next_expiry);
end;
$$;
revoke all on function public.extend_platform_shop_plan(text,integer,text,text,uuid) from public, anon, authenticated;
grant execute on function public.extend_platform_shop_plan(text,integer,text,text,uuid) to service_role;
