create function public.resolve_shop_oa_member(p_shop text, p_oa_uid text)
returns text
language sql stable set search_path = ''
as $function$
  select l.member_uid
  from public.shops s
  join public.shop_oa_member_links l on l.shop_id = s.shop_id and l.bot_uid = s.line_oa_bot_uid
  where s.shop_id = p_shop and s.status = 'active' and l.oa_uid = p_oa_uid;
$function$;

revoke execute on function public.resolve_shop_oa_member(text, text) from public, anon, authenticated;
grant execute on function public.resolve_shop_oa_member(text, text) to service_role;