-- General membership applications only; does not grant wagering, wallet, or payment permissions.
-- Review and backup before running on an existing project.
CREATE TABLE IF NOT EXISTS public.membership_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id text NOT NULL REFERENCES public.shops(shop_id),
  line_uid text NOT NULL,
  display_name text,
  state text NOT NULL DEFAULT 'Pending'
    CHECK (state IN ('Pending','Approved','Rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text,
  reason text,
  CONSTRAINT membership_applications_unique_shop_uid UNIQUE(shop_id,line_uid)
);
CREATE INDEX IF NOT EXISTS idx_membership_applications_queue
  ON public.membership_applications(shop_id,state,requested_at DESC);
ALTER TABLE public.membership_applications ENABLE ROW LEVEL SECURITY;
-- No client policies; access solely through server Edge Function verifying LINE identity and admin authorization.
-- This table is intentionally independent of public.users.status and credit_balance.
