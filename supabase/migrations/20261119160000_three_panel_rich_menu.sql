alter table public.shop_rich_menus add column use_default boolean not null default false;

create function public.next_default_shop_rich_menu()
returns text language sql stable set search_path = '' as $$
  select s.shop_id
  from public.shop_rich_menu_pilots p join public.shops s on s.shop_id = p.shop_id
  join public.shop_oa_runtime o on o.shop_id = s.shop_id
  left join public.shop_rich_menus m on m.shop_id = s.shop_id
  where lower(s.status) = 'active' and s.line_oa_bot_uid is not null and o.line_oa_token is not null
    and m.published_id is null and (m.shop_id is null or m.use_default)
  order by s.created_at, s.shop_id limit 1;
$$;
revoke all on function public.next_default_shop_rich_menu() from public, anon, authenticated;
grant execute on function public.next_default_shop_rich_menu() to service_role;

create function public.enable_new_shop_rich_menu()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.shop_rich_menu_pilots (shop_id) values (new.shop_id) on conflict do nothing;
  return new;
end;
$$;
revoke all on function public.enable_new_shop_rich_menu() from public, anon, authenticated;
create trigger enable_new_shop_rich_menu after insert on public.shops
  for each row execute function public.enable_new_shop_rich_menu();

-- First connected OA pilot. Other existing shops retain their current rollout state.
insert into public.shop_rich_menu_pilots (shop_id)
select shop_id from public.shops where shop_id = 'SHOP_001'
on conflict (shop_id) do nothing;

create function public.prepare_default_shop_rich_menu(p_shop text, p_draft jsonb)
returns boolean language plpgsql set search_path = '' as $$
begin
  insert into public.shop_rich_menus as m (shop_id, draft, use_default)
    values (p_shop, p_draft, true)
    on conflict (shop_id) do update set draft = excluded.draft
      where m.use_default and m.published_id is null;
  return found;
end;
$$;
revoke all on function public.prepare_default_shop_rich_menu(text,jsonb) from public, anon, authenticated;
grant execute on function public.prepare_default_shop_rich_menu(text,jsonb) to service_role;
