/**
 * ============================================================
 * OPA! Santorini License Server — Migration & Update Script
 * ============================================================
 * Dieses Script:
 *  1. Liest die bestehende db.json aus
 *  2. Erstellt das MySQL-Schema (falls nicht vorhanden)
 *  3. Migriert alle Lizenzen, Kunden, Admins, Geräte und SMTP
 *  4. Erstellt einen Standard-Superadmin falls keine Admins vorhanden
 *  5. Zeigt eine Zusammenfassung der Migration
 *
 * Nutzung:
 *   node migrate.js
 * oder mit benutzerdefiniertem db.json Pfad:
 *   DB_JSON_PATH=/pfad/zu/db.json node migrate.js
 * ============================================================
 */

import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { readFile, access } from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env manuell laden (ohne dotenv-Abhängigkeit)
try {
    const envContent = await readFile(path.join(__dirname, '.env'), 'utf-8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
        if (!process.env[key]) process.env[key] = val;
    }
    console.log('✅ .env geladen');
} catch {
    console.warn('⚠️  Keine .env Datei gefunden – nutze Umgebungsvariablen');
}

// ─── Farben für Konsole ───────────────────────────────────────────────────────
const c = {
    green:  (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red:    (s) => `\x1b[31m${s}\x1b[0m`,
    cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
    bold:   (s) => `\x1b[1m${s}\x1b[0m`,
    dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

const stats = {
    licenses: { migrated: 0, skipped: 0, updated: 0 },
    customers: { migrated: 0, skipped: 0 },
    admins:    { migrated: 0, skipped: 0 },
    devices:   { migrated: 0, skipped: 0 },
    nonces:    { migrated: 0 },
    smtp:      { migrated: false },
};

// ─── DB-Verbindung ────────────────────────────────────────────────────────────
const conn = await mysql.createConnection({
    host:     process.env.DB_HOST || '127.0.0.1',
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'opa_licenses',
    multipleStatements: true,
    timezone: '+00:00'
});

console.log(c.green('\n🏛️  OPA! Santorini — Migrations-Script v2.0'));
console.log(c.dim('═'.repeat(55)));
console.log(c.cyan(`📡 Verbunden mit: ${process.env.DB_HOST}:${process.env.DB_PORT || 3306}/${process.env.DB_NAME}\n`));

// ─── Schema erstellen ─────────────────────────────────────────────────────────
console.log(c.bold('📦 Schritt 1/5: Datenbank-Schema prüfen / erstellen...'));

await conn.query(`
CREATE TABLE IF NOT EXISTS admins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin','superadmin') NOT NULL DEFAULT 'admin',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
    id CHAR(36) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(64),
    contact_person VARCHAR(255),
    company VARCHAR(255),
    payment_status ENUM('paid','pending','overdue','unknown') DEFAULT 'unknown',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS licenses (
    license_key VARCHAR(64) NOT NULL PRIMARY KEY,
    type ENUM('FREE','STARTER','PRO','PRO_PLUS','ENTERPRISE') NOT NULL DEFAULT 'FREE',
    customer_id CHAR(36),
    customer_name VARCHAR(255),
    status ENUM('active','suspended','revoked','expired') NOT NULL DEFAULT 'active',
    associated_domain VARCHAR(255) DEFAULT '*',
    expires_at DATETIME NOT NULL,
    allowed_modules JSON,
    limits JSON,
    max_devices INT DEFAULT 0,
    usage_count INT DEFAULT 0,
    last_validated DATETIME,
    last_heartbeat DATETIME,
    validated_domain VARCHAR(255),
    validated_domains JSON,
    analytics_daily JSON,
    analytics_features JSON,
    webhook_url VARCHAR(512),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id CHAR(36) NOT NULL PRIMARY KEY,
    license_key VARCHAR(64) NOT NULL,
    device_id VARCHAR(255) NOT NULL,
    device_type VARCHAR(64) DEFAULT 'unknown',
    ip VARCHAR(64),
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    active TINYINT(1) DEFAULT 1,
    deactivated_at DATETIME,
    FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
    id CHAR(36) NOT NULL PRIMARY KEY,
    ts DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor VARCHAR(64) DEFAULT 'system',
    action VARCHAR(64) NOT NULL,
    details JSON,
    INDEX idx_action (action),
    INDEX idx_ts (ts)
);

CREATE TABLE IF NOT EXISTS used_nonces (
    val VARCHAR(255) NOT NULL PRIMARY KEY,
    ts BIGINT NOT NULL,
    INDEX idx_ts (ts)
);

CREATE TABLE IF NOT EXISTS smtp_config (
    id INT PRIMARY KEY DEFAULT 1,
    host VARCHAR(255),
    port VARCHAR(8) DEFAULT '587',
    secure VARCHAR(8) DEFAULT 'false',
    smtp_user VARCHAR(255),
    smtp_pass VARCHAR(255),
    smtp_from VARCHAR(255),
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhooks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    url VARCHAR(512) NOT NULL,
    secret VARCHAR(255),
    events JSON,
    active TINYINT(1) DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);
console.log(c.green('  ✓ Schema bereit'));

// ─── db.json laden ────────────────────────────────────────────────────────────
console.log(c.bold('\n📂 Schritt 2/5: db.json laden...'));

const DB_JSON_PATH = process.env.DB_JSON_PATH || path.join(__dirname, 'db.json');

let oldDB = { licenses: [], customers: [], admins: [], devices: [], used_nonces: [], smtp_config: null };

try {
    await access(DB_JSON_PATH, constants.R_OK);
    const raw = await readFile(DB_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    oldDB = {
        licenses:    parsed.licenses    || [],
        customers:   parsed.customers   || [],
        admins:      parsed.admins      || [],
        devices:     parsed.devices     || [],
        used_nonces: parsed.used_nonces || [],
        smtp_config: parsed.smtp_config || null,
    };
    console.log(c.green(`  ✓ db.json gefunden: ${DB_JSON_PATH}`));
    console.log(c.dim(`     Lizenzen: ${oldDB.licenses.length} | Kunden: ${oldDB.customers.length} | Admins: ${oldDB.admins.length} | Geräte: ${oldDB.devices.length}`));
} catch {
    console.log(c.yellow('  ⚠️  Keine db.json gefunden – nur Schema + Standard-Admin wird erstellt.'));
}

// ─── Hilfsfunktion: ISO-Datum zu MySQL-DATETIME ───────────────────────────────
const toMySQL = (iso) => {
    if (!iso) return null;
    try {
        return new Date(iso).toISOString().slice(0, 19).replace('T', ' ');
    } catch {
        return null;
    }
};

// ─── Modul-Mapping: alte Module → neue OPA-Module ─────────────────────────────
const mapModules = (oldModules, type) => {
    if (!oldModules) return null;
    // Neue OPA-Module auf Basis der alten Werte mappen
    return {
        menu_edit:             oldModules.menu_edit             ?? true,
        multilanguage:         type === 'STARTER' || type === 'PRO' || type === 'PRO_PLUS' || type === 'ENTERPRISE',
        seasonal_menu:         type === 'PRO' || type === 'PRO_PLUS' || type === 'ENTERPRISE',
        orders_kitchen:        oldModules.orders_kitchen        ?? false,
        reservations_online:   type === 'PRO' || type === 'PRO_PLUS' || type === 'ENTERPRISE',
        reservations_phone:    oldModules.reservations          ?? false,
        custom_branding:       oldModules.custom_design         ?? false,
        analytics:             oldModules.analytics             ?? false,
        qr_pay:                type === 'PRO' || type === 'PRO_PLUS' || type === 'ENTERPRISE' ? true : (oldModules.qr_pay ?? false),
    };
};

// ─── Kunden migrieren ─────────────────────────────────────────────────────────
console.log(c.bold('\n👥 Schritt 3/5: Kunden migrieren...'));

for (const cust of oldDB.customers) {
    try {
        const [existing] = await conn.query('SELECT id FROM customers WHERE id = ?', [cust.id]);
        if (existing.length > 0) {
            console.log(c.dim(`     → Kunde "${cust.name}" bereits vorhanden – übersprungen`));
            stats.customers.skipped++;
            continue;
        }
        await conn.query(
            'INSERT INTO customers (id, name, email, phone, contact_person, company, payment_status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                cust.id || crypto.randomUUID(),
                cust.name || 'Unbekannt',
                cust.email || 'noemail@migration.local',
                cust.phone || null,
                cust.contact_person || null,
                cust.company || null,
                cust.payment_status || 'unknown',
                cust.notes || '',
                toMySQL(cust.created_at) || new Date().toISOString().slice(0, 19).replace('T', ' ')
            ]
        );
        console.log(c.green(`     ✓ Kunde "${cust.name}" (${cust.email}) migriert`));
        stats.customers.migrated++;
    } catch (e) {
        console.log(c.red(`     ✗ Fehler bei Kunde "${cust.name}": ${e.message}`));
    }
}

if (oldDB.customers.length === 0) console.log(c.dim('     Keine Kunden in db.json'));

// ─── Lizenzen migrieren ───────────────────────────────────────────────────────
console.log(c.bold('\n🔑 Schritt 4/5: Lizenzen migrieren...'));

for (const lic of oldDB.licenses) {
    try {
        const [existing] = await conn.query('SELECT license_key, usage_count FROM licenses WHERE license_key = ?', [lic.license_key]);

        const mappedModules = mapModules(lic.allowed_modules, lic.type);
        const limits = lic.limits || { max_dishes: 100, max_tables: 25 };
        const validatedDomains = lic.validated_domains || (lic.validated_domain ? [lic.validated_domain] : []);
        const analyticsDaily = lic.analytics?.daily || {};
        const analyticsFeatures = lic.analytics?.features || {};

        // Status-Mapping: alte Werte → neue ENUM
        let status = lic.status || 'active';
        if (!['active','suspended','revoked','expired'].includes(status)) status = 'active';

        // Typ-Mapping: sicherstellen dass ENUM-Wert gültig
        let type = lic.type || 'FREE';
        if (!['FREE','STARTER','PRO','PRO_PLUS','ENTERPRISE'].includes(type)) {
            console.log(c.yellow(`     ⚠️  Unbekannter Typ "${type}" für ${lic.license_key} → auf FREE gesetzt`));
            type = 'FREE';
        }

        if (existing.length > 0) {
            // Vorhandene Lizenz: nur usage_count und Timestamps aktualisieren, Key NICHT überschreiben
            await conn.query(`
                UPDATE licenses SET
                    usage_count   = GREATEST(usage_count, ?),
                    last_validated = COALESCE(last_validated, ?),
                    last_heartbeat = COALESCE(last_heartbeat, ?)
                WHERE license_key = ?`,
                [
                    lic.usage_count || 0,
                    toMySQL(lic.last_validated),
                    toMySQL(lic.last_heartbeat),
                    lic.license_key
                ]
            );
            console.log(c.yellow(`     ↺ Lizenz "${lic.license_key}" bereits vorhanden – Usage-Count aktualisiert`));
            stats.licenses.updated++;
            continue;
        }

        await conn.query(`
            INSERT INTO licenses (
                license_key, type, customer_id, customer_name, status,
                associated_domain, expires_at, allowed_modules, limits,
                max_devices, usage_count, last_validated, last_heartbeat,
                validated_domain, validated_domains, analytics_daily,
                analytics_features, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                lic.license_key,
                type,
                lic.customer_id || null,
                lic.customer_name || null,
                status,
                lic.associated_domain || '*',
                toMySQL(lic.expires_at) || toMySQL(new Date(Date.now() + 365 * 86400000).toISOString()),
                JSON.stringify(mappedModules),
                JSON.stringify(limits),
                lic.max_devices || 0,
                lic.usage_count || 0,
                toMySQL(lic.last_validated),
                toMySQL(lic.last_heartbeat),
                lic.validated_domain || null,
                JSON.stringify(validatedDomains),
                JSON.stringify(analyticsDaily),
                JSON.stringify(analyticsFeatures),
                toMySQL(lic.created_at) || new Date().toISOString().slice(0, 19).replace('T', ' ')
            ]
        );

        const expiryDate = new Date(lic.expires_at).toLocaleDateString('de-DE');
        const modulesActive = Object.entries(mappedModules).filter(([,v]) => v).map(([k]) => k).join(', ');
        console.log(c.green(`     ✓ [${type}] ${lic.license_key}`));
        console.log(c.dim(`          Kunde: ${lic.customer_name || '–'} | Ablauf: ${expiryDate} | Domain: ${lic.associated_domain || '*'}`));
        console.log(c.dim(`          Module: ${modulesActive}`));
        stats.licenses.migrated++;

    } catch (e) {
        console.log(c.red(`     ✗ Fehler bei Lizenz "${lic.license_key}": ${e.message}`));
    }
}

