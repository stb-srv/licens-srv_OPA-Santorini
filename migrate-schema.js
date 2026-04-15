#!/usr/bin/env node
/**
 * migrate-schema.js — OPA Santorini Lizenzserver
 * Erstellt alle fehlenden Tabellen & Spalten, räumt abgelaufene Sessions auf.
 * Sicher wiederholbar — bestehende Daten werden NICHT verändert.
 *
 * Ausführen:
 *   node migrate-schema.js
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';

const db = await mysql.createConnection({
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASS     || '',
    database: process.env.DB_NAME     || 'opa_licenses',
    multipleStatements: true
});

const G = (s) => `\x1b[32m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const D = (s) => `\x1b[2m${s}\x1b[0m`;

console.log('\n\x1b[1m📦  OPA Santorini — Schema-Migration\x1b[0m\n');

async function run(label, sql) {
    try {
        await db.query(sql);
        console.log(G(`  ✅  ${label}`));
    } catch (e) {
        console.error(R(`  ❌  ${label}: ${e.message}`));
    }
}

async function addCol(table, column, definition) {
    const [rows] = await db.query(
        `SELECT COUNT(*) as c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    if (rows[0].c === 0) {
        await run(`ALTER ${table} → ADD ${column}`, `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    } else {
        console.log(D(`  ⏭️  ${table}.${column} bereits vorhanden`));
    }
}

// ── Tabellen erstellen ────────────────────────────────────────────────────────────
console.log('\x1b[1m📋 Tabellen anlegen...\x1b[0m');

await run('admins', `
    CREATE TABLE IF NOT EXISTS admins (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        username      VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role          VARCHAR(32) DEFAULT 'admin',
        created_at    DATETIME DEFAULT NOW()
    )
`);

await run('admin_sessions', `
    CREATE TABLE IF NOT EXISTS admin_sessions (
        id             VARCHAR(36) PRIMARY KEY,
        admin_username VARCHAR(100) NOT NULL,
        token_hash     VARCHAR(64) NOT NULL,
        ip             VARCHAR(45),
        user_agent     VARCHAR(512),
        revoked        TINYINT(1) DEFAULT 0,
        created_at     DATETIME DEFAULT NOW(),
        expires_at     DATETIME NOT NULL,
        INDEX idx_token_hash (token_hash),
        INDEX idx_expires    (expires_at)
    )
`);

await run('customers', `
    CREATE TABLE IF NOT EXISTS customers (
        id                   VARCHAR(36) PRIMARY KEY,
        name                 VARCHAR(255) NOT NULL,
        email                VARCHAR(255) UNIQUE NOT NULL,
        phone                VARCHAR(64),
        contact_person       VARCHAR(255),
        company              VARCHAR(255),
        payment_status       VARCHAR(32) DEFAULT 'unknown',
        notes                TEXT,
        archived             TINYINT(1) DEFAULT 0,
        portal_username      VARCHAR(100) UNIQUE,
        password_hash        VARCHAR(255),
        must_change_password TINYINT(1) DEFAULT 0,
        portal_token         VARCHAR(128),
        portal_token_expires DATETIME,
        created_at           DATETIME DEFAULT NOW(),
        updated_at           DATETIME DEFAULT NOW() ON UPDATE NOW()
    )
`);

await run('customer_sessions', `
    CREATE TABLE IF NOT EXISTS customer_sessions (
        id          VARCHAR(36) PRIMARY KEY,
        customer_id VARCHAR(36) NOT NULL,
        token_hash  VARCHAR(64) NOT NULL,
        ip          VARCHAR(45),
        user_agent  VARCHAR(512),
        revoked     TINYINT(1) DEFAULT 0,
        created_at  DATETIME DEFAULT NOW(),
        expires_at  DATETIME NOT NULL,
        INDEX idx_token_hash (token_hash),
        INDEX idx_expires    (expires_at)
    )
`);

await run('licenses', `
    CREATE TABLE IF NOT EXISTS licenses (
        license_key        VARCHAR(64) PRIMARY KEY,
        type               VARCHAR(32) NOT NULL DEFAULT 'FREE',
        customer_id        VARCHAR(36),
        customer_name      VARCHAR(255),
        status             VARCHAR(32) NOT NULL DEFAULT 'active',
        associated_domain  VARCHAR(255) DEFAULT '*',
        validated_domain   VARCHAR(255),
        validated_domains  JSON,
        expires_at         DATETIME NOT NULL,
        last_validated     DATETIME,
        last_heartbeat     DATETIME,
        usage_count        INT DEFAULT 0,
        allowed_modules    JSON,
        limits             JSON,
        max_devices        INT DEFAULT 0,
        analytics_daily    JSON,
        analytics_features JSON,
        expiry_notified_at DATETIME,
        created_at         DATETIME DEFAULT NOW(),
        updated_at         DATETIME DEFAULT NOW() ON UPDATE NOW()
    )
`);

await run('purchase_history', `
    CREATE TABLE IF NOT EXISTS purchase_history (
        id          VARCHAR(36) PRIMARY KEY,
        customer_id VARCHAR(36) NOT NULL,
        license_key VARCHAR(64),
        plan        VARCHAR(32),
        action      VARCHAR(64),
        amount      DECIMAL(10,2),
        note        TEXT,
        created_by  VARCHAR(100),
        created_at  DATETIME DEFAULT NOW()
    )
`);

await run('devices', `
    CREATE TABLE IF NOT EXISTS devices (
        id          VARCHAR(36) PRIMARY KEY,
        license_key VARCHAR(64) NOT NULL,
        device_id   VARCHAR(255) NOT NULL,
        device_type VARCHAR(64) DEFAULT 'unknown',
        ip          VARCHAR(45),
        active      TINYINT(1) DEFAULT 1,
        last_seen   DATETIME DEFAULT NOW(),
        created_at  DATETIME DEFAULT NOW()
    )
`);

await run('audit_log', `
    CREATE TABLE IF NOT EXISTS audit_log (
        id         VARCHAR(36) PRIMARY KEY,
        action     VARCHAR(128) NOT NULL,
        data       JSON,
        actor      VARCHAR(100),
        created_at DATETIME DEFAULT NOW(),
        INDEX idx_action     (action),
        INDEX idx_created_at (created_at)
    )
`);

await run('used_nonces', `
    CREATE TABLE IF NOT EXISTS used_nonces (
        val VARCHAR(128) PRIMARY KEY,
        ts  BIGINT NOT NULL,
        INDEX idx_ts (ts)
    )
`);

await run('smtp_config', `
    CREATE TABLE IF NOT EXISTS smtp_config (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        host       VARCHAR(255),
        port       INT DEFAULT 587,
        secure     TINYINT(1) DEFAULT 0,
        user       VARCHAR(255),
        pass       VARCHAR(255),
        from_name  VARCHAR(255),
        from_email VARCHAR(255),
        active     TINYINT(1) DEFAULT 1,
        created_at DATETIME DEFAULT NOW()
    )
`);

await run('webhook_config', `
    CREATE TABLE IF NOT EXISTS webhook_config (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        url        VARCHAR(512) NOT NULL,
        secret     VARCHAR(255),
        events     JSON,
        active     TINYINT(1) DEFAULT 1,
        created_at DATETIME DEFAULT NOW()
    )
`);

// ── Fehlende Spalten ergänzen ─────────────────────────────────────────────────────
console.log('\n\x1b[1m🔧 Fehlende Spalten ergänzen...\x1b[0m');

await addCol('licenses',  'expiry_notified_at',  'DATETIME NULL');
await addCol('licenses',  'last_heartbeat',      'DATETIME NULL');
await addCol('licenses',  'validated_domains',   'JSON NULL');
await addCol('licenses',  'analytics_daily',     'JSON NULL');
await addCol('licenses',  'analytics_features',  'JSON NULL');
await addCol('customers', 'portal_username',     'VARCHAR(100) NULL');
await addCol('customers', 'must_change_password','TINYINT(1) DEFAULT 0');
await addCol('customers', 'portal_token',        'VARCHAR(128) NULL');
await addCol('customers', 'portal_token_expires','DATETIME NULL');
await addCol('customers', 'phone',               'VARCHAR(64) NULL');
await addCol('customers', 'contact_person',      'VARCHAR(255) NULL');
await addCol('customers', 'company',             'VARCHAR(255) NULL');
await addCol('customers', 'archived',            'TINYINT(1) DEFAULT 0');

// ── Aufräumen ──────────────────────────────────────────────────────────────────────
console.log('\n\x1b[1m🧹 Abgelaufene Sessions aufräumen...\x1b[0m');
await run('admin_sessions bereinigen',    'DELETE FROM admin_sessions    WHERE expires_at < NOW()');
await run('customer_sessions bereinigen', 'DELETE FROM customer_sessions WHERE expires_at < NOW()');
await run('Alte Nonces löschen',          `DELETE FROM used_nonces        WHERE ts < ${Date.now() - 86400000}`);

console.log(G('\n✅  Migration abgeschlossen! Server neu starten:'));
console.log('   systemctl restart licens-srv.service\n');

await db.end();
