begin;

lock table public.membership_applications, public.users in share row exclusive mode;

do $$
declare
  candidate public.membership_applications%rowtype;
begin
  select * into candidate from public.membership_applications
  where shop_id = 'SHOP_001' and member_id = 'M0003' and state = 'Pending';

  if not found then
    raise exception 'M0003 is no longer pending. No member code changed.';
  end if;

  if exists (
    select 1 from public.membership_applications
    where shop_id = candidate.shop_id and member_id = 'M0002'
  ) or exists (
    select 1 from public.users
    where shop_id = candidate.shop_id
      and (uid = candidate.line_uid or member_id in ('M0002', 'M0003') or referrer_uid in ('M0002', 'M0003'))
  ) or exists (
    select 1 from public.membership_notification_outbox
    where application_id = candidate.id and (first_attempt_at is not null or sent_at is not null)
  ) or exists (
    select 1 from public.transactions where shop_id = candidate.shop_id and target_id in ('M0002', 'M0003')
  ) or exists (
    select 1 from public.topup_requests
    where shop_id = candidate.shop_id and (uid = candidate.line_uid or member_id in ('M0002', 'M0003'))
  ) or exists (
    select 1 from public.backer_logs
    where shop_id = candidate.shop_id and (uid = candidate.line_uid or member_id in ('M0002', 'M0003'))
  ) then
    raise exception 'A member code is occupied or linked to existing records. No member code changed.';
  end if;

  alter table public.membership_applications disable trigger zzzz_assign_canonical_member_id;
  update public.membership_applications set member_id = 'M0002' where id = candidate.id;
  alter table public.membership_applications enable trigger zzzz_assign_canonical_member_id;

  -- Reuse M0003 next only when no later allocation exists anywhere.
  if (select last_value from public.canonical_member_number) = 3
    and not exists (
      select 1 from public.membership_applications
      where case when member_id ~ '^M[0-9]+$' then substring(member_id from 2)::numeric >= 3 else false end
    )
    and not exists (
      select 1 from public.users
      where case when member_id ~ '^M[0-9]+$' then substring(member_id from 2)::numeric >= 3 else false end
    )
    and not exists (
      select 1 from public.transactions where target_id = 'M0003'
      union all select 1 from public.topup_requests where member_id = 'M0003'
      union all select 1 from public.backer_logs where member_id = 'M0003'
      union all select 1 from public.users where referrer_uid = 'M0003'
    )
  then
    alter sequence public.canonical_member_number restart with 3;
  end if;
end $$;

commit;

select member_id, state from public.membership_applications
where shop_id = 'SHOP_001' and member_id = 'M0002';
