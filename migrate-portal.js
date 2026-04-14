/**
 * migrate-portal.js
 * Fügt Kunden-Portal-Felder zur customers-Tabelle hinzu
 * und erstellt die customer_sessions-Tabelle.
 * Ausführen: node migrate-portal.js
 *
 * Kompatibel mit MySQL 5.7+ und MariaDB (kein ADD COLUMN IF NOT EXISTS)
 */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    multipleStatements: false
});

console.log('🔄 Starte Portal-Migration...');

async function addColumnIfMissing(table, column, definition) {
    const [cols] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    if (cols.length > 0) {
        console.log(`  ⏭️  ${table}.${column} (bereits vorhanden)`);
        return;
    }
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`  ✅ ${table}.${column} hinzugefügt`);
}

try {
    await addColumnIfMissing('customers', 'password_hash',        'VARCHAR(255) DEFAULT NULL');
    await addColumnIfMissing('customers', 'portal_token',         'VARCHAR(128) DEFAULT NULL');
    await addColumnIfMissing('customers', 'portal_token_expires', 'DATETIME DEFAULT NULL');
    await addColumnIfMissing('customers', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0');
} catch (e) {
    console.error('❌ Fehler bei customers-Spalten:', e.message);
    process.exit(1);
}

try {
    await db.query(`CREATE TABLE IF NOT EXISTS customer_sessions (
        id CHAR(36) NOT NULL PRIMARY KEY,
        customer_id CHAR(36) NOT NULL,
        token_hash VARCHAR(255) NOT NULL,
        ip VARCHAR(64),
        user_agent VARCHAR(512),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        revoked TINYINT(1) DEFAULT 0,
        INDEX idx_customer (customer_id),
        INDEX idx_token (token_hash),
        INDEX idx_expires (expires_at)
    )`);
    console.log('  ✅ customer_sessions table');
} catch (e) {
    console.error('❌ Fehler bei customer_sessions:', e.message);
    process.exit(1);
}

console.log('\n✅ Portal-Migration abgeschlossen.');
console.log('📝 Bitte PORTAL_SECRET und PORTAL_URL in die .env eintragen!');
await db.end();
