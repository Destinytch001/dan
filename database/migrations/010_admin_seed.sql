-- Migration 010: seed one real admin account.
--
-- No migration or the base schema.sql has ever created an admin user --
-- confirmed by grepping the whole backend for an admin INSERT before
-- writing this. There was genuinely no way to sign in as admin at all.
--
-- This inserts exactly one admin account, using the email Joan asked
-- this account to be reachable at (dantechhubict@gmail.com) so that
-- address is the one that can sign in and check progress as overall
-- admin. status is 'active' and email_verified_at is set directly
-- (bypassing the normal signup-OTP flow, which doesn't apply to a
-- seeded account), so it can sign in immediately with no extra
-- verification step.
--
-- The password hash below is a bcrypt hash (cost 12, matching
-- src/models/User.js's own bcrypt.hash(password, 12) call) of a
-- randomly generated 20-character password -- never a guessable
-- default. The plaintext password is NOT stored anywhere in this repo
-- or in the database; it was given to Joan directly in chat. Change it
-- any time via Forgot Password on the sign-in screen (once outbound
-- mail is working -- see the OTP/SMTP section of the project status
-- doc) or by asking for a fresh migration to rotate the hash.
--
-- Safe to run once. Re-running will fail on users.email's unique
-- constraint -- that's expected, it means the admin account already
-- exists.

INSERT INTO users (uuid, email, phone, password_hash, role, status, email_verified_at)
VALUES (
  '9528cd65-bef4-44cd-b0c6-4554e7623529',
  'dantechhubict@gmail.com',
  NULL,
  '$2a$12$Lu/QxoqMY3aObZk5ISi5q./2w6wwaoYoZPZRGQl8WEERNgkhEM1wK',
  'admin',
  'active',
  NOW()
);
