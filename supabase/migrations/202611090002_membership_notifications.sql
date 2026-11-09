begin;

create table if not exists public.membership_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.membership_applications(id) on delete cascade,
  kind text not null check (kind in ('submitted', 'approved')),
  created_at timestamptz not null default now(),
  first_attempt_at timestamptz,
  sent_at timestamptz,
  unique (application_id, kind)
);

alter table public.membership_notification_outbox enable row level security;
revoke all on public.membership_notification_outbox from anon, authenticated;
grant select, insert, update on public.membership_notification_outbox to service_role;

create or replace function public.enqueue_membership_notification()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.state = 'Pending' then
    insert into public.membership_notification_outbox(application_id, kind)
    values (new.id, 'submitted') on conflict do nothing;
  elsif tg_op = 'UPDATE' and old.state = 'Pending' and new.state = 'Approved' then
    insert into public.membership_notification_outbox(application_id, kind)
    values (new.id, 'approved') on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists enqueue_membership_notification on public.membership_applications;
create trigger enqueue_membership_notification
after insert or update of state on public.membership_applications
for each row execute function public.enqueue_membership_notification();

commit;
