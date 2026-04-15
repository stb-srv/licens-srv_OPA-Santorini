/**
 * server/migrate.js
 * Zentrales Migrations-System mit schema_migrations-Tabelle.
 * Führt alle Migrationsdateien in server/migrations/*.js in Reihenfolge aus
 * und überspringt bereits angewendete Versionen.
 *
 * Ausführen: node server/migrate.js
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cfg = {
    host:     process.env.DB_HOST     || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASS     || '',
    database: process.env.DB_NAME     || 'opa_licenses',
    multipleStatements: true,
};

async function run() {
    console.log('\n🗄️  OPA! Santorini — Migrations-System\n');

    let conn;
    try {
        conn = await mysql.createConnection(cfg);
        console.log(`✅  Verbunden mit ${cfg.host}:${cfg.port}/${cfg.database}\n`);
    } catch (e) {
        console.error('❌  Verbindungsfehler:', e.message);
        process.exit(1);
    }

    // schema_migrations-Tabelle anlegen falls nicht vorhanden
    await conn.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INT          NOT NULL PRIMARY KEY,
            name       VARCHAR(255) NOT NULL,
            applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Bereits angewendete Versionen laden
    const [[...applied]] = await conn.query('SELECT version FROM schema_migrations ORDER BY version ASC');
    const appliedVersions = new Set(applied.map(r => r.version));

    // Migrations-Dateien einlesen
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
        fs.mkdirSync(migrationsDir, { recursive: true });
        console.log('📁  Verzeichnis server/migrations/ erstellt.\n');
    }

    const files = fs.readdirSync(migrationsDir)
        .filter(f => /^\d{4}_.*\.(js|mjs|sql)$/.test(f))
        .sort();

    if (files.length === 0) {
        console.log('ℹ️  Keine Migrations-Dateien in server/migrations/ gefunden.');
        console.log('   Erstelle Dateien nach dem Muster: 0001_initial_schema.js\n');
    }

    let ok = 0, skipped = 0, failed = 0;

    for (const file of files) {
        const version = parseInt(file.slice(0, 4));
        const name    = file.replace(/^\d{4}_/, '').replace(/\.(js|mjs|sql)$/, '');

        if (appliedVersions.has(version)) {
            console.log(`  ⏭️   [${version}] ${name} — bereits angewendet`);
            skipped++;
            continue;
        }

        process.stdout.write(`  ⏳   [${version}] ${name} … `);
        try {
            const filePath = path.join(migrationsDir, file);

            if (file.endsWith('.sql')) {
                const sql = fs.readFileSync(filePath, 'utf8');
                await conn.query(sql);
            } else {
                // JS/MJS: Default-Export muss eine async Funktion sein, die conn erhält
                const mod = await import(`file://${filePath}`);
                if (typeof mod.default !== 'function')
                    throw new Error('Migrations-Datei muss default export einer async Funktion sein: export default async (conn) => {...}');
                await mod.default(conn);
            }

            await conn.query(
                'INSERT INTO schema_migrations (version, name) VALUES (?, ?)',
                [version, name]
            );
            console.log('✅');
            ok++;
        } catch (e) {
            console.log(`\n  ❌  Fehler: ${e.message}`);
            failed++;
            // Bei Fehler: abbrechen (Migrationen sind in Reihenfolge abhängig)
            break;
        }
    }

    await conn.end();

    console.log('\n─────────────────────────────────────────────────');
    console.log(`  Ergebnis: ${ok} angewendet · ${skipped} übersprungen · ${failed} fehlgeschlagen`);
    if (failed === 0) {
        console.log('  🎉  Alle Migrationen erfolgreich!');
    } else {
        console.log('  ⚠️   Bitte Fehler beheben und Migration erneut ausführen.');
        process.exit(1);
    }
    console.log('─────────────────────────────────────────────────\n');
}

run();
