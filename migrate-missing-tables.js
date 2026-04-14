/**
 * OPA! Santorini – Migrations-Script für fehlende Tabellen & Spalten
 * Ausführen mit: node migrate-missing-tables.js
 */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     parseInt(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
});

console.log('🔄 Starte Migration...\n');

// Hilfsfunktion: Spalte hinzufügen falls nicht vorhanden
async function addColumnIfMissing(table, column, definition) {
    const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [process.env.DB_NAME, table, column]
    );
    if (rows.length === 0) {
        await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${column} ${definition}`);
        console.log(`  ✅ Spalte '${column}' zu '${table}' hinzugefügt.`);
    } else {
        console.log(`  ✓  Spalte '${column}' in '${table}' existiert bereits.`);
    }
}

// ── 1. purchase_history ───────────────────────────────────────────────────────
console.log('📋 1. Tabelle: purchase_history');
await conn.query(`
    CREATE TABLE IF NOT EXISTS purchase_history (
        id CHAR(36) NOT NULL PRIMARY KEY,
        customer_id CHAR(36),
        license_key VARCHAR(64),
        plan VARCHAR(32),
        action ENUM('purchase','renewal','upgrade','downgrade','cancellation') DEFAULT 'purchase',
        amount DECIMAL(10,2),
        note TEXT,
        created_by VARCHAR(64),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_customer (customer_id),
        INDEX idx_license (license_key)
    )
`);
console.log('  ✅ purchase_history OK');

// ── 2. customer_sessions ──────────────────────────────────────────────────────
console.log('📋 2. Tabelle: customer_sessions');
await conn.query(`
    CREATE TABLE IF NOT EXISTS customer_sessions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        customer_id CHAR(36) NOT NULL,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        ip VARCHAR(64),
        user_agent VARCHAR(512),
        revoked TINYINT(1) DEFAULT 0,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_token_hash (token_hash),
        INDEX idx_customer (customer_id)
    )
`);
console.log('  ✅ customer_sessions OK');

// ── 3. customers – fehlende Spalten ──────────────────────────────────────────
console.log('📋 3. Tabelle: customers – fehlende Spalten');
await addColumnIfMissing('customers', 'archived', 'TINYINT(1) DEFAULT 0');
await addColumnIfMissing('customers', 'password_hash', 'VARCHAR(255)');
await addColumnIfMissing('customers', 'must_change_password', 'TINYINT(1) DEFAULT 0');
await addColumnIfMissing('customers', 'portal_token', 'VARCHAR(80)');
await addColumnIfMissing('customers', 'portal_token_expires', 'DATETIME');
await addColumnIfMissing('customers', 'contact_person', 'VARCHAR(255)');

// ── 4. licenses – Status 'cancelled' ─────────────────────────────────────────
console.log('📋 4. Tabelle: licenses – ENUM erweitern (cancelled, Basic)');
try {
    await conn.query(`
        ALTER TABLE licenses
        MODIFY COLUMN status ENUM('active','suspended','revoked','expired','cancelled') NOT NULL DEFAULT 'active'
    `);
    console.log('  ✅ licenses.status ENUM erweitert');
} catch (e) {
    console.log('  ✓  licenses.status – bereits korrekt oder Fehler ignoriert:', e.message);
}

try {
    await conn.query(`
        ALTER TABLE licenses
        MODIFY COLUMN type ENUM('FREE','BASIC','STARTER','PRO','PRO_PLUS','ENTERPRISE') NOT NULL DEFAULT 'FREE'
    `);
    console.log('  ✅ licenses.type ENUM erweitert (BASIC hinzugefügt)');
} catch (e) {
    console.log('  ✓  licenses.type – bereits korrekt oder Fehler ignoriert:', e.message);
}

// ── 5. validated_domains in licenses ─────────────────────────────────────────
console.log('📋 5. Tabelle: licenses – validated_domains Spalte');
await addColumnIfMissing('licenses', 'validated_domains', 'JSON');

console.log('\n✅ Migration abgeschlossen! Starte den Server neu.\n');
await conn.end();
