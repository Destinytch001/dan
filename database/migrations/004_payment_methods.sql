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
