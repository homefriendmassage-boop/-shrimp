-- READ ONLY: inspect candidates; do not expose line_uid or LINE ID tokens in screenshots.
SELECT id AS application_id, member_id, shop_id, display_name, state, requested_at
FROM public.membership_applications
WHERE shop_id='SHOP_001'
ORDER BY requested_at DESC
LIMIT 30;

-- After confirming which application belongs to the STORE OWNER/ADMIN,
-- replace the placeholder with that application's id and execute ONLY this INSERT.
-- Do not grant rights merely because someone is the first signup.
-- INSERT INTO public.membership_admins(shop_id,line_uid)
-- SELECT shop_id,line_uid FROM public.membership_applications
-- WHERE id='REPLACE_WITH_VERIFIED_OWNER_APPLICATION_UUID'::uuid AND shop_id='SHOP_001'
-- ON CONFLICT (shop_id,line_uid) DO NOTHING;

-- VERIFY (no UID disclosure)
SELECT shop_id, COUNT(*) AS reviewer_accounts FROM public.membership_admins GROUP BY shop_id;
