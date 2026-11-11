-- Allocate the canonical member code independently for each shop.
create table public.shop_member_counters (
  shop_id text primary key references public.shops(shop_id) on delete cascade,
  last_number bigint not null check (last_number >= 0)
);

alter table public.shop_member_counters enable row level security;
revoke all on public.shop_member_counters from public, anon, authenticated;
grant select, insert, update on public.shop_member_counters to service_role;

-- The existing (shop_id, member_id) unique indexes enforce each shop's namespace.
drop index if exists public.membership_applications_unique_member_id;

create or replace function public.assign_canonical_member_id()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  next_number text;
begin
  if tg_op = 'UPDATE' then
    new.member_id := old.member_id;
    return new;
  end if;

  -- Seed each shop from its existing IDs the first time it needs a counter.
  insert into public.shop_member_counters (shop_id, last_number)
  select new.shop_id, coalesce((
    select max(substring(existing.member_id from 2)::bigint)
    from (
      select a.member_id
      from public.membership_applications a
      where a.shop_id = new.shop_id
      union all
      select u.member_id
      from public.users u
      where u.shop_id = new.shop_id
    ) existing
    where existing.member_id ~ '^M(0[0-9]{3}|[1-9][0-9]{3,})$'
  ), 0)
  where not exists (
    select 1 from public.shop_member_counters c where c.shop_id = new.shop_id
  )
  on conflict (shop_id) do nothing;

  -- Serialize issuance within this shop, including concurrent submission retries.
  perform 1 from public.shop_member_counters c
  where c.shop_id = new.shop_id
  for update;

  select a.member_id into new.member_id
  from public.membership_applications a
  where a.shop_id = new.shop_id and a.line_uid = new.line_uid;
  if found then
    return new;
  end if;

  select u.member_id into new.member_id
  from public.users u
  where u.shop_id = new.shop_id and u.uid = new.line_uid;
  if new.member_id is null then
    update public.shop_member_counters c
    set last_number = c.last_number + 1
    where c.shop_id = new.shop_id
    returning c.last_number::text into next_number;

    new.member_id := 'M' || lpad(next_number, greatest(4, length(next_number)), '0');
  end if;
  return new;
end;
$function$;

-- Correct the sole pending application in SHOP_002 if it has no downstream use.
alter table public.membership_applications disable trigger zzzz_assign_canonical_member_id;

update public.membership_applications a
set member_id = 'M0001'
where a.shop_id = 'SHOP_002' and a.state = 'Pending' and a.member_id = 'M0004'
  and not exists (
    select 1 from public.membership_applications other
    where other.shop_id = a.shop_id and other.id <> a.id
  )
  and not exists (
    select 1 from public.users u
    where u.shop_id = a.shop_id and (u.uid = a.line_uid or u.member_id <> 'M0000')
  )
  and not exists (
    select 1 from public.membership_notification_outbox n
    where n.application_id = a.id and n.sent_at is not null
  )
  and not exists (
    select 1 from public.topup_requests r
    where r.shop_id = a.shop_id and (r.uid = a.line_uid or r.member_id in (a.member_id, 'M0001'))
  )
  and not exists (
    select 1 from public.transactions t
    where t.shop_id = a.shop_id and t.target_id::text in (a.line_uid, a.member_id, 'M0001')
  )
  and not exists (
    select 1 from public.bets b where b.shop_id = a.shop_id and b.uid = a.line_uid
  )
  and not exists (
    select 1 from public.backer_logs b
    where b.shop_id = a.shop_id and (b.uid = a.line_uid or b.member_id in (a.member_id, 'M0001'))
  );

alter table public.membership_applications enable trigger zzzz_assign_canonical_member_id;
