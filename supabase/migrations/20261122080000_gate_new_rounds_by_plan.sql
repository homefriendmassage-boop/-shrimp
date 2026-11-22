begin;

create or replace function public.open_staff_round(p_shop text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  last_round public.rounds%rowtype;
  current_time_at timestamptz;
  day_code text;
  shop_code text;
  old_number text[];
  sequence_no numeric := 1;
  duration integer;
  new_round text;
  shop_status text;
  requested_plan text;
  trial_end timestamptz;
  paid_end timestamptz;
begin
  shop_code := substring(p_shop from '^SHOP_([0-9]{3,24})$');
  if shop_code is null then return jsonb_build_object('code','SHOP_INVALID'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('open-round:' || p_shop,0));
  select * into last_round from public.rounds where shop_id = p_shop
    order by created_at desc nulls last, round_id desc limit 1 for update;
  if found and last_round.status is distinct from 'Ended' then
    return jsonb_build_object('code','ROUND_PREVIOUS_UNFINISHED');
  end if;
  select status into shop_status from public.shops where shop_id = p_shop for share;
  if not found or lower(shop_status) is distinct from 'active' then
    return jsonb_build_object('code','SHOP_NOT_AVAILABLE');
  end if;
  current_time_at := clock_timestamp();
  if p_shop <> 'SHOP_000' then
    select plan_code, trial_ends_at into requested_plan, trial_end
      from public.platform_shop_plan_requests where shop_id = p_shop;
    select paid_until into paid_end from public.platform_billing_state where shop_id = p_shop;
    current_time_at := clock_timestamp();
    if paid_end is not null then
      if paid_end <= current_time_at then
        return jsonb_build_object('code','SHOP_PLAN_EXPIRED');
      end if;
    elsif requested_plan = 'free' then
      if trial_end is null or trial_end <= current_time_at then
        return jsonb_build_object('code','SHOP_TRIAL_EXPIRED');
      end if;
    elsif requested_plan is not null then
      return jsonb_build_object('code','SHOP_PLAN_PAYMENT_REQUIRED');
    end if;
  end if;
  day_code := to_char(public.shop_accounting_day(current_time_at),'YYMMDD');
  old_number := regexp_match(last_round.round_id, '^R-' || day_code || '-' || shop_code || '-([0-9]+)$');
  if old_number is null then
    old_number := regexp_match(last_round.round_id, '^R-' || day_code || '-([0-9]+)(?:-SHOP_' || shop_code || ')?$');
  end if;
  if old_number is not null then sequence_no := old_number[1]::numeric + 1; end if;
  select round_duration into duration from public.system_settings where shop_id = p_shop order by id limit 1;
  new_round := 'R-' || day_code || '-' || shop_code || '-' || sequence_no::text;
  insert into public.rounds (shop_id,round_id,status,end_time_ms,resolver_type)
    values (p_shop,new_round,'Open',
      floor(extract(epoch from current_time_at) * 1000)::bigint + coalesce(nullif(duration,0),15)::bigint * 60000,'none');
  return jsonb_build_object('code','OPENED','round_id',new_round);
end;
$$;

commit;
