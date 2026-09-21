-- Migration 007: incident reports (public "Report Neighbourhood
-- Concern" and "Report a Scam" forms).
--
-- Joan: "the form in /report-concern is not working or submitting to
-- the company. this /report-scam is not submitting to the overall
-- admin." Both pages had real-looking forms with a Send Message button
-- that only called console.log() -- no backend endpoint existed for
-- either. One table, discriminated by `type`, since the two forms are
-- ~90% the same shape (anonymous reporter contact info + a description
-- + admin visibility) -- the scam-specific fields (accused person's
-- details, whether money was lost, how much) and the concern-specific
-- field (which company it's about) are just nullable columns rather
-- than two near-duplicate tables.
--
-- Apply with: mysql -u <user> -p <database> < 007_incident_reports.sql

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE incident_reports (
    id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    type                ENUM('neighbourhood_concern','scam') NOT NULL,
    company_id          BIGINT UNSIGNED NULL,        -- concern reports only: which company this is about, if the reporter named one
    reporter_full_name  VARCHAR(150)    NULL,
    reporter_email      VARCHAR(191)    NULL,
    reporter_phone      VARCHAR(30)     NULL,
    incident_date       DATE            NULL,
    description         TEXT            NOT NULL,
    scammer_name        VARCHAR(150)    NULL,        -- scam reports only
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

SET FOREIGN_KEY_CHECKS = 1;