if (oldDB.licenses.length === 0) console.log(c.dim('     Keine Lizenzen in db.json'));

// ─── Geräte migrieren ─────────────────────────────────────────────────────────
if (oldDB.devices.length > 0) {
    console.log(c.bold('\n📱 Geräte migrieren...'));
    for (const dev of oldDB.devices) {
        try {
            const [existing] = await conn.query('SELECT id FROM devices WHERE id = ?', [dev.id]);
            if (existing.length > 0) { stats.devices.skipped++; continue; }

            // Prüfen ob license_key existiert
            const [licExists] = await conn.query('SELECT license_key FROM licenses WHERE license_key = ?', [dev.license_key]);
            if (licExists.length === 0) {
                console.log(c.yellow(`     ⚠️  Gerät ${dev.device_id}: Lizenz ${dev.license_key} nicht gefunden – übersprungen`));
                stats.devices.skipped++;
                continue;
            }

            await conn.query(
                'INSERT INTO devices (id, license_key, device_id, device_type, ip, first_seen, last_seen, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    dev.id || crypto.randomUUID(),
                    dev.license_key,
                    dev.device_id,
                    dev.device_type || 'unknown',
                    dev.ip || null,
                    toMySQL(dev.first_seen),
                    toMySQL(dev.last_seen),
                    dev.active ? 1 : 0
                ]
            );
            stats.devices.migrated++;
        } catch (e) {
            console.log(c.red(`     ✗ Gerät Fehler: ${e.message}`));
        }
    }
    console.log(c.green(`     ✓ ${stats.devices.migrated} Gerät(e) migriert, ${stats.devices.skipped} übersprungen`));
}

