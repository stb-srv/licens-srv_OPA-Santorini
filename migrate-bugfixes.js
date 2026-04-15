#!/usr/bin/env node
/**
 * migrate-bugfixes.js
 * Migriert die Datenbank für die Bugfix-Issues #2, #3.
 *
 * Ausführen:
 *   node migrate-bugfixes.js
 *
 * Voraussetzung: .env muss DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME enthalten.
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

// Jeder Schritt hat einen Namen, eine SQL-Abfrage und optional eine Prüfabfrage
const steps = [
    {
        name: 'Fix #3 — Spalte expiry_notified_at in licenses',
        check: `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME   = 'licenses'
                  AND COLUMN_NAME  = 'expiry_notified_at'`,
        sql: `ALTER TABLE licenses
              ADD COLUMN expiry_notified_at DATETIME NULL DEFAULT NULL
              COMMENT 'Zeitpunkt der letzten Ablauf-Benachrichtigung. NULL = noch nicht benachrichtigt.'`,
    },
    {
        name: 'Fix #2 — Spalte must_change_password in customers',
        check: `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME   = 'customers'
                  AND COLUMN_NAME  = 'must_change_password'`,
        sql: `ALTER TABLE customers
              ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0
              COMMENT '1 = Kunde muss Passwort beim naechsten Login aendern.'`,
    },
];

async function run() {
    console.log('\n🔧  OPA! Santorini — Bugfix-Migration\n');
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
            // Prüfen ob Spalte schon existiert
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
