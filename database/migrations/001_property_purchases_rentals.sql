-- Migration: property purchases & rentals
--
-- The original schema.sql already anticipated these two flows —
-- transactions.type has included 'property_purchase' and 'property_rent'
-- since the very first migration, and properties.status has always had
-- 'sold' and 'rented' as valid values — but the tables a purchase or
-- rental actually lives in were never created. This adds them.
--
-- Run this once against each database that already has the rest of the
-- HouseBank schema applied (local dev now; the Namecheap production DB
-- whenever this goes live):
--   mysql -u <db_user> -p <db_name> < database/migrations/001_property_purchases_rentals.sql

CREATE TABLE property_purchases (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid            CHAR(36)        NOT NULL UNIQUE,
    buyer_user_id   BIGINT UNSIGNED NOT NULL,
    property_id     BIGINT UNSIGNED NOT NULL,
    agreed_price    DECIMAL(15,2)   NOT NULL,          -- frozen from properties.price at intent time
    status          ENUM('pending_payment','processing','completed','cancelled') NOT NULL DEFAULT 'pending_payment',
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
    rent_amount         DECIMAL(15,2)   NOT NULL,      -- monthly rent, frozen from properties.price at intent time
    rent_period_months  SMALLINT UNSIGNED NOT NULL DEFAULT 12,
    lease_start_date    DATE            NULL,           -- set when the rental is confirmed
    lease_end_date      DATE            NULL,           -- lease_start_date + rent_period_months
    status              ENUM('pending_payment','active','expired','terminated','cancelled') NOT NULL DEFAULT 'pending_payment',
    cancelled_at        DATETIME        NULL,
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_property_rentals_tenant FOREIGN KEY (tenant_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_property_rentals_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    INDEX idx_property_rentals_tenant (tenant_user_id, status),
    INDEX idx_property_rentals_property (property_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
