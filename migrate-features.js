#!/usr/bin/env node
/**
 * migrate-features.js
 * Erstellt neue DB-Tabellen und Spalten für die Feature-Updates.
 *
 * Ausführen:
 *   node migrate-features.js
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';

const cfg = {
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASS     || '',
    database: process.env.DB_NAME     || 'opa_licenses',
    multipleStatements: false,
};

const steps = [
    // ── admin_sessions (Token-Blacklist / Logout-Support) ──────────────────────
    {
        name: 'Tabelle admin_sessions anlegen',
        check: `SELECT COUNT(*) AS n FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admin_sessions'`,
        sql: `CREATE TABLE admin_sessions (
          id           CHAR(36)     NOT NULL PRIMARY KEY,
          admin_username VARCHAR(128) NOT NULL,
          token_hash   CHAR(64)     NOT NULL UNIQUE,
          ip           VARCHAR(64)  DEFAULT NULL,
          user_agent   VARCHAR(512) DEFAULT NULL,
          revoked      TINYINT(1)   NOT NULL DEFAULT 0,
          expires_at   DATETIME     NOT NULL,
          created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_token_hash (token_hash),
          INDEX idx_expires_at (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    },

    // ── customer_sessions: Falls noch nicht vorhanden ──────────────────────────
    {
        name: 'Tabelle customer_sessions anlegen (falls fehlend)',
        check: `SELECT COUNT(*) AS n FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customer_sessions'`,
        sql: `CREATE TABLE customer_sessions (
          id           CHAR(36)     NOT NULL PRIMARY KEY,
          customer_id  CHAR(36)     NOT NULL,
          token_hash   CHAR(64)     NOT NULL UNIQUE,
          ip           VARCHAR(64)  DEFAULT NULL,
          user_agent   VARCHAR(512) DEFAULT NULL,
          revoked      TINYINT(1)   NOT NULL DEFAULT 0,
          expires_at   DATETIME     NOT NULL,
          created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_token_hash (token_hash),
          INDEX idx_expires_at (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    },

    // ── expiry_notified_at (Bugfix #3, falls noch nicht migriert) ─────────────
    {
        name: 'Spalte expiry_notified_at in licenses',
        check: `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME   = 'licenses'
                  AND COLUMN_NAME  = 'expiry_notified_at'`,
        sql: `ALTER TABLE licenses
              ADD COLUMN expiry_notified_at DATETIME NULL DEFAULT NULL
              COMMENT 'Zeitpunkt der letzten Ablauf-Benachrichtigung. NULL = noch nicht benachrichtigt.'`
    },

    // ── must_change_password (Bugfix #2, falls noch nicht migriert) ───────────
    {
        name: 'Spalte must_change_password in customers',
        check: `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME   = 'customers'
                  AND COLUMN_NAME  = 'must_change_password'`,
        sql: `ALTER TABLE customers
              ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0
              COMMENT '1 = Kunde muss Passwort beim naechsten Login aendern.'`
    },

    // ── portal_username (falls noch nicht migriert) ────────────────────────────
    {
        name: 'Spalte portal_username in customers',
        check: `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME   = 'customers'
                  AND COLUMN_NAME  = 'portal_username'`,
        sql: `ALTER TABLE customers
              ADD COLUMN portal_username VARCHAR(128) NULL DEFAULT NULL UNIQUE
              COMMENT 'Auto-generierter Benutzername fuer das Kunden-Portal.'`
    },
];

async function run() {
    console.log('\n🔧  OPA! Santorini — Feature-Migration\n');
    console.log(`📡  Verbinde mit ${cfg.host}:${cfg.port}/${cfg.database} als ${cfg.user} …`);

    let conn;
    try {
        conn = await mysql.createConnection(cfg);
        console.log('✅  Datenbankverbindung hergestellt.\n');
    } catch (e) {
        console.error('❌  Verbindungsfehler:', e.message);
        console.error('    Bitte .env-Datei prüfen (DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME).');
        process.exit(1);
    }

    let ok = 0, skipped = 0, failed = 0;

    for (const step of steps) {
        process.stdout.write(`  ⏳  ${step.name} … `);
        try {
            const [[{ n }]] = await conn.query(step.check);
            if (n > 0) {
                console.log('⏭️  bereits vorhanden, übersprungen.');
                skipped++;
                continue;
            }
            await conn.query(step.sql);
            console.log('✅  angelegt.');
            ok++;
        } catch (e) {
            console.log(`\n  ❌  Fehler: ${e.message}`);
            failed++;
        }
    }

    await conn.end();

    console.log('\n─────────────────────────────────────────');
    console.log(`  Ergebnis: ${ok} angelegt · ${skipped} übersprungen · ${failed} fehlgeschlagen`);
    if (failed === 0) {
        console.log('  🎉  Migration erfolgreich abgeschlossen!');
    } else {
        console.log('  ⚠️   Einige Schritte schlugen fehl. Bitte Logs oben prüfen.');
        process.exit(1);
    }
    console.log('─────────────────────────────────────────\n');
}

run();
