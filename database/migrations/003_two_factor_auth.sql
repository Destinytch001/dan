-- Migration: two-factor authentication (TOTP)
--
-- Adds an encrypted TOTP secret + enabled flag to users, and a table of
-- single-use bcrypt-hashed recovery codes for when someone loses their
-- authenticator device. See src/utils/twoFactor.js and the /auth/2fa/*
-- routes in src/modules/auth/auth.routes.js for how these are used.
--
-- Run once against each database that already has the rest of the schema:
--   mysql -u <db_user> -p <db_name> < database/migrations/003_two_factor_auth.sql

ALTER TABLE users
    ADD COLUMN two_factor_secret_encrypted TEXT     NULL AFTER locked_until,
    ADD COLUMN two_factor_enabled_at       DATETIME NULL AFTER two_factor_secret_encrypted;

CREATE TABLE user_recovery_codes (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    code_hash   VARCHAR(255)    NOT NULL,
    used_at     DATETIME        NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_recovery_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_recovery_codes_user (user_id, used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
