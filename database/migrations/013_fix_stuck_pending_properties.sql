-- One-time data repair, not a schema change (so it isn't folded into
-- schema.sql). Fixes two related bugs from the original company-review
-- design, both corrected in the same tranche as this migration:
--
--   1. Property.companyApprove() used to set a company-approved
--      listing's status to 'pending' (an admin-review queue) instead
--      of publishing it -- so a listing a company had already approved
--      never actually went live.
--   2. A company listing its own property (not through an agent) used
--      to land at 'pending' too, on the same mistaken assumption that
--      admin does a second review pass. Admin never vets individual
--      listings -- only companies (see the Sep 2026 correction) -- so
--      that stage never should have existed.
--
-- Anything currently sitting at status='pending' is stuck for exactly
-- one of those two reasons -- there is no other way to land there any
-- more -- so it's safe to publish all of it here in one pass.
UPDATE properties
SET status = 'approved',
    approved_at = COALESCE(approved_at, NOW()),
    rejection_reason = NULL
WHERE status = 'pending' AND deleted_at IS NULL;
