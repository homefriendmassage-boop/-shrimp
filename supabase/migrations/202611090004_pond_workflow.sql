begin;

alter table public.membership_applications add column if not exists profile_pic text;
alter table public.membership_notification_outbox
  add column if not exists last_attempt_at timestamptz,
  add column if not exists retry_key uuid;
update public.membership_notification_outbox
set retry_key = id, last_attempt_at = coalesce(last_attempt_at, first_attempt_at)
where retry_key is null;
alter table public.membership_notification_outbox
  alter column retry_key set default gen_random_uuid(),
  alter column retry_key set not null;

-- One durable attempt per 30-minute window, even across devices and reloads.
create or replace function public.claim_membership_notice(
  p_application uuid, p_kind text, p_manual boolean
) returns setof public.membership_notification_outbox
language sql security definer set search_path = '' as $$
  update public.membership_notification_outbox
  set last_attempt_at = now(),
      retry_key = case when sent_at is not null or first_attempt_at < now() - interval '23 hours'
        then gen_random_uuid() else retry_key end,
      first_attempt_at = case when sent_at is not null or first_attempt_at < now() - interval '23 hours'
        then now() else coalesce(first_attempt_at, now()) end,
      sent_at = null
  where application_id = p_application and kind = p_kind
    and (last_attempt_at is null or (p_manual and kind = 'submitted' and last_attempt_at <= now() - interval '30 minutes'))
  returning *;
$$;
revoke all on function public.claim_membership_notice(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.claim_membership_notice(uuid,text,boolean) to service_role;

create or replace function public.sync_member_picture()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.state = 'Approved' and new.profile_pic is not null then
    update public.users set profile_pic = new.profile_pic
    where shop_id = new.shop_id and uid = new.line_uid and profile_pic is distinct from new.profile_pic;
  end if;
  return new;
end $$;
drop trigger if exists zzzzz_sync_member_picture on public.membership_applications;
create trigger zzzzz_sync_member_picture
after insert or update of state, profile_pic on public.membership_applications
for each row execute function public.sync_member_picture();

do $$
declare
  table_sequence regclass := pg_get_serial_sequence('public.tables', 'id')::regclass;
begin
  if table_sequence is not null then
    execute format('grant usage, select on sequence %s to service_role', table_sequence);
  end if;
end $$;

create table if not exists public.line_member_activity (
  shop_id text not null references public.shops(shop_id) on delete cascade,
  line_uid text not null,
  last_chat_at timestamptz not null,
  primary key (shop_id, line_uid)
);
alter table public.line_member_activity enable row level security;
revoke all on public.line_member_activity from anon, authenticated;

create or replace function public.record_member_chat(p_shop text, p_uid text, p_at timestamptz)
returns void language sql security definer set search_path = '' as $$
  insert into public.line_member_activity(shop_id, line_uid, last_chat_at)
  values (p_shop, p_uid, p_at)
  on conflict (shop_id, line_uid) do update
  set last_chat_at = greatest(public.line_member_activity.last_chat_at, excluded.last_chat_at);
$$;
revoke all on function public.record_member_chat(text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.record_member_chat(text,text,timestamptz) to service_role;

create table if not exists public.round_notice_batches (
  id uuid primary key default gen_random_uuid(),
  round_id text not null references public.rounds(round_id) on delete cascade,
  shop_id text not null references public.shops(shop_id) on delete cascade,
  batch_no int not null,
  recipients text[] not null,
  sent_at timestamptz,
  unique(round_id, batch_no)
);
alter table public.round_notice_batches enable row level security;
revoke all on public.round_notice_batches from anon, authenticated;
grant select, insert, update on public.round_notice_batches to service_role;

create or replace function public.queue_round_notices()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from 'Open' then return new; end if;
  insert into public.round_notice_batches(round_id, shop_id, batch_no, recipients)
  select new.round_id, new.shop_id, batch_no, array_agg(line_uid order by line_uid)
  from (
    select a.line_uid, ((row_number() over (order by a.line_uid) - 1) / 500)::int as batch_no
    from public.membership_applications a
    join public.users u on u.shop_id = a.shop_id and u.uid = a.line_uid
    where a.shop_id = new.shop_id and a.state = 'Approved' and u.status = 'Active'
      and a.line_uid ~ '^U[0-9a-fA-F]{32}$'
      and (
        a.decided_at >= now() - interval '12 hours'
        or exists (
          select 1 from public.line_member_activity act
          where act.shop_id = a.shop_id and act.line_uid = a.line_uid
            and act.last_chat_at >= now() - interval '12 hours'
        )
        or exists (
          select 1 from public.membership_notification_outbox n
          where n.application_id = a.id and n.kind = 'approved'
            and n.sent_at >= now() - interval '12 hours'
        )
      )
  ) eligible
  group by batch_no
  on conflict do nothing;
  return new;
end $$;
drop trigger if exists queue_round_notices on public.rounds;
create trigger queue_round_notices after insert on public.rounds
for each row execute function public.queue_round_notices();

commit;
