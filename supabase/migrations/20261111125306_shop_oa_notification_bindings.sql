create table public.shop_oa_member_links (
  shop_id text not null references public.shops(shop_id) on delete cascade,
  member_uid text not null check (member_uid ~ '^U[0-9a-fA-F]{32}$'),
  bot_uid text not null check (bot_uid ~ '^U[0-9a-fA-F]{32}$'),
  oa_uid text not null check (oa_uid ~ '^U[0-9a-fA-F]{32}$'),
  linked_at timestamptz not null default now(),
  primary key (shop_id, member_uid),
  unique (shop_id, bot_uid, oa_uid)
);

create table public.shop_oa_link_challenges (
  shop_id text not null references public.shops(shop_id) on delete cascade,
  member_uid text not null,
  bot_uid text not null,
  code uuid not null unique default gen_random_uuid(),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  primary key (shop_id, member_uid)
);

alter table public.shop_oa_member_links enable row level security;
alter table public.shop_oa_link_challenges enable row level security;
revoke all on public.shop_oa_member_links, public.shop_oa_link_challenges from public, anon, authenticated;
grant select, insert, update, delete on public.shop_oa_member_links, public.shop_oa_link_challenges to service_role;

create function public.complete_shop_oa_link(p_shop text, p_bot text, p_code uuid, p_sender text)
returns boolean
language plpgsql set search_path = ''
as $function$
declare
  link_request public.shop_oa_link_challenges%rowtype;
begin
  delete from public.shop_oa_link_challenges c
  using public.shops s
  where c.shop_id = p_shop and c.bot_uid = p_bot and c.code = p_code
    and c.expires_at > now() and s.shop_id = c.shop_id and s.line_oa_bot_uid = c.bot_uid
    and s.status = 'active'
  returning c.* into link_request;
  if not found then return false; end if;

  begin
    insert into public.shop_oa_member_links as links (shop_id, member_uid, bot_uid, oa_uid)
    values (link_request.shop_id, link_request.member_uid, p_bot, p_sender)
    on conflict (shop_id, member_uid) do update
      set bot_uid = excluded.bot_uid, oa_uid = excluded.oa_uid, linked_at = now()
      where links.bot_uid <> excluded.bot_uid;
    return found;
  exception when unique_violation then
    return false;
  end;
end;
$function$;

create function public.resolve_shop_oa_recipient(p_shop text, p_member text)
returns text
language sql stable set search_path = ''
as $function$
  select coalesce(l.oa_uid, case when s.shop_id = 'SHOP_000' and s.line_oa_bot_uid is null then p_member end)
  from public.shops s
  left join public.shop_oa_member_links l on l.shop_id = s.shop_id
    and l.bot_uid = s.line_oa_bot_uid and l.member_uid = p_member
  where s.shop_id = p_shop;
$function$;

create function public.resolve_shop_oa_recipients(p_shop text, p_members text[])
returns text[]
language sql stable set search_path = ''
as $function$
  select coalesce(array_agg(distinct recipients.uid) filter (where recipients.uid is not null), array[]::text[])
  from unnest(p_members) m(uid)
  cross join lateral (select public.resolve_shop_oa_recipient(p_shop, m.uid) as uid) recipients;
$function$;

revoke execute on function public.complete_shop_oa_link(text, text, uuid, text),
  public.resolve_shop_oa_recipient(text, text), public.resolve_shop_oa_recipients(text, text[]) from public, anon, authenticated;
grant execute on function public.complete_shop_oa_link(text, text, uuid, text),
  public.resolve_shop_oa_recipient(text, text), public.resolve_shop_oa_recipients(text, text[]) to service_role;

CREATE OR REPLACE FUNCTION public.queue_round_notices()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    cross join lateral (select public.resolve_shop_oa_recipient(a.shop_id, a.line_uid) as uid) oa
    where oa.uid is not null and a.shop_id = new.shop_id and a.state = 'Approved' and u.status = 'Active'
      and a.line_uid ~ '^U[0-9a-fA-F]{32}$'
      and (
        a.decided_at >= now() - interval '12 hours'
        or exists (
          select 1 from public.line_member_activity act
          where act.shop_id = a.shop_id and act.line_uid = oa.uid
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
end $function$;

CREATE OR REPLACE FUNCTION public.claim_membership_notice(p_application uuid, p_kind text, p_manual boolean)
 RETURNS SETOF membership_notification_outbox
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.membership_notification_outbox
  set last_attempt_at = now(),
      retry_key = case when sent_at is not null or first_attempt_at < now() - interval '23 hours'
        then gen_random_uuid() else retry_key end,
      first_attempt_at = case when sent_at is not null or first_attempt_at < now() - interval '23 hours'
        then now() else coalesce(first_attempt_at, now()) end,
      sent_at = null
  where application_id = p_application and kind = p_kind
    and (last_attempt_at is null or (p_manual and (kind = 'submitted' or (kind = 'approved' and sent_at is null)) and last_attempt_at <= now() - interval '30 minutes'))
  returning *;
$function$;
