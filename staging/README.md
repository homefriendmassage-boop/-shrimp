# Thunder slip verification — isolated staging plan

Status: **prototype only**. This branch is not integrated with production index.html/admin.html. It must not be deployed on the current production hostname or merged without review.

## Current system facts
- Repo uses a public static front end with Supabase publishable key and LINE LIFF.
- All 9 production public tables were shown with RLS enabled and **no policies**. Browser operations may fail; do **not** disable RLS.
- Existing `index.html` uploads receipt images to a `slips` bucket and requests a public URL. Existing `admin.html` opens the URL in a new window.
- `topup_requests` has an integer id, shop_id, uid, amount, slip_url and status.
- LIFF `getProfile().userId` alone is **not** a Supabase authenticated identity. Do not trust shop_id/uid/amount supplied by the browser as authorization.

## Delivered prototype
- `staging/slip-preview.html`: offline preview/validation dry run; no Thunder or Supabase calls.
- `staging/sql/001_slip_verifications.sql`: staging-only additive table proposal, no production migration.
- No live credit movement, deposits, or withdrawals.

## Secure implementation gate (before real API integration)
1. Create a **separate Supabase test project** and use dummy data. Do not point staging at the production project.
2. Verify LINE LIFF ID token **server-side** with LINE's documented verification flow and check the expected channel. Bind verified subject to an authorized shop membership. Never trust raw UID sent by JS.
3. For administrator actions, independently verify server-side role **and** shop membership; do not rely only on hidden buttons or localStorage. Use least-privilege RLS or Edge Functions.
4. Make a private Storage bucket for slips; use generated random paths and restricted signed URLs (short expiry). Block public ACL and arbitrary client reads.
5. Add request-level idempotency and constraints preventing multiple accepted records for a transaction reference; handle concurrent checks and retries.
6. Call Thunder **only in a server Edge Function** using `THUNDER_API_KEY` from secrets and multipart FormData with `image`, `checkDuplicate=true`, `matchAmount` equal to the trusted request amount, `matchAccount=true` **only after merchant receiver accounts are registered and tested**.
7. Parse and store only required fields. `success=true` alone is not sufficient: reject duplicates; compare expected/actual amount, and matched registered receiver; ambiguous results should become `ReviewRequired`.
8. Save an audit trail without exposing bank account data to unauthorized clients. Use `Verified` only for a verified document; it is **not proof of bank settlement**. No balance/credit changes in this feature.
9. Add provider failure/timeout handling and rate limits. Never turn a transient provider error into an approval.
10. Run staging tests for valid, invalid, missing QR, amount mismatch, wrong receiver, duplicate, oversized image, repeated submit, provider unavailable and unauthorized caller.

## Thunder provider reference
https://document.thunder.in.th/th/v2/verify/bank/image
`POST https://api.thunder.in.th/v2/verify/bank`, Bearer secret, multipart image, max 4 MiB, supported MIME JPEG/PNG/GIF/WebP.

## Deployment & rollback
- Keep GitHub `main` untouched.
- Review branch and run test-only migration in **test project**.
- Verify RLS and authorization using both allowed and denied users.
- Get explicit approval before production deploy/migration.
