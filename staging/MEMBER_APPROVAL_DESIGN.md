# New member approval gate (design review; not deployed)

## Current verified behavior
- `index.html` generates member IDs using `count(users in shop)+1`, inserting new users with `status: 'Active'`; this is prone to duplicate numbers under concurrent registration.
- Existing `pendingView` in `index.html` already hides primary content for non-Active members.
- Existing `admin.html` can search members and set Active/Inactive from the browser, but currently lists pending topup requests, **not pending registrations**.
- Database `users.uid` is the primary key, and `shop_id` is separate: the same LINE UID cannot register independently in multiple shops without a schema change.
- Screenshots show public tables' RLS enabled and no policies, so current browser-side insert/update may fail. Never disable RLS to bypass.

## Intended flow
1. First-time login via LIFF verifies LINE ID token **on the server**, including audience/channel and expiry.
2. Server creates user `status='Pending'` with a collision-safe shop-scoped member number; no client-supplied uid, member number, or role is trusted.
3. Server stores an approval event and notifies authorized staff via a server-managed LINE Messaging API token. Notification is best effort, while the in-app pending queue is authoritative.
4. The new member sees their member ID and pending status; server guards protected actions. The browser's `pendingView` is only UX, **not security**.
5. Authorized Admin/Superadmin uses a pending registration list to approve or reject; server validates the admin LINE ID token and shop-scoped role, writes audit record, and transitions status atomically.
6. Repeat logins: Active enters normally; Pending remains pending; Rejected/Inactive displays a suitable message. Existing Active users are not changed.
7. On approval, client can poll status safely or refresh to activate. Never approve automatically on topup attempt.

## Guard rails before deployment
- Add a shop-scoped membership sequence/unique constraint (do not use `count()+1`); check existing data and collisions before migration.
- If multi-shop LINE membership is required, redesign `users` key and all dependent foreign keys first. Do not attempt a quick primary key update.
- Define how currently existing admin accounts authenticate given RLS with no policies; prefer a separate authenticated Edge Function using verified LINE ID token.
- Add server authorization on **every** protected operation, not just the first page view.
- Rate limit registrations, prevent replay/repeated approval, and log requester/approver/time without exposing LINE access credentials.
- Never ship service-role secrets, LINE channel secrets, or LINE OA tokens to GitHub Pages.
- Do not alter original `index.html`, `admin.html`, or Supabase production tables without an explicit migration/review. This document alone does not activate gating.

## Testing
- First login creates exactly one Pending member; concurrent registrations obtain distinct member IDs.
- Reopen while Pending -> same ID; protected routes remain denied.
- Only same-shop authorized admin can approve/reject, and requests are audited.
- Existing Active member still enters without new approval.
- Unauthorized browser request to update `users.status` directly fails.
- No notification of another shop's membership is leaked.