// ─── SMTP migrieren ───────────────────────────────────────────────────────────
if (oldDB.smtp_config) {
    const smtp = oldDB.smtp_config;
    if (smtp.host && smtp.user && smtp.pass) {
        try {
            await conn.query(`
                INSERT INTO smtp_config (id, host, port, secure, smtp_user, smtp_pass, smtp_from)
                VALUES (1, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    host=VALUES(host), port=VALUES(port), secure=VALUES(secure),
                    smtp_user=VALUES(smtp_user), smtp_pass=VALUES(smtp_pass), smtp_from=VALUES(smtp_from)`,
                [smtp.host, smtp.port || '587', smtp.secure || 'false', smtp.user, smtp.pass, smtp.from || smtp.user]
            );
            console.log(c.green(`\n📧 SMTP-Konfiguration migriert (${smtp.host})`) );
            stats.smtp.migrated = true;
        } catch (e) {
            console.log(c.red(`\n📧 SMTP-Migration fehlgeschlagen: ${e.message}`));
        }
    }
}

// ─── Admins migrieren ─────────────────────────────────────────────────────────
console.log(c.bold('\n👤 Schritt 5/5: Admins migrieren...'));

for (const admin of oldDB.admins) {
    try {
        const [existing] = await conn.query('SELECT username FROM admins WHERE username = ?', [admin.username]);
        if (existing.length > 0) {
            console.log(c.dim(`     → Admin "${admin.username}" bereits vorhanden – übersprungen`));
            stats.admins.skipped++;
            continue;
        }
        // password_hash direkt übernehmen (bcrypt-Hash bleibt gültig)
        await conn.query(
            'INSERT INTO admins (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
            [
                admin.username,
                admin.password_hash,
                admin.role || 'admin',
                toMySQL(admin.created_at) || new Date().toISOString().slice(0, 19).replace('T', ' ')
            ]
        );
        console.log(c.green(`     ✓ Admin "${admin.username}" (${admin.role || 'admin'}) migriert`));
        stats.admins.migrated++;
    } catch (e) {
        console.log(c.red(`     ✗ Admin "${admin.username}" Fehler: ${e.message}`));
    }
}

