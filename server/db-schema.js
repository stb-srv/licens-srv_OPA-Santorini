// Zentrale Typen-Referenz für alle Migrationen.
export const DB_SCHEMA = {
    PK: {
        customers:      'TEXT',   // UUID
        licenses:       'TEXT',   // license_key
        invoices:       'TEXT',   // UUID
        invoice_items:  'INTEGER', // AUTOINCREMENT
        admins:         'INTEGER', // AUTOINCREMENT
        devices:        'TEXT',   // UUID
        audit_log:      'TEXT',   // UUID
        webhooks:       'INTEGER', // AUTOINCREMENT
    },
    FIELDS: {
        uuid:         'TEXT',
        licenseKey:   'TEXT',
        email:        'TEXT',
        timestamp:    'TEXT',
        bool:         'INTEGER',
        shortText:    'TEXT',
        longText:     'TEXT',
        money:        'REAL',
        taxRate:      'REAL',
        currency:     'TEXT',
    }
};
