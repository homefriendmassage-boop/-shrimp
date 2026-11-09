begin;

alter table public.round_notice_batches
  add column if not exists kind text not null default 'opened'
  check (kind in ('opened', 'closed', 'result'));
alter table public.round_notice_batches
  drop constraint if exists round_notice_batches_round_id_batch_no_key;
create unique index if not exists round_notice_batches_round_kind_batch_unique
  on public.round_notice_batches(round_id, kind, batch_no);

create or replace function public.queue_round_notices()
returns trigger language plpgsql set search_path = '' as $$
declare
  notice_kind text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  notice_kind := case new.status when 'Open' then 'opened' when 'Closed' then 'closed' when 'Ended' then 'result' end;
  if notice_kind is null or (tg_op = 'INSERT' and notice_kind <> 'opened') then return new; end if;
  insert into public.round_notice_batches(round_id, shop_id, kind, batch_no, recipients)
  select new.round_id, new.shop_id, notice_kind, batch_no, array_agg(line_uid order by line_uid)
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
create trigger queue_round_notices after insert or update of status on public.rounds
for each row execute function public.queue_round_notices();

commit;
