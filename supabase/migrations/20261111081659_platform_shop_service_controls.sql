alter table public.platform_shop_invites
  drop constraint platform_shop_invites_referral_check;

alter table public.shops add column live_enabled boolean not null default false;
update public.shops set live_enabled = true where lower(status) = 'active';
