create or replace function public.claim_shop_rich_menu_sync()
returns table(shop_id text, oa_uid text, menu_id text, lease uuid, token text, known_menus text[])
language plpgsql set search_path = '' as $$
begin
  insert into public.shop_rich_menu_members (shop_id, oa_uid)
  select m.shop_id, l.oa_uid
    from public.shop_rich_menus m
    join public.shop_rich_menu_pilots p on p.shop_id = m.shop_id
    join public.shops s on s.shop_id = m.shop_id and (s.line_oa_bot_uid = m.bot_uid or (s.shop_id = 'SHOP_000' and s.line_oa_bot_uid is null))
    join public.shop_oa_member_links l on l.shop_id = m.shop_id and l.bot_uid = m.bot_uid
    join public.users u on u.shop_id = l.shop_id and u.uid = l.member_uid
    join public.membership_applications a on a.shop_id = u.shop_id and a.line_uid = u.uid
    where lower(s.status) = 'active' and m.published_id is not null
      and u.status = 'Active' and u.role <> 'Cashier' and a.state = 'Approved'
      and (p.member_uid is null or p.member_uid = u.uid)
  union
  select m.shop_id, u.uid
    from public.shop_rich_menus m
    join public.shop_rich_menu_pilots p on p.shop_id = m.shop_id
    join public.shops s on s.shop_id = m.shop_id
    join public.users u on u.shop_id = s.shop_id
    join public.membership_applications a on a.shop_id = u.shop_id and a.line_uid = u.uid
    where s.shop_id = 'SHOP_000' and s.line_oa_bot_uid is null
      and lower(s.status) = 'active' and m.published_id is not null
      and u.status = 'Active' and u.role <> 'Cashier' and a.state = 'Approved'
      and (p.member_uid is null or p.member_uid = u.uid)
    on conflict do nothing;

  return query
  with candidates as (
    select j.shop_id, j.oa_uid,
      case when lower(s.status) = 'active' and exists (
        select 1 from public.shop_oa_member_links l
        join public.users u on u.shop_id = l.shop_id and u.uid = l.member_uid
        join public.membership_applications a on a.shop_id = u.shop_id and a.line_uid = u.uid
        join public.shop_rich_menu_pilots p on p.shop_id = l.shop_id
        where (p.member_uid is null or p.member_uid = u.uid) and l.shop_id = j.shop_id and l.bot_uid = m.bot_uid and l.oa_uid = j.oa_uid
          and u.status = 'Active' and u.role <> 'Cashier' and a.state = 'Approved'
      ) then m.published_id
      when s.shop_id = 'SHOP_000' and s.line_oa_bot_uid is null and lower(s.status) = 'active' and exists (
        select 1 from public.users u
        join public.membership_applications a on a.shop_id = u.shop_id and a.line_uid = u.uid
        join public.shop_rich_menu_pilots p on p.shop_id = u.shop_id
        where u.shop_id = j.shop_id and u.uid = j.oa_uid and u.status = 'Active' and u.role <> 'Cashier'
          and a.state = 'Approved' and (p.member_uid is null or p.member_uid = u.uid)
      ) then m.published_id end as target,
      j.applied_id, j.lease, j.refresh_after, o.line_oa_token
    from public.shop_rich_menu_members j
    join public.shop_rich_menus m on m.shop_id = j.shop_id
    join public.shops s on s.shop_id = m.shop_id and (s.line_oa_bot_uid = m.bot_uid or (s.shop_id = 'SHOP_000' and s.line_oa_bot_uid is null))
    join public.shop_oa_runtime o on o.shop_id = m.shop_id
    where o.line_oa_token is not null
  ), selected as (
    select c.* from candidates c
    join public.shop_rich_menu_members j using (shop_id, oa_uid)
    where (c.lease is null or c.refresh_after <= now())
      and (c.target is distinct from c.applied_id or c.refresh_after <= now())
    order by c.refresh_after, c.shop_id, c.oa_uid
    limit 24 for update of j skip locked
  ), leased as (
    update public.shop_rich_menu_members as j set lease = gen_random_uuid(), refresh_after = now() + interval '2 minutes'
    from selected c where j.shop_id = c.shop_id and j.oa_uid = c.oa_uid
    returning j.shop_id, j.oa_uid, c.target, j.lease, c.line_oa_token
  )
  select j.shop_id, j.oa_uid, j.target, j.lease, j.line_oa_token,
    array(select v.menu_id from public.shop_rich_menu_versions v where v.shop_id = j.shop_id)
  from leased j;
end;
$$;


create or replace function public.next_default_shop_rich_menu()
returns text language sql stable set search_path = '' as $$
  select s.shop_id
  from public.shop_rich_menu_pilots p join public.shops s on s.shop_id = p.shop_id
  join public.shop_oa_runtime o on o.shop_id = s.shop_id
  left join public.shop_rich_menus m on m.shop_id = s.shop_id
  where lower(s.status) = 'active' and (s.line_oa_bot_uid is not null or s.shop_id = 'SHOP_000') and o.line_oa_token is not null
    and m.published_id is null and (m.shop_id is null or m.use_default)
  order by s.created_at, s.shop_id limit 1;
$$;
