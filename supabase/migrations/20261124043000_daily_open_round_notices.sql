create or replace function public.queue_round_notices()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  notice_day date := public.shop_accounting_day(statement_timestamp());
begin
  if new.status is distinct from 'Open' then return new; end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;

  -- Serialize opening notices for a shop so concurrent rounds cannot claim the same customer.
  perform pg_catalog.pg_advisory_xact_lock(180613, pg_catalog.hashtext(new.shop_id));

  -- Preserve the first recipient snapshot if this round is opened again.
  if exists (
    select 1 from public.round_notice_batches
    where shop_id = new.shop_id and round_id = new.round_id and kind = 'opened'
  ) then return new; end if;

  insert into public.round_notice_batches(round_id, shop_id, kind, batch_no, recipients)
  select new.round_id, new.shop_id, 'opened', batch_no, array_agg(line_uid order by line_uid)
  from (
    select line_uid, ((row_number() over (order by line_uid) - 1) / 500)::int as batch_no
    from (
      select distinct a.line_uid
      from public.membership_applications a
      join public.users u on u.shop_id = a.shop_id and u.uid = a.line_uid
      join public.line_member_activity act
        on act.shop_id = a.shop_id
        and act.line_uid = public.resolve_shop_oa_recipient(a.shop_id, a.line_uid)
      where a.shop_id = new.shop_id and a.state = 'Approved' and u.status = 'Active'
        and a.line_uid ~ '^U[0-9a-fA-F]{32}$'
        and act.last_chat_at between statement_timestamp() - interval '6 hours' and statement_timestamp()
        and not exists (
          select 1
          from public.round_notice_batches previous
          join public.rounds prior_round on prior_round.shop_id = previous.shop_id
            and prior_round.round_id = previous.round_id
          where previous.shop_id = new.shop_id and previous.kind = 'opened'
            and previous.round_id <> new.round_id
            and a.line_uid = any(previous.recipients)
            and (public.shop_accounting_day(previous.sent_at) = notice_day
              or prior_round.created_at >= ((notice_day + time '06:00') at time zone 'Asia/Bangkok')
              and prior_round.created_at < ((notice_day + 1 + time '06:00') at time zone 'Asia/Bangkok'))
        )
    ) recipients
  ) batches
  group by batch_no
  on conflict do nothing;
  return new;
end;
$function$;
