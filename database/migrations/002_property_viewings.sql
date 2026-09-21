-- Migration: property viewings
--
-- Correction to the buy/rent design added earlier this session: HouseBank
-- doesn't do self-service checkout. The real flow is: a customer books a
-- property for a viewing with an agent, the buy/rent/sale process then
-- happens in person at the office, the company approves it, and only then
-- does the customer's profile get updated (via property_purchases /
-- property_rentals, whose POST / endpoint is now staff-initiated — see
-- the accompanying code changes). This table is the customer-initiated
-- half of that flow: requesting a viewing.
--
-- Run once against each database that already has the rest of the schema:
--   mysql -u <db_user> -p <db_name> < database/migrations/002_property_viewings.sql

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
    scheduled_at        DATETIME        NULL,          -- staff-confirmed date/time, may differ from preferred
    handled_by          BIGINT UNSIGNED NULL,          -- staff who confirmed/completed it
    created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_property_viewings_customer FOREIGN KEY (customer_user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_property_viewings_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
    CONSTRAINT fk_property_viewings_handled_by FOREIGN KEY (handled_by) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_property_viewings_customer (customer_user_id, status),
    INDEX idx_property_viewings_property (property_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
