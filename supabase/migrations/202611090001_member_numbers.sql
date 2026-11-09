begin;

lock table public.membership_applications, public.users in share row exclusive mode;

-- Keep existing player accounts, credits and history. Refuse ambiguous mappings.
do $$
begin
  if exists (
    select 1 from public.users
    where member_id is not null
    group by shop_id, member_id having count(*) > 1
  ) then
    raise exception 'Existing player codes are duplicated. Resolve ownership before migration.';
  end if;
  if exists (
    select 1 from public.membership_applications a
    join public.users u on u.uid = a.line_uid
    where a.state = 'Approved' and u.shop_id <> a.shop_id
  ) then
    raise exception 'An approved LINE account belongs to another shop in users.';
  end if;
  if exists (
    select 1 from public.membership_applications a
    join public.users u on u.uid = a.line_uid and u.shop_id = a.shop_id
    where u.member_id is not null
      and u.member_id !~ '^M(0[0-9]{3}|[1-9][0-9]{3,})$'
  ) then
    raise exception 'An existing player code needs an explicit history mapping before it can change.';
  end if;
end $$;

create sequence if not exists public.canonical_member_number;

-- Keep the allocation above every existing numeric player code.
select setval(
  'public.canonical_member_number',
  greatest(
    (select last_value from public.canonical_member_number),
    coalesce((select max(substring(member_id from 2)::bigint)
      from public.users where member_id ~ '^M[0-9]{1,18}$'), 0)
  ),
  (select is_called from public.canonical_member_number)
    or exists (select 1 from public.users where member_id ~ '^M[0-9]{1,18}$')
);

create or replace function public.next_canonical_member_id()
returns text language sql set search_path = '' as $$
  select 'M' || lpad(n, greatest(4, length(n)), '0')
  from (select nextval('public.canonical_member_number'::regclass)::text as n) seq;
$$;

-- Existing installs may compute the old code as a generated column.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'membership_applications'
      and column_name = 'member_id' and is_generated = 'ALWAYS'
  ) then
    alter table public.membership_applications alter column member_id drop expression;
  end if;
end $$;

create or replace function public.assign_canonical_member_id()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.member_id := old.member_id;
  else
    select u.member_id into new.member_id from public.users u
    where u.uid = new.line_uid and u.shop_id = new.shop_id;
    if new.member_id is null then
      new.member_id := public.next_canonical_member_id();
    end if;
  end if;
  return new;
end $$;

create or replace function public.sync_approved_player()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.state = 'Approved' then
    insert into public.users (uid, shop_id, member_id, display_name, role, status)
    values (new.line_uid, new.shop_id, new.member_id, new.display_name, 'Customer', 'Active')
    on conflict (uid) do update set member_id = excluded.member_id
      where users.shop_id = excluded.shop_id
        and (users.member_id is null or users.member_id = excluded.member_id);
    if not found then
      raise exception 'Cannot link the approved member to an existing player account';
    end if;
  end if;
  return new;
end $$;

-- Idempotent on rerun. Allocate unlinked records in application order.
drop trigger if exists zzzz_assign_canonical_member_id on public.membership_applications;
drop trigger if exists zzzz_sync_approved_player on public.membership_applications;
do $$
declare
  application record;
begin
  for application in
    select a.id, a.member_id, u.member_id as player_code
    from public.membership_applications a
    left join public.users u on u.uid = a.line_uid and u.shop_id = a.shop_id
    order by a.member_no, a.id
  loop
    update public.membership_applications
    set member_id = coalesce(application.player_code,
      case when application.member_id ~ '^M(0[0-9]{3}|[1-9][0-9]{3,})$'
        and exists (select 1 from pg_indexes where schemaname = 'public'
          and indexname = 'membership_applications_canonical_code_unique')
        then application.member_id end,
      public.next_canonical_member_id())
    where id = application.id;
  end loop;
end $$;

create unique index if not exists membership_applications_canonical_code_unique
  on public.membership_applications (shop_id, member_id);
create unique index if not exists users_member_code_per_shop_unique
  on public.users (shop_id, member_id);

alter table public.membership_applications alter column member_id set not null;
alter table public.membership_applications drop constraint if exists membership_canonical_code_format;
alter table public.membership_applications add constraint membership_canonical_code_format
  check (member_id ~ '^M(0[0-9]{3}|[1-9][0-9]{3,})$');

create trigger zzzz_assign_canonical_member_id
before insert or update on public.membership_applications
for each row execute function public.assign_canonical_member_id();

create trigger zzzz_sync_approved_player
after insert or update of state on public.membership_applications
for each row execute function public.sync_approved_player();

update public.membership_applications set state = state where state = 'Approved';

revoke all on function public.next_canonical_member_id() from public, anon, authenticated;
grant execute on function public.next_canonical_member_id() to service_role;
grant usage, select on sequence public.canonical_member_number to service_role;

commit;
