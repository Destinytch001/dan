-- =====================================================================
-- HouseBank Platform — Full Database Schema
-- MySQL 5.7+/8.0 (Namecheap cPanel MySQL)
-- Engine: InnoDB everywhere (FK integrity, row-level locking for money ops)
-- Charset: utf8mb4 (full unicode, emoji-safe for messages/reviews)
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- CORE IDENTITY
-- ---------------------------------------------------------------------

CREATE TABLE users (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid                CHAR(36)        NOT NULL UNIQUE,
    email               VARCHAR(191)    NOT NULL UNIQUE,
    phone               VARCHAR(20)     NULL UNIQUE,
    avatar_path         VARCHAR(255)    NULL,       -- admin only (migration 014); every other role's avatar lives on its own profile table
    password_hash       VARCHAR(255)    NOT NULL,
    role                ENUM('customer','agent','company','admin') NOT NULL,
    status              ENUM('pending_verification','active','suspended','banned') NOT NULL DEFAULT 'pending_verification',
    email_verified_at   DATETIME        NULL,
    phone_verified_at   DATETIME        NULL,
    failed_login_count  TINYINT UNSIGNED NOT NULL DEFAULT 0,
    locked_until        DATETIME        NULL,
    two_factor_enabled_at DATETIME      NULL,       -- email-OTP 2FA (see otp_codes.purpose='login_2fa')
    last_login_at       DATETIME        NULL,
    last_login_ip       VARCHAR(45)     NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at          DATETIME        NULL,
    INDEX idx_users_role_status (role, status),
    INDEX idx_users_deleted_at (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Individual customer / buyer profile
CREATE TABLE customer_profiles (
    user_id         BIGINT UNSIGNED PRIMARY KEY,
    full_name       VARCHAR(150)    NOT NULL,
    avatar_path     VARCHAR(255)    NULL,
    address         VARCHAR(255)    NULL,
    city            VARCHAR(100)    NULL,
    state           VARCHAR(100)    NULL,
    date_of_birth   DATE            NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_customer_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Saved payment methods for customers.
--
-- Deliberately stores ONLY display metadata a card issuer would show
-- back to you after tokenizing a card (brand, last 4 digits, expiry,
-- cardholder name) — there is no column here that could hold a full
-- card number or a CVV, so neither can ever be stored even by mistake.
-- This is "cards on file for reference," not a payment processor; real
-- charge/tokenization still needs Paystack (or similar) wired up per
-- docs/ROADMAP.md before any of this can move real money.
CREATE TABLE customer_payment_methods (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_user_id    BIGINT UNSIGNED NOT NULL,
    card_brand          VARCHAR(30)     NOT NULL,
    last4               CHAR(4)         NOT NULL,
    expiry_month        TINYINT UNSIGNED NOT NULL,
    expiry_year         SMALLINT UNSIGNED NOT NULL,
    cardholder_name     VARCHAR(150)    NOT NULL,
    is_default          TINYINT(1)      NOT NULL DEFAULT 0,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_cpm_customer FOREIGN KEY (customer_user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_cpm_customer (customer_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Registered companies (real-estate firms) — CAC-verified
CREATE TABLE companies (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id                 BIGINT UNSIGNED NOT NULL UNIQUE, -- the company's own login account
    company_name            VARCHAR(191)    NOT NULL,
    company_address         VARCHAR(255)    NULL,
    cac_number              VARCHAR(50)     NOT NULL,
    cac_document_path       VARCHAR(255)    NOT NULL,        -- private storage, gated
    logo_path               VARCHAR(255)    NULL,
    verification_status     ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
    verification_notes      TEXT            NULL,
    verified_by             BIGINT UNSIGNED NULL,
    verified_at             DATETIME        NULL,
    created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_companies_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_companies_verified_by FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_companies_verification (verification_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Individual agent/realtor profile (may or may not belong to a company)
CREATE TABLE agent_profiles (
    user_id                 BIGINT UNSIGNED PRIMARY KEY,
    full_name               VARCHAR(150)    NOT NULL,
    avatar_path             VARCHAR(255)    NULL,
    bio                     TEXT            NULL,
    id_document_path        VARCHAR(255)    NOT NULL,        -- private storage, gated
    verification_status     ENUM('pending','verified','rejected') NOT NULL DEFAULT 'pending',
    verification_notes      TEXT            NULL,
    verified_by             BIGINT UNSIGNED NULL,
    verified_at             DATETIME        NULL,
    company_id              BIGINT UNSIGNED NULL,            -- current company, if attached
    rating_avg              DECIMAL(3,2)    NOT NULL DEFAULT 0.00,
    rating_count            INT UNSIGNED    NOT NULL DEFAULT 0,
    created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_agent_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_agent_profiles_verified_by FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_agent_profiles_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
    INDEX idx_agent_profiles_company (company_id),
    INDEX idx_agent_profiles_verification (verification_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- History of agent <-> company relationships (join/leave/transfer)
CREATE TABLE company_agents (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id      BIGINT UNSIGNED NOT NULL,
    agent_id        BIGINT UNSIGNED NOT NULL,               -- users.id of the agent
    status          ENUM('active','pending','removed','transferred_out') NOT NULL DEFAULT 'pending',
    joined_at       DATETIME        NULL,
    left_at         DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_company_agents_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_company_agents_agent FOREIGN KEY (agent_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_company_agents_company (company_id, status),
    INDEX idx_company_agents_agent (agent_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A company's invites to prospective agents by email, before the agent has
-- an account. POST /auth/signup (role=agent) requires a matching pending
-- row here to exist -- see migrations/005_company_agent_invites.sql.
CREATE TABLE company_agent_invites (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id      BIGINT UNSIGNED NOT NULL,
    email           VARCHAR(191)    NOT NULL,
    token           VARCHAR(64)     NULL UNIQUE,  -- powers the direct onboarding link emailed to the invited realtor
    invited_by      BIGINT UNSIGNED NOT NULL,
    status          ENUM('pending','accepted','revoked','expired') NOT NULL DEFAULT 'pending',
    accepted_by     BIGINT UNSIGNED NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accepted_at     DATETIME        NULL,
    CONSTRAINT fk_cai_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
    CONSTRAINT fk_cai_invited_by FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_cai_accepted_by FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_cai_email_status (email, status),
    INDEX idx_cai_company_status (company_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Agent transfer requests between companies (or to independent)
CREATE TABLE realtor_transfer_requests (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    agent_id            BIGINT UNSIGNED NOT NULL,
    from_company_id     BIGINT UNSIGNED NULL,
    to_company_id       BIGINT UNSIGNED NULL,
    requested_by        BIGINT UNSIGNED NOT NULL,
    status              ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
    reason              VARCHAR(255)    NULL,
    decided_by          BIGINT UNSIGNED NULL,
    decided_at          DATETIME        NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_rtr_agent FOREIGN KEY (agent_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_rtr_from_company FOREIGN KEY (from_company_id) REFERENCES companies(id) ON DELETE SET NULL,
    CONSTRAINT fk_rtr_to_company FOREIGN KEY (to_company_id) REFERENCES companies(id) ON DELETE SET NULL,
    CONSTRAINT fk_rtr_requested_by FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_rtr_decided_by FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- AUTH SUPPORT: OTP, password resets, refresh tokens, rate limiting
-- ---------------------------------------------------------------------

CREATE TABLE otp_codes (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    code_hash       VARCHAR(255)    NOT NULL,   -- never store plaintext OTP
    purpose         ENUM('signup_verification','login_2fa','password_reset','transaction_confirm') NOT NULL,
    attempts        TINYINT UNSIGNED NOT NULL DEFAULT 0,
    expires_at      DATETIME        NOT NULL,
    consumed_at     DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_otp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_otp_user_purpose (user_id, purpose, consumed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Single-use recovery codes for 2FA — a backup when email isn't
-- reachable. Only the bcrypt hash is stored; the plain codes are shown
-- once, at the moment 2FA is enabled (see src/models/TwoFactor.js).
CREATE TABLE user_recovery_codes (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    code_hash   VARCHAR(255)    NOT NULL,
    used_at     DATETIME        NULL,
    created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_recovery_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_recovery_codes_user (user_id, used_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE password_resets (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    token_hash      VARCHAR(255)    NOT NULL,
    expires_at      DATETIME        NOT NULL,
    used_at         DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_pwreset_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_pwreset_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE refresh_tokens (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    token_hash      VARCHAR(255)    NOT NULL,
    user_agent      VARCHAR(255)    NULL,
    ip_address      VARCHAR(45)     NULL,
    expires_at      DATETIME        NOT NULL,
    revoked_at      DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_refresh_user (user_id),
    INDEX idx_refresh_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE rate_limits (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bucket_key      VARCHAR(191)    NOT NULL,   -- e.g. "login:1.2.3.4" or "otp:user:42"
    attempts        INT UNSIGNED    NOT NULL DEFAULT 1,
    window_started_at DATETIME      NOT NULL,
    UNIQUE KEY uq_rate_limit_bucket (bucket_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE audit_logs (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NULL,
    action          VARCHAR(100)    NOT NULL,
    entity_type     VARCHAR(50)     NULL,
    entity_id       BIGINT UNSIGNED NULL,
    ip_address      VARCHAR(45)     NULL,
    user_agent      VARCHAR(255)    NULL,
    meta_json       JSON            NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_action (action),
    INDEX idx_audit_entity (entity_type, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- PROPERTIES
-- ---------------------------------------------------------------------

CREATE TABLE property_types (
    id      SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name    VARCHAR(60) NOT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO property_types (name) VALUES
    ('House'), ('Apartment'), ('Land'), ('Commercial'), ('Duplex'), ('Bungalow'), ('Terrace'), ('Office Space');

CREATE TABLE properties (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid                CHAR(36)        NOT NULL UNIQUE,
    listed_by_user_id   BIGINT UNSIGNED NOT NULL,           -- agent or company account that created it
    company_id          BIGINT UNSIGNED NULL,               -- set if listed under a company
    property_type_id    SMALLINT UNSIGNED NOT NULL,
    listing_type        ENUM('sale','rent','investment') NOT NULL,
    title               VARCHAR(191)    NOT NULL,
    slug                VARCHAR(220)    NOT NULL UNIQUE,
    description         TEXT            NULL,
    price               DECIMAL(15,2)   NOT NULL,
    currency            CHAR(3)         NOT NULL DEFAULT 'NGN',
    bedrooms            TINYINT UNSIGNED NULL,
    bathrooms           TINYINT UNSIGNED NULL,
    size_sqm            DECIMAL(10,2)   NULL,
    address             VARCHAR(255)    NOT NULL,
    city                VARCHAR(100)    NOT NULL,
    state               VARCHAR(100)    NOT NULL,
    latitude            DECIMAL(10,7)   NULL,
    longitude           DECIMAL(10,7)   NULL,
    status              ENUM('draft','pending_company_review','pending','approved','rejected','sold','rented','archived','blocked') NOT NULL DEFAULT 'draft',
    rejection_reason    VARCHAR(255)    NULL,
    flagged_at          DATETIME        NULL,
    flag_reason         VARCHAR(255)    NULL,
    flagged_by          BIGINT UNSIGNED NULL,
    blocked_at          DATETIME        NULL,
    blocked_reason      VARCHAR(255)    NULL,
    blocked_by          BIGINT UNSIGNED NULL,
    approved_by         BIGINT UNSIGNED NULL,
    approved_at         DATETIME        NULL,
    views_count         INT UNSIGNED    NOT NULL DEFAULT 0,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at          DATETIME        NULL,
    CONSTRAINT fk_properties_lister FOREIGN KEY (listed_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_properties_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
    CONSTRAINT fk_properties_type FOREIGN KEY (property_type_id) REFERENCES property_types(id),
    CONSTRAINT fk_properties_approved_by FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_properties_flagged_by FOREIGN KEY (flagged_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_properties_blocked_by FOREIGN KEY (blocked_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_properties_status (status),
    INDEX idx_properties_listing_type (listing_type),
    INDEX idx_properties_lister (listed_by_user_id),
    INDEX idx_properties_city_state (state, city),
    INDEX idx_properties_deleted_at (deleted_at),
    FULLTEXT KEY ft_properties_search (title, description, address)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A company/realtor's appeal against an admin block on their listing
-- (Joan, Sep 2026: "block a property in which the company will/must
-- appeal"). One row per appeal attempt -- a rejected appeal can be
-- followed by a fresh one if new evidence/context is added.
CREATE TABLE property_appeals (
    id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    property_id           BIGINT UNSIGNED NOT NULL,
    submitted_by_user_id  BIGINT UNSIGNED NOT NULL,
    message               TEXT            NOT NULL,
    status                ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    admin_response        VARCHAR(255)    NULL,
    resolved_by           BIGINT UNSIGNED NULL,
    resolved_at           DATETIME        NULL,
    created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_appeals_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    CONSTRAINT fk_appeals_submitter FOREIGN KEY (submitted_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_appeals_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_appeals_property (property_id),
    INDEX idx_appeals_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE property_images (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    property_id     BIGINT UNSIGNED NOT NULL,
    file_path       VARCHAR(255)    NOT NULL,    -- public/uploads/properties/{uuid}.jpg
    is_primary      TINYINT(1)      NOT NULL DEFAULT 0,
    sort_order      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_property_images_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    INDEX idx_property_images_property (property_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE property_documents (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    property_id     BIGINT UNSIGNED NOT NULL,
    doc_type        VARCHAR(60)     NOT NULL,    -- title_deed, survey_plan, c_of_o, etc
    file_path       VARCHAR(255)    NOT NULL,    -- PRIVATE storage/uploads/documents/*, gated
    uploaded_by     BIGINT UNSIGNED NOT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_property_documents_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    CONSTRAINT fk_property_documents_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE wishlists (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    property_id     BIGINT UNSIGNED NOT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_wishlist_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_wishlist_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    UNIQUE KEY uq_wishlist_user_property (user_id, property_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- PROPERTY PURCHASES & RENTALS
--
-- transactions.type has included 'property_purchase' and 'property_rent'
-- since the original schema, and properties.status has always had
-- 'sold'/'rented' as valid values, but these two tables (what those
-- transactions actually reference) weren't created until this pass. See
-- database/migrations/001_property_purchases_rentals.sql for the
-- incremental migration this was first applied as.
-- ---------------------------------------------------------------------

CREATE TABLE property_purchases (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid            CHAR(36)        NOT NULL UNIQUE,
    buyer_user_id   BIGINT UNSIGNED NOT NULL,
    property_id     BIGINT UNSIGNED NOT NULL,
    agreed_price    DECIMAL(15,2)   NOT NULL,
    staff_note      VARCHAR(500)    NULL,
    status          ENUM('requested','declined','pending_payment','processing','completed','cancelled') NOT NULL DEFAULT 'pending_payment',
    completed_at    DATETIME        NULL,
    cancelled_at    DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_property_purchases_buyer FOREIGN KEY (buyer_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_property_purchases_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    INDEX idx_property_purchases_buyer (buyer_user_id, status),
    INDEX idx_property_purchases_property (property_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE property_rentals (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid                CHAR(36)        NOT NULL UNIQUE,
    tenant_user_id      BIGINT UNSIGNED NOT NULL,
    property_id         BIGINT UNSIGNED NOT NULL,
    rent_amount         DECIMAL(15,2)   NOT NULL,
    rent_period_months  SMALLINT UNSIGNED NOT NULL DEFAULT 12,
    staff_note          VARCHAR(500)    NULL,
    lease_start_date    DATE            NULL,
    lease_end_date      DATE            NULL,
    status              ENUM('requested','declined','pending_payment','active','expired','terminated','cancelled') NOT NULL DEFAULT 'pending_payment',
    cancelled_at        DATETIME        NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_property_rentals_tenant FOREIGN KEY (tenant_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_property_rentals_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    INDEX idx_property_rentals_tenant (tenant_user_id, status),
    INDEX idx_property_rentals_property (property_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE property_viewings (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid                CHAR(36)        NOT NULL UNIQUE,
    customer_user_id    BIGINT UNSIGNED NOT NULL,
    property_id         BIGINT UNSIGNED NOT NULL,
    preferred_date      DATE            NOT NULL,
    preferred_time      TIME            NULL,
    full_name           VARCHAR(191)    NOT NULL,
    phone               VARCHAR(20)     NOT NULL,
    message             VARCHAR(500)    NULL,
    status              ENUM('requested','confirmed','completed','cancelled') NOT NULL DEFAULT 'requested',
    scheduled_at        DATETIME        NULL,
    handled_by          BIGINT UNSIGNED NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_property_viewings_customer FOREIGN KEY (customer_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_property_viewings_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    CONSTRAINT fk_property_viewings_handled_by FOREIGN KEY (handled_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_property_viewings_customer (customer_user_id, status),
    INDEX idx_property_viewings_property (property_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- INVESTMENTS
-- ---------------------------------------------------------------------

CREATE TABLE investment_properties (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    property_id             BIGINT UNSIGNED NOT NULL UNIQUE,
    total_target_amount     DECIMAL(15,2)   NOT NULL,
    amount_raised           DECIMAL(15,2)   NOT NULL DEFAULT 0.00,
    min_investment_amount   DECIMAL(15,2)   NOT NULL,
    expected_roi_percent    DECIMAL(5,2)    NOT NULL,
    tenure_months           SMALLINT UNSIGNED NOT NULL,
    status                  ENUM('open','fully_funded','closed','matured') NOT NULL DEFAULT 'open',
    maturity_date           DATE            NULL,
    created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_investment_properties_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE investments (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid                    CHAR(36)        NOT NULL UNIQUE,
    investor_user_id        BIGINT UNSIGNED NOT NULL,
    investment_property_id  BIGINT UNSIGNED NOT NULL,
    amount                  DECIMAL(15,2)   NOT NULL,
    status                  ENUM('pending_payment','active','matured','withdrawn','cancelled') NOT NULL DEFAULT 'pending_payment',
    invested_at             DATETIME        NULL,
    matured_at              DATETIME        NULL,
    created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_investments_investor FOREIGN KEY (investor_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_investments_property FOREIGN KEY (investment_property_id) REFERENCES investment_properties(id) ON DELETE CASCADE,
    INDEX idx_investments_investor (investor_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE investment_withdrawal_requests (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    investment_id   BIGINT UNSIGNED NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    amount          DECIMAL(15,2)   NOT NULL,
    status          ENUM('pending','approved','rejected','paid') NOT NULL DEFAULT 'pending',
    bank_details_json JSON          NULL,
    processed_by    BIGINT UNSIGNED NULL,
    processed_at    DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_iwr_investment FOREIGN KEY (investment_id) REFERENCES investments(id) ON DELETE CASCADE,
    CONSTRAINT fk_iwr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_iwr_processed_by FOREIGN KEY (processed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- SUBSCRIPTIONS
-- ---------------------------------------------------------------------

CREATE TABLE subscription_plans (
    id              SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(80)     NOT NULL,
    price           DECIMAL(12,2)   NOT NULL,
    billing_cycle   ENUM('monthly','yearly') NOT NULL,
    features_json   JSON            NULL,
    is_active       TINYINT(1)      NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE subscriptions (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    plan_id         SMALLINT UNSIGNED NOT NULL,
    status          ENUM('active','cancelled','expired','past_due') NOT NULL DEFAULT 'active',
    started_at      DATETIME        NOT NULL,
    renews_at       DATETIME        NULL,
    cancelled_at    DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
    INDEX idx_subscriptions_user (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- TRANSACTIONS / PAYMENTS  (hybrid: Paystack + manual proof-of-payment)
-- ---------------------------------------------------------------------

CREATE TABLE transactions (
    id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid                    CHAR(36)        NOT NULL UNIQUE,
    user_id                 BIGINT UNSIGNED NOT NULL,
    type                    ENUM('property_purchase','property_rent','investment','subscription','investment_withdrawal','agent_payout','refund') NOT NULL,
    reference_table         VARCHAR(50)     NULL,     -- e.g. 'properties', 'investments', 'subscriptions'
    reference_id            BIGINT UNSIGNED NULL,
    amount                  DECIMAL(15,2)   NOT NULL,
    currency                CHAR(3)         NOT NULL DEFAULT 'NGN',
    payment_method          ENUM('paystack','manual_transfer') NOT NULL,
    paystack_reference      VARCHAR(100)    NULL UNIQUE,
    proof_of_payment_path   VARCHAR(255)    NULL,      -- PRIVATE storage, gated; for manual_transfer
    status                  ENUM('pending','processing','success','failed','refunded') NOT NULL DEFAULT 'pending',
    verified_by             BIGINT UNSIGNED NULL,      -- admin/company who verified a manual transfer
    verified_at             DATETIME        NULL,
    failure_reason          VARCHAR(255)    NULL,
    created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_transactions_verified_by FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_transactions_user (user_id, status),
    INDEX idx_transactions_type (type),
    INDEX idx_transactions_reference (reference_table, reference_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Paystack webhook events, stored raw for audit + idempotency
CREATE TABLE payment_webhook_events (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    provider        VARCHAR(30)     NOT NULL DEFAULT 'paystack',
    event_type      VARCHAR(60)     NOT NULL,
    reference       VARCHAR(100)    NULL,
    payload_json    JSON            NOT NULL,
    processed_at    DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_webhook_provider_ref_event (provider, reference, event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- MESSAGING & NOTIFICATIONS
-- ---------------------------------------------------------------------

CREATE TABLE conversations (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    subject             VARCHAR(191)    NULL,
    related_property_id BIGINT UNSIGNED NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_conversations_property FOREIGN KEY (related_property_id) REFERENCES properties(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE conversation_participants (
    conversation_id     BIGINT UNSIGNED NOT NULL,
    user_id             BIGINT UNSIGNED NOT NULL,
    last_read_at        DATETIME        NULL,
    PRIMARY KEY (conversation_id, user_id),
    CONSTRAINT fk_cp_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_cp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE messages (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    conversation_id BIGINT UNSIGNED NOT NULL,
    sender_id       BIGINT UNSIGNED NOT NULL,
    body            TEXT            NOT NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_messages_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_messages_conversation (conversation_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE notifications (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT UNSIGNED NOT NULL,
    type            VARCHAR(60)     NOT NULL,
    title           VARCHAR(191)    NOT NULL,
    body            VARCHAR(500)    NULL,
    data_json       JSON            NULL,
    is_read         TINYINT(1)      NOT NULL DEFAULT 0,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_notifications_user (user_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- REVIEWS, DISPUTES/REPORTS
-- ---------------------------------------------------------------------

CREATE TABLE reviews (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    reviewer_user_id    BIGINT UNSIGNED NOT NULL,
    reviewee_type       ENUM('agent','company','property') NOT NULL,
    reviewee_id         BIGINT UNSIGNED NOT NULL,
    rating              TINYINT UNSIGNED NOT NULL,
    comment             TEXT            NULL,
    status              ENUM('visible','hidden','flagged') NOT NULL DEFAULT 'visible',
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reviews_reviewer FOREIGN KEY (reviewer_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5),
    INDEX idx_reviews_reviewee (reviewee_type, reviewee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE disputes (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid                CHAR(36)        NOT NULL UNIQUE,
    raised_by_user_id   BIGINT UNSIGNED NOT NULL,
    against_user_id     BIGINT UNSIGNED NULL,
    property_id         BIGINT UNSIGNED NULL,
    category            ENUM('report_tenant','report_agent','report_scam','report_concern','general_dispute') NOT NULL,
    description         TEXT            NOT NULL,
    evidence_path        VARCHAR(255)   NULL,           -- PRIVATE storage, gated
    status              ENUM('open','investigating','resolved','dismissed') NOT NULL DEFAULT 'open',
    resolution_notes    TEXT            NULL,
    resolved_by         BIGINT UNSIGNED NULL,
    resolved_at         DATETIME        NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_disputes_raised_by FOREIGN KEY (raised_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_disputes_against FOREIGN KEY (against_user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_disputes_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE SET NULL,
    CONSTRAINT fk_disputes_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_disputes_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- CONTENT / CMS  (blog, help center, testimonials, static pages)
-- Required because "everything should come from the db" — no hardcoded copy.
-- ---------------------------------------------------------------------

CREATE TABLE blog_posts (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    author_id       BIGINT UNSIGNED NULL,
    title           VARCHAR(191)    NOT NULL,
    slug            VARCHAR(220)    NOT NULL UNIQUE,
    excerpt         VARCHAR(500)    NULL,
    content_html    LONGTEXT        NOT NULL,
    cover_image_path VARCHAR(255)   NULL,
    status          ENUM('draft','published') NOT NULL DEFAULT 'draft',
    published_at    DATETIME        NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_blog_posts_author FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_blog_posts_status (status, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE help_topics (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    category        VARCHAR(80)     NOT NULL,
    question        VARCHAR(255)    NOT NULL,
    answer          TEXT            NOT NULL,
    sort_order      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    is_active       TINYINT(1)      NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE testimonials (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(150)    NOT NULL,
    role            VARCHAR(100)    NULL,
    avatar_path     VARCHAR(255)    NULL,
    rating          TINYINT UNSIGNED NOT NULL DEFAULT 5,
    quote           TEXT            NOT NULL,
    is_featured     TINYINT(1)      NOT NULL DEFAULT 0,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE static_pages (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    slug            VARCHAR(100)    NOT NULL UNIQUE,  -- 'privacy-policy', 'anti-discrimination', etc.
    title           VARCHAR(191)    NOT NULL,
    content_html    LONGTEXT        NOT NULL,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- PUBLIC LEADS  (anonymous landing-page forms: newsletter + contact)
-- Migration: 006_public_leads.sql
-- ---------------------------------------------------------------------

CREATE TABLE newsletter_subscribers (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    email           VARCHAR(191)    NOT NULL UNIQUE,
    source          VARCHAR(50)     NOT NULL DEFAULT 'homepage_footer',
    subscribed_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    unsubscribed_at DATETIME        NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE contact_messages (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    full_name       VARCHAR(150)    NOT NULL,
    email           VARCHAR(191)    NOT NULL,
    message         TEXT            NOT NULL,
    status          ENUM('new','read') NOT NULL DEFAULT 'new',
    ip_address      VARCHAR(45)     NULL,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_contact_messages_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- INCIDENT REPORTS  (public "Report Neighbourhood Concern" + "Report a Scam")
-- Migration: 007_incident_reports.sql
-- ---------------------------------------------------------------------

CREATE TABLE incident_reports (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    type                ENUM('neighbourhood_concern','scam') NOT NULL,
    company_id          BIGINT UNSIGNED NULL,
    reporter_full_name  VARCHAR(150)    NULL,
    reporter_email      VARCHAR(191)    NULL,
    reporter_phone      VARCHAR(30)     NULL,
    incident_date       DATE            NULL,
    description         TEXT            NOT NULL,
    scammer_name        VARCHAR(150)    NULL,
    scammer_email       VARCHAR(191)    NULL,
    scammer_phone       VARCHAR(30)     NULL,
    money_lost          TINYINT(1)      NULL,
    amount_lost         DECIMAL(15,2)   NULL,
    status              ENUM('new','reviewing','resolved') NOT NULL DEFAULT 'new',
    ip_address          VARCHAR(45)     NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_incident_reports_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL,
    INDEX idx_incident_reports_type_status (type, status, created_at),
    INDEX idx_incident_reports_company (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- PAGE CONTENT ITEMS  (generic, admin-editable marketing/landing-page copy)
-- Migration: 015_page_content.sql
-- Covers About, Services, Realtor landing, Property Management landing,
-- and the two homepage sections that used to be 100% hardcoded JSX.
-- ---------------------------------------------------------------------

CREATE TABLE page_content_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  page VARCHAR(60) NOT NULL,
  section VARCHAR(80) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  icon VARCHAR(60) NULL,
  image_path VARCHAR(500) NULL,
  title VARCHAR(255) NULL,
  subtitle VARCHAR(255) NULL,
  description TEXT NULL,
  extra JSON NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_page_content_page (page),
  INDEX idx_page_content_page_section (page, section, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
