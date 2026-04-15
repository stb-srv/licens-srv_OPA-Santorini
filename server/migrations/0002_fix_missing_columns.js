/**
 * 0002_fix_missing_columns.js
 * Ergänzt alle fehlenden Spalten und Tabellen die durch Code-Updates benötigt werden.
 * Idempotent: prüft vor jedem ALTER ob Spalte/Tabelle bereits existiert.
 */
export default async function (conn) {

    // ── 1. purchase_history — id als CHAR(36) UUID + created_by Spalte ──────────
    // Tabelle ggf. neu erstellen falls id noch INT ist
    const [[{ n: phExists }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_history'
    `);
    if (phExists) {
        // Prüfen ob id ein INT ist (falsch) oder CHAR (korrekt)
        const [[idCol]] = await conn.query(`
            SELECT DATA_TYPE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_history' AND COLUMN_NAME = 'id'
        `);
        if (idCol && idCol.DATA_TYPE === 'int') {
            // Tabelle hat falschen Typ — umbenennen und neu anlegen
            await conn.query(`RENAME TABLE purchase_history TO purchase_history_old`);
            await conn.query(`
                CREATE TABLE purchase_history (
                    id          CHAR(36)     NOT NULL PRIMARY KEY,
                    customer_id CHAR(36)     NOT NULL,
                    license_key VARCHAR(64)  DEFAULT NULL,
                    plan        VARCHAR(32)  DEFAULT NULL,
                    action      VARCHAR(64)  NOT NULL DEFAULT 'purchase',
                    amount      DECIMAL(8,2) DEFAULT NULL,
                    note        TEXT         DEFAULT NULL,
                    created_by  VARCHAR(128) DEFAULT NULL,
                    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_customer (customer_id),
                    INDEX idx_license  (license_key)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            `);
            // Alte Daten migrieren (id wird neu generiert via UUID)
            await conn.query(`
                INSERT INTO purchase_history (id, customer_id, license_key, plan, action, amount, note, created_at)
                SELECT UUID(), customer_id, license_key, plan, action, amount, note, created_at
                FROM purchase_history_old
            `);
            await conn.query(`DROP TABLE purchase_history_old`);
            console.log('  ✅ purchase_history: id auf CHAR(36) migriert');
        }
    } else {
        await conn.query(`
            CREATE TABLE purchase_history (
                id          CHAR(36)     NOT NULL PRIMARY KEY,
                customer_id CHAR(36)     NOT NULL,
                license_key VARCHAR(64)  DEFAULT NULL,
                plan        VARCHAR(32)  DEFAULT NULL,
                action      VARCHAR(64)  NOT NULL DEFAULT 'purchase',
                amount      DECIMAL(8,2) DEFAULT NULL,
                note        TEXT         DEFAULT NULL,
                created_by  VARCHAR(128) DEFAULT NULL,
                created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_customer (customer_id),
                INDEX idx_license  (license_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        console.log('  ✅ purchase_history: neu erstellt');
    }

    // created_by Spalte ergänzen falls fehlend
    const [[{ n: hasCreatedBy }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_history' AND COLUMN_NAME = 'created_by'
    `);
    if (!hasCreatedBy) {
        await conn.query(`ALTER TABLE purchase_history ADD COLUMN created_by VARCHAR(128) DEFAULT NULL`);
        console.log('  ✅ purchase_history.created_by hinzugefügt');
    }

    // ── 2. customers.portal_token ────────────────────────────────────────────────
    const [[{ n: hasPortalToken }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'portal_token'
    `);
    if (!hasPortalToken) {
        await conn.query(`
            ALTER TABLE customers
            ADD COLUMN portal_token         VARCHAR(128) NULL DEFAULT NULL,
            ADD COLUMN portal_token_expires DATETIME     NULL DEFAULT NULL
        `);
        console.log('  ✅ customers.portal_token / portal_token_expires hinzugefügt');
    }

    // ── 3. customers.password_hash ───────────────────────────────────────────────
    const [[{ n: hasPasswordHash }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'password_hash'
    `);
    if (!hasPasswordHash) {
        await conn.query(`
            ALTER TABLE customers
            ADD COLUMN password_hash VARCHAR(255) NULL DEFAULT NULL
            COMMENT 'Bcrypt-Hash des Kunden-Portal-Passworts'
        `);
        console.log('  ✅ customers.password_hash hinzugefügt');
    }

    // ── 4. devices.deactivated_at ────────────────────────────────────────────────
    const [[{ n: hasDeactivatedAt }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'devices' AND COLUMN_NAME = 'deactivated_at'
    `);
    if (!hasDeactivatedAt) {
        await conn.query(`
            ALTER TABLE devices
            ADD COLUMN deactivated_at DATETIME NULL DEFAULT NULL
            COMMENT 'Zeitpunkt der Deaktivierung'
        `);
        console.log('  ✅ devices.deactivated_at hinzugefügt');
    }

    // ── 5. audit_log Tabelle ─────────────────────────────────────────────────────
    await conn.query(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id       CHAR(36)     NOT NULL PRIMARY KEY,
            actor    VARCHAR(128) NOT NULL DEFAULT 'system',
            action   VARCHAR(128) NOT NULL,
            details  TEXT         DEFAULT NULL,
            ts       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_action (action),
            INDEX idx_ts     (ts)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Falls Tabelle existiert aber 'details' Spalte fehlt (alte Version hat 'data')
    const [[{ n: hasDetails }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME = 'details'
    `);
    if (!hasDetails) {
        const [[{ n: hasData }]] = await conn.query(`
            SELECT COUNT(*) AS n FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME = 'data'
        `);
        if (hasData) {
            // 'data' → 'details' umbenennen
            await conn.query(`ALTER TABLE audit_log CHANGE COLUMN \`data\` details TEXT DEFAULT NULL`);
            console.log('  ✅ audit_log.data → details umbenannt');
        } else {
            await conn.query(`ALTER TABLE audit_log ADD COLUMN details TEXT DEFAULT NULL`);
            console.log('  ✅ audit_log.details hinzugefügt');
        }
    }
    // created_at Alias für ts (falls ts nicht existiert)
    const [[{ n: hasTs }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME = 'ts'
    `);
    if (!hasTs) {
        const [[{ n: hasCreatedAt }]] = await conn.query(`
            SELECT COUNT(*) AS n FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME = 'created_at'
        `);
        if (!hasCreatedAt) {
            await conn.query(`ALTER TABLE audit_log ADD COLUMN ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`);
            console.log('  ✅ audit_log.ts hinzugefügt');
        }
    }

    // ── 6. smtp_config Tabelle ───────────────────────────────────────────────────
    await conn.query(`
        CREATE TABLE IF NOT EXISTS smtp_config (
            id         INT          NOT NULL PRIMARY KEY DEFAULT 1,
            host       VARCHAR(255) NOT NULL,
            port       VARCHAR(10)  NOT NULL DEFAULT '587',
            secure     VARCHAR(10)  NOT NULL DEFAULT 'false',
            smtp_user  VARCHAR(255) NOT NULL,
            smtp_pass  VARCHAR(255) NOT NULL,
            smtp_from  VARCHAR(255) DEFAULT NULL,
            created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('  ✅ smtp_config sichergestellt');

    // ── 7. webhooks Tabelle ──────────────────────────────────────────────────────
    await conn.query(`
        CREATE TABLE IF NOT EXISTS webhooks (
            id         INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
            url        VARCHAR(512) NOT NULL,
            secret     VARCHAR(255) DEFAULT NULL,
            events     TEXT         DEFAULT NULL,
            active     TINYINT(1)   NOT NULL DEFAULT 1,
            created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('  ✅ webhooks sichergestellt');

    // ── 8. licenses.validated_domains ───────────────────────────────────────────
    const [[{ n: hasValidatedDomains }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'licenses' AND COLUMN_NAME = 'validated_domains'
    `);
    if (!hasValidatedDomains) {
        await conn.query(`
            ALTER TABLE licenses
            ADD COLUMN validated_domains JSON NOT NULL DEFAULT ('[]')
        `);
        console.log('  ✅ licenses.validated_domains hinzugefügt');
    }

    // ── 9. licenses.analytics_daily / analytics_features ────────────────────────
    const [[{ n: hasAnalyticsDaily }]] = await conn.query(`
        SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'licenses' AND COLUMN_NAME = 'analytics_daily'
    `);
    if (!hasAnalyticsDaily) {
        await conn.query(`
            ALTER TABLE licenses
            ADD COLUMN analytics_daily    JSON NOT NULL DEFAULT ('{}'),
            ADD COLUMN analytics_features JSON NOT NULL DEFAULT ('{}')
        `);
        console.log('  ✅ licenses.analytics_daily / analytics_features hinzugefügt');
    }
}
