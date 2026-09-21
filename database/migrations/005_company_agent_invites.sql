CREATE TABLE company_agent_invites (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    company_id      BIGINT UNSIGNED NOT NULL,
    email           VARCHAR(191)    NOT NULL,
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
