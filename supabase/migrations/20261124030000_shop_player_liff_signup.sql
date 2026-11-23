create function public.register_shop_liff_member(
  p_shop text, p_oa_uid text, p_name text, p_picture text, p_referrer text
)
returns text
language plpgsql set search_path = ''
as $function$
declare
  bot text;
begin
  select s.line_oa_bot_uid into bot from public.shops s
  where s.shop_id = p_shop and s.status = 'active'
  for update;
  if bot is null then return 'SHOP_OA_NOT_CONFIGURED'; end if;
  if public.resolve_shop_oa_member(p_shop, p_oa_uid) is not null then return 'LINKED'; end if;

  -- A different Provider can issue a second UID for the same person. Keep the
  -- old entry available until existing accounts have a verified OA mapping.
  if exists (
    select 1 from (
      select uid from public.users where shop_id = p_shop
      union
      select line_uid from public.membership_applications where shop_id = p_shop
    ) existing
    where public.resolve_shop_oa_recipient(p_shop, existing.uid) is null
  ) then return 'LEGACY_MEMBERS_NOT_LINKED'; end if;

  insert into public.shop_oa_member_links (shop_id, member_uid, bot_uid, oa_uid)
  values (p_shop, p_oa_uid, bot, p_oa_uid);
  insert into public.membership_applications
    (shop_id, line_uid, display_name, profile_pic, state, referral_member_id)
  values (p_shop, p_oa_uid, p_name, p_picture, 'Pending', p_referrer);
  return 'LINKED';
end;
$function$;

revoke execute on function public.register_shop_liff_member(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.register_shop_liff_member(text, text, text, text, text) to service_role;
