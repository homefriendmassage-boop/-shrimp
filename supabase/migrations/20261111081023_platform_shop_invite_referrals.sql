alter table public.platform_shop_invites
  add column referrer_shop_id text references public.shops(shop_id),
  add column referral_tier text,
  add constraint platform_shop_invites_referral_check check (
    (referrer_shop_id is null and referral_tier is null)
    or (referrer_shop_id is not null and referral_tier is not null
      and referral_tier in ('standard', 'group_lead'))
  );
