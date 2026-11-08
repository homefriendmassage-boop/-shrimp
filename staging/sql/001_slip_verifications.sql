-- Additive migration for the existing Supabase project. REVIEW AND BACK UP before execution.
-- No changes to original 9 tables. No credit/balance mutations.
CREATE TABLE IF NOT EXISTS public.slip_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id text NOT NULL REFERENCES public.shops(shop_id),
  uid text NOT NULL REFERENCES public.users(uid),
  storage_path text,
  claimed_amount numeric(12,2) NOT NULL CHECK (claimed_amount > 0),
  slip_amount numeric(12,2),
  transaction_ref text,
  receiver_matched boolean NOT NULL DEFAULT false,
  is_duplicate boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'Pending' CHECK
    (status IN ('Pending','Verifying','Verified','Rejected','ReviewRequired')),
  error_code text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS slip_verifications_unique_ref
 ON public.slip_verifications(transaction_ref) WHERE transaction_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS slip_verifications_shop_date_idx
 ON public.slip_verifications(shop_id,created_at DESC);
ALTER TABLE public.slip_verifications ENABLE ROW LEVEL SECURITY;
-- No browser-readable policies: only authenticated, authorized server handlers can access this.
-- Create PRIVATE storage bucket "slips-private" in the dashboard; do not create public policies.