// Standard-Superadmin erstellen falls keine Admins vorhanden
const [adminCount] = await conn.query('SELECT COUNT(*) as cnt FROM admins');
if (adminCount[0].cnt === 0) {
    const hash = await bcrypt.hash('admin123', 12);
    await conn.query(
        `INSERT IGNORE INTO admins (username, password_hash, role) VALUES ('admin', ?, 'superadmin')`,
        [hash]
    );
    console.log(c.yellow('     ⚠️  Kein Admin vorhanden – Standard-Superadmin erstellt: admin / admin123'));
    console.log(c.red('     ❗ Bitte sofort Passwort ändern!'));
}

// ─── Migrations-Audit-Eintrag ─────────────────────────────────────────────────
await conn.query(
    'INSERT INTO audit_log (id, actor, action, details) VALUES (?, ?, ?, ?)',
    [
        crypto.randomUUID(),
        'migration-script',
        'db_migration_completed',
        JSON.stringify({ ...stats, migrated_at: new Date().toISOString(), source: DB_JSON_PATH })
    ]
);

// ─── Zusammenfassung ──────────────────────────────────────────────────────────
console.log(c.dim('\n' + '═'.repeat(55)));
console.log(c.bold('\n📊 Migrations-Zusammenfassung:'));
console.log(`   🔑 Lizenzen:  ${c.green(stats.licenses.migrated + ' neu')}  |  ${c.yellow(stats.licenses.updated + ' aktualisiert')}  |  ${c.dim(stats.licenses.skipped + ' übersprungen')}`);
console.log(`   👥 Kunden:    ${c.green(stats.customers.migrated + ' neu')}  |  ${c.dim(stats.customers.skipped + ' übersprungen')}`);
console.log(`   👤 Admins:    ${c.green(stats.admins.migrated + ' neu')}  |  ${c.dim(stats.admins.skipped + ' übersprungen')}`);
console.log(`   📱 Geräte:    ${c.green(stats.devices.migrated + ' neu')}  |  ${c.dim(stats.devices.skipped + ' übersprungen')}`);
console.log(`   📧 SMTP:      ${stats.smtp.migrated ? c.green('migriert') : c.dim('nicht vorhanden')}`);
console.log(c.dim('\n' + '═'.repeat(55)));
console.log(c.green(c.bold('\n✅ Migration abgeschlossen! Server kann jetzt gestartet werden.')));
console.log(c.cyan('   → npm start\n'));

await conn.end();
