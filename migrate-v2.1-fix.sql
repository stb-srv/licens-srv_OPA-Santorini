-- ============================================================
-- OPA! Santorini – Migration: Fehlende Tabellen & Spalten
-- Ausführen auf dem Server direkt in MySQL/MariaDB
-- oder via: mysql -u USER -p DB_NAME < migrate-v2.1-fix.sql
-- ============================================================

-- 1. purchase_history Tabelle
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
);

-- 2. customer_sessions Tabelle (für Kunden-Portal)
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
);

-- 3. customers – fehlende Spalten hinzufügen
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS archived TINYINT(1) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255),
    ADD COLUMN IF NOT EXISTS must_change_password TINYINT(1) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS portal_token VARCHAR(80),
    ADD COLUMN IF NOT EXISTS portal_token_expires DATETIME,
    ADD COLUMN IF NOT EXISTS contact_person VARCHAR(255);

-- 4. licenses – ENUM für cancelled-Status erweitern
-- Falls diese Abfrage fehlschlägt, ist der Status schon korrekt
ALTER TABLE licenses
    MODIFY COLUMN status ENUM('active','suspended','revoked','expired','cancelled') NOT NULL DEFAULT 'active';

-- 5. licenses – ENUM für BASIC-Typ erweitern
ALTER TABLE licenses
    MODIFY COLUMN type ENUM('FREE','BASIC','STARTER','PRO','PRO_PLUS','ENTERPRISE') NOT NULL DEFAULT 'FREE';

-- 6. licenses – validated_domains Spalte
ALTER TABLE licenses
    ADD COLUMN IF NOT EXISTS validated_domains JSON;

SELECT 'Migration abgeschlossen!' AS status;
