create or replace function public.queue_round_notices()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.status is distinct from 'Open' then return new; end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;

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
        and act.last_chat_at >= statement_timestamp() - interval '6 hours'
    ) recipients
  ) batches
  group by batch_no
  on conflict do nothing;
  return new;
end;
$function$;
