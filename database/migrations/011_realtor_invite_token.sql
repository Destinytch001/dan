-- Migration 011: give each company-agent invite a unique token, so an
-- invited realtor can get a real, direct onboarding link (Joan, Sep
-- 2026: "once they are invited, they should get an onboarding link to
-- their own signup page, that will also show the company they are
-- signing up with in details") instead of the previous flow, which had
-- no per-invite link at all -- just an email address recorded, matched
-- against whatever the invited person happened to type into the
-- generic, publicly-reachable /signup-buyer form.
--
-- Nullable + backfilled rather than NOT NULL from the start, since any
-- invite rows created before this migration (there may be none yet in
-- a fresh dev database, but this must still be correct against a
-- database that already has invites) have no token to have generated.
-- UUID() without its dashes gives a random-enough 32-hex-char backfill
-- value; every new invite going forward gets a real
-- crypto.randomBytes(24) token from CompanyAgentInvite.js instead.
--
-- Safe to run once. Re-running will fail on the duplicate column /
-- unique index -- that's expected.

ALTER TABLE company_agent_invites
  ADD COLUMN token VARCHAR(64) NULL UNIQUE AFTER email;

UPDATE company_agent_invites
  SET token = REPLACE(UUID(), '-', '')
  WHERE token IS NULL;
