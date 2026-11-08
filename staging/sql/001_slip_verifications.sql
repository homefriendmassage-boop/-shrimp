-- STAGING ONLY: apply to a separate Supabase TEST project, never production without migration review.
-- Standalone verification log; deliberately no reference to wager/credit tables and no balance updates.
create table if not exists public.slip_verifications (
 id uuid primary key default gen_random_uuid(),
 request_id bigint,
 shop_id text not null,
 storage_path text not null,
 provider text not null default 'thunder',
 transaction_ref text,
 expected_amount numeric(12,2) check (expected_amount > 0),
 reported_amount numeric(12,2),
 receiver_match boolean,
 is_duplicate boolean,
 status text not null default 'Pending'
   check(status in ('Pending','Verifying','Verified','Rejected','ReviewRequired')),
 error_code text,
 provider_checked_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint slip_verified_ref unique (provider, transaction_ref)
);
create index if not exists idx_slip_verifications_shop_status
 on public.slip_verifications(shop_id,status,created_at desc);
alter table public.slip_verifications enable row level security;
-- NO broad client policy: requests must pass independently authenticated server authorization.
-- No insert/update/delete policy intentionally. Service-role calls must be confined to trusted Edge Functions.
