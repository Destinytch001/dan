-- Migration 014: admin profile picture (Joan, Sep 2026: "admin should
-- also be able to edit their profile image too that when uploaded will
-- show on the header and wont clash with other users profile image").
--
-- Every other role stores its avatar on its own profile table
-- (customer_profiles.avatar_path, agent_profiles.avatar_path,
-- companies.logo_path) -- admin has no profile table at all (see
-- User.getDisplayName()'s admin branch, and GET /profile/me's old
-- "admin: no profile table exists for this role" comment). Rather than
-- inventing a whole admin_profiles table for a single column, this adds
-- avatar_path directly onto users -- the one table every role,
-- including admin, already has exactly one row in.
--
-- The "won't clash with other users' profile image" half of the request
-- was already solved in an earlier tranche: AuthContext resets the
-- entire RTK Query cache (houseBankApi.util.resetApiState()) on every
-- sign-in and sign-out, so GET /profile/me is always re-fetched fresh
-- per account -- this column just gives admin's fetch something real to
-- return instead of null.
--
-- Safe to run once. Re-running will fail on the duplicate column --
-- that's expected.
-- Apply with: mysql -u <user> -p <database> < 014_admin_avatar.sql

ALTER TABLE users
  ADD COLUMN avatar_path VARCHAR(255) NULL AFTER phone;
