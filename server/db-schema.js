/**
 * DB_SCHEMA — Zentrale Typen-Referenz für alle Migrationen.
 * Bevor du eine neue Migration schreibst: importiere diese Datei
 * und verwende die Typen aus DB_SCHEMA.PK und DB_SCHEMA.FIELDS.
 * Dadurch werden Foreign-Key-Inkompatibilitäten verhindert.
 *
 * Import-Beispiel in einer Migration:
 *   import { DB_SCHEMA } from '../db-schema.js';
 *   // customers.id ist immer: DB_SCHEMA.PK.customers
 */

export const DB_SCHEMA = {
    // Primärschlüssel-Typen (kanonisch)
    PK: {
        customers:      'CHAR(36)',   // UUID
        licenses:       'VARCHAR(64)', // license_key
        invoices:       'CHAR(36)',   // UUID
        invoice_items:  'INT',        // AUTO_INCREMENT
        admins:         'INT',        // AUTO_INCREMENT
        devices:        'CHAR(36)',   // UUID
        audit_log:      'CHAR(36)',   // UUID
        webhooks:       'INT',        // AUTO_INCREMENT
    },
    // Standard-Kollation für alle Tabellen
    CHARSET:   'utf8mb4',
    COLLATION: 'utf8mb4_unicode_ci',
    ENGINE:    'InnoDB',
    // Standard-Typen für wiederverwendete Felder
    FIELDS: {
        uuid:         'CHAR(36)',
        licenseKey:   'VARCHAR(64)',
        email:        'VARCHAR(255)',
        timestamp:    'DATETIME',
        bool:         'TINYINT(1)',
        shortText:    'VARCHAR(255)',
        longText:     'TEXT',
        money:        'DECIMAL(10,2)',
        taxRate:      'DECIMAL(5,2)',
        currency:     'VARCHAR(8)',
    }
};
