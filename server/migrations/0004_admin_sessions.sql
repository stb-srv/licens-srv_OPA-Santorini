-- 004_admin_sessions.sql
CREATE TABLE IF NOT EXISTS admin_sessions (
    id             CHAR(36)     NOT NULL PRIMARY KEY,
    admin_username VARCHAR(128) NOT NULL,
    token_hash     CHAR(64)     NOT NULL UNIQUE,
    ip             VARCHAR(64)  DEFAULT NULL,
    user_agent     VARCHAR(512) DEFAULT NULL,
    revoked        TINYINT(1)   NOT NULL DEFAULT 0,
    expires_at     DATETIME     NOT NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_token_hash (token_hash),
    INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
