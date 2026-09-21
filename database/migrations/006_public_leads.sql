-- Migration 006: public leads (newsletter subscribers + landing-page
-- contact messages).
--
-- Joan: "the forms in http://localhost:5173/ the landing page are not
-- working." Root cause: the homepage's "Say Hello to HouseBank" contact
-- form and the footer's newsletter signup form both only ever called
-- console.log() -- no backend endpoint existed for either, so nothing a
-- visitor typed went anywhere. Both are anonymous/public forms (no
-- signed-in user), so they can't reuse the customer-only
-- POST /messages/contact-company path -- these are two new, narrow,
-- unauthenticated tables instead.
--
-- Apply with: mysql -u <user> -p <database> < 006_public_leads.sql

SET FOREIGN_KEY_CHECKS = 0;

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

SET FOREIGN_KEY_CHECKS = 1;
