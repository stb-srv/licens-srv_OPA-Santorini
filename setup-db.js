/**
 * OPA! Santorini License Server – MySQL Setup Script
 * Führe dieses Script einmalig aus: node setup-db.js
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

console.log('📦 Erstelle OPA! Santorini Datenbank-Schema...');

await connection.query(`
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

console.log('✅ Schema erfolgreich erstellt.');
console.log('👤 Erstelle Standard-Superadmin (admin / admin123) – bitte sofort ändern!');

import bcrypt from 'bcryptjs';
const hash = await bcrypt.hash('admin123', 12);
await connection.query(
    `INSERT IGNORE INTO admins (username, password_hash, role) VALUES (?, ?, 'superadmin')`,
    ['admin', hash]
);

console.log('✅ Setup abgeschlossen. Starte den Server mit: npm start');
await connection.end();
