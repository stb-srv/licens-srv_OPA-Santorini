/**
 * migrate-portal.js
 * Fügt Kunden-Portal-Felder zur customers-Tabelle hinzu
 * und erstellt die customer_sessions-Tabelle.
 * Ausführen: node migrate-portal.js
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

const migrations = [
    {
        name: 'customers.password_hash',
        sql: `ALTER TABLE customers ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) DEFAULT NULL`
    },
    {
        name: 'customers.portal_token',
        sql: `ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_token VARCHAR(128) DEFAULT NULL`
    },
    {
        name: 'customers.portal_token_expires',
        sql: `ALTER TABLE customers ADD COLUMN IF NOT EXISTS portal_token_expires DATETIME DEFAULT NULL`
    },
    {
        name: 'customer_sessions table',
        sql: `CREATE TABLE IF NOT EXISTS customer_sessions (
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
        )`
    }
];

for (const m of migrations) {
    try {
        await db.query(m.sql);
        console.log(`  ✅ ${m.name}`);
    } catch (e) {
        if (e.code === 'ER_DUP_FIELDNAME' || e.message.includes('Duplicate column')) {
            console.log(`  ⏭️  ${m.name} (bereits vorhanden)`);
        } else {
            console.error(`  ❌ ${m.name}: ${e.message}`);
        }
    }
}

console.log('\n✅ Portal-Migration abgeschlossen.');
console.log('📝 Bitte PORTAL_SECRET in die .env eintragen!');
await db.end();
