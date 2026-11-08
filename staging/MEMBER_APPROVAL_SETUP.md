# General membership approvals — independent feature

This feature creates **a general membership application and review queue**, independent of `users.status`, financial settlement, or wagering access. It does **not** enable gambling features or automatic credit actions.

## Files
- `supabase/functions/member-approval/index.ts` — LINE token validation and admin decision API
- `staging/sql/002_membership_applications.sql` — additive schema
- `staging/member-apply.html` — standalone general membership form and status
- `staging/member-review.html` — standalone admin review queue

## API contracts
- JSON POST to /functions/v1/member-approval with Bearer LINE ID token and apikey publishable Supabase key.
- `apply` (player channel): `{action:"apply",shop_id,display_name}`
- `status` (player channel): `{action:"status",shop_id}`
- `queue` (admin channel): `{action:"queue",shop_id}`
- `decide` (admin channel): `{action:"decide",shop_id,id,decision:"Approved"|"Rejected"}`
- Server validates token with LINE API and verifies Admin/Superadmin membership for admin actions.
- API intentionally omits UID from queue results and does not modify `users`.

## Deployment checklist
1. Review/back up existing Supabase data; run SQL only after approval.
2. Check secrets `LINE_CHANNEL_ID_PLAYER`, `LINE_CHANNEL_ID_ADMIN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `WEB_ORIGIN`.
3. Deploy Edge Function `member-approval` with Supabase JWT verification **disabled** (LINE ID tokens are verified server-side).
4. Ensure LIFF player/admin supports the hosted paths; no endpoint changes to the existing LIFF until confirmed.
5. Test unauthorized queue and cross-shop access; repeat apply must retain prior decision; double decision must return 409.
6. No changes to current index.html/admin.html. Approval here **does not change** existing user statuses or access to existing application functions.

## Not yet delivered
- Onboarding into the existing `index.html` app
- Notification to LINE group
- Server-side gates for legacy app functionality
- End-to-end integration tests or deployment to Supabase

These require independent review of security, permissions and any gated features before integration.
