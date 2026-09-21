-- Migration 012: property moderation -- flag/block a listing, and a
-- company-side appeal against a block (Joan, Sep 2026: "admin also can
-- manage properties, flag a property if theres an issue, block a
-- property in which the company will/must appeal").
--
-- Flag is a soft, internal marker: it does NOT remove the listing from
-- public view, it just records that admin raised a concern and notifies
-- whoever listed it. Block is hard: it changes status so the listing
-- drops out of every public-facing query (searchApproved only ever
-- returns status = 'approved'), and reinstatement can only happen
-- through the new property_appeals workflow below -- there's no
-- separate "unblock" button admin can click without an appeal to
-- resolve, by design, so a block always leaves a paper trail of why it
-- was lifted.
--
-- Safe to run once. Re-running will fail on the duplicate columns /
-- table -- that's expected.

ALTER TABLE properties
  MODIFY COLUMN status ENUM('draft','pending_company_review','pending','approved','rejected','sold','rented','archived','blocked') NOT NULL DEFAULT 'draft',
  ADD COLUMN flagged_at    DATETIME        NULL AFTER rejection_reason,
  ADD COLUMN flag_reason   VARCHAR(255)    NULL AFTER flagged_at,
  ADD COLUMN flagged_by    BIGINT UNSIGNED NULL AFTER flag_reason,
  ADD COLUMN blocked_at    DATETIME        NULL AFTER flagged_by,
  ADD COLUMN blocked_reason VARCHAR(255)   NULL AFTER blocked_at,
  ADD COLUMN blocked_by    BIGINT UNSIGNED NULL AFTER blocked_reason,
  ADD CONSTRAINT fk_properties_flagged_by FOREIGN KEY (flagged_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_properties_blocked_by FOREIGN KEY (blocked_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE property_appeals (
    id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    property_id           BIGINT UNSIGNED NOT NULL,
    submitted_by_user_id  BIGINT UNSIGNED NOT NULL,   -- the company/realtor appealing the block
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
