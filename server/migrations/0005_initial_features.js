/**
 * 0001_initial_features.js
 * Erstellt alle Tabellen und Spalten die durch die Feature-Updates benötigt werden.
 * Idempotent: prüft ob Spalten/Tabellen bereits existieren.
 *
 * @param {import('mysql2/promise').Connection} conn
 */
export default async function (conn) {

    // 1. admin_sessions — Token-Blacklist für Admin-Logout
    await conn.query(`
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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 2. customer_sessions — Portal Sessions
    await conn.query(`
        CREATE TABLE IF NOT EXISTS customer_sessions (
            id          CHAR(36)     NOT NULL PRIMARY KEY,
            customer_id CHAR(36)     NOT NULL,
            token_hash  CHAR(64)     NOT NULL UNIQUE,
            ip          VARCHAR(64)  DEFAULT NULL,
            user_agent  VARCHAR(512) DEFAULT NULL,
            revoked     TINYINT(1)   NOT NULL DEFAULT 0,
            expires_at  DATETIME     NOT NULL,
            created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_token_hash (token_hash),
            INDEX idx_expires_at (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 3. schema_migrations — wird vom Migrationssystem selbst verwaltet
    await conn.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INT          NOT NULL PRIMARY KEY,
            name       VARCHAR(255) NOT NULL,
            applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 4. licenses.expiry_notified_at — verhindert doppelte Ablauf-Emails
    const [[{ n: hasExpiryCol }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'licenses' AND COLUMN_NAME = 'expiry_notified_at'
    `);
    if (!hasExpiryCol) {
        await conn.query(`
            ALTER TABLE licenses
            ADD COLUMN expiry_notified_at DATETIME NULL DEFAULT NULL
            COMMENT 'Letzte Ablauf-Benachrichtigung. NULL = noch nicht benachrichtigt.'
        `);
    }

    // 5. customers.must_change_password
    const [[{ n: hasMustChange }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'must_change_password'
    `);
    if (!hasMustChange) {
        await conn.query(`
            ALTER TABLE customers
            ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0
            COMMENT '1 = Kunde muss Passwort beim naechsten Login aendern.'
        `);
    }

    // 6. customers.portal_username
    const [[{ n: hasPortalUsername }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'portal_username'
    `);
    if (!hasPortalUsername) {
        await conn.query(`
            ALTER TABLE customers
            ADD COLUMN portal_username VARCHAR(128) NULL DEFAULT NULL UNIQUE
            COMMENT 'Auto-generierter Benutzername fuer das Kunden-Portal.'
        `);
    }

    // 7. purchase_history — Kaufhistorie für Kunden-Portal
    await conn.query(`
        CREATE TABLE IF NOT EXISTS purchase_history (
            id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
            customer_id CHAR(36)     NOT NULL,
            license_key VARCHAR(64)  DEFAULT NULL,
            plan        VARCHAR(32)  DEFAULT NULL,
            action      VARCHAR(64)  NOT NULL,
            amount      DECIMAL(8,2) DEFAULT NULL,
            note        TEXT         DEFAULT NULL,
            created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_customer (customer_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}
