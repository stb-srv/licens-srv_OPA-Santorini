/**
 * OPA! Santorini License Server – Migration: purchase_history
 * Einmalig ausführen: node migrate-purchase-history-2.js
 */
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const connection = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  multipleStatements: true
});

console.log('📦 Erstelle purchase_history Tabelle...');

await connection.query(`
  CREATE TABLE IF NOT EXISTS purchase_history (
    id           CHAR(36)      NOT NULL PRIMARY KEY,
    customer_id  CHAR(36)      NOT NULL,
    license_key  VARCHAR(64)   NOT NULL,
    plan         VARCHAR(64)   NOT NULL,
    action       ENUM('purchase','renewal','upgrade','downgrade','cancellation') NOT NULL DEFAULT 'purchase',
    amount       DECIMAL(10,2) DEFAULT NULL COMMENT 'Betrag in EUR',
    note         TEXT,
    created_by   VARCHAR(64)   DEFAULT 'system',
    created_at   DATETIME      DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_customer (customer_id),
    INDEX idx_license  (license_key),
    INDEX idx_ts       (created_at)
  );
`);

console.log('✅ purchase_history Tabelle erfolgreich erstellt.');
console.log('ℹ️ Bestehende Lizenzerstellungen werden jetzt importiert...');

// Bestehende Lizenzen als "purchase" nachimportieren
const [licenses] = await connection.query(`
  SELECT l.license_key, l.type, l.customer_id, l.customer_name, l.created_at
  FROM licenses l
  WHERE l.customer_id IS NOT NULL
`);

const { randomUUID } = await import('crypto');
let imported = 0;
for (const l of licenses) {
  await connection.query(
    `INSERT IGNORE INTO purchase_history
       (id, customer_id, license_key, plan, action, note, created_by, created_at)
     VALUES (?, ?, ?, ?, 'purchase', ?, 'migration', ?)`,
    [randomUUID(), l.customer_id, l.license_key, l.type,
     `Importiert aus bestehender Lizenz (${l.type})`, l.created_at]
  );
  imported++;
}

console.log(`✅ ${imported} bestehende Lizenz(en) als Kaufhistorie importiert.`);
console.log('🚀 Migration abgeschlossen.');
await connection.end();
