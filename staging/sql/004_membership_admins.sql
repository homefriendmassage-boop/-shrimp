-- General membership review admin grants; independent of users, credits, and bets.
-- Run in the existing shrimp-saas project SQL editor as database owner.
CREATE TABLE IF NOT EXISTS public.membership_admins (
  shop_id text NOT NULL REFERENCES public.shops(shop_id) ON DELETE CASCADE,
  line_uid text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(shop_id,line_uid)
);
ALTER TABLE public.membership_admins ENABLE ROW LEVEL SECURITY;
-- Deliberately no anon/authenticated RLS policies.
-- Only service-role Edge Functions can read; setup/revocation must be done by DBA through SQL Editor.
