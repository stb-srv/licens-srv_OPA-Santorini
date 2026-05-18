/**
 * Migration 0017 – Invoices, Items and Settings
 * Creates the invoices, invoice_items, and invoice_settings tables.
 */

export async function up(db) {
    console.log('⏫ Migration 0017: Creating billing schema tables...');

    // 1. Create invoices table
    await db.query(`
        CREATE TABLE IF NOT EXISTS invoices (
            id              CHAR(36) NOT NULL PRIMARY KEY,
            invoice_number  VARCHAR(32) NOT NULL UNIQUE,
            customer_id     CHAR(36) NOT NULL,
            license_key     VARCHAR(64) DEFAULT NULL,
            status          ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled') DEFAULT 'draft',
            type            ENUM('invoice', 'credit_note', 'reminder') DEFAULT 'invoice',
            amount_net      DECIMAL(10,2) NOT NULL,
            amount_tax      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
            amount_gross    DECIMAL(10,2) NOT NULL,
            tax_rate        DECIMAL(5,2) NOT NULL DEFAULT 19.00,
            currency        VARCHAR(8) NOT NULL DEFAULT 'EUR',
            due_date        DATE DEFAULT NULL,
            paid_at         DATETIME DEFAULT NULL,
            sent_at         DATETIME DEFAULT NULL,
            notes           TEXT DEFAULT NULL,
            pdf_path        VARCHAR(512) DEFAULT NULL,
            created_by      VARCHAR(64) DEFAULT 'system',
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
            
            INDEX idx_customer_id (customer_id),
            INDEX idx_license_key (license_key),
            INDEX idx_status (status),
            INDEX idx_type (type),
            INDEX idx_due_date (due_date),
            
            CONSTRAINT fk_invoices_customer FOREIGN KEY (customer_id) 
                REFERENCES customers(id) ON DELETE RESTRICT,
            CONSTRAINT fk_invoices_license FOREIGN KEY (license_key) 
                REFERENCES licenses(license_key) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('  ✅ Table invoices verified/created.');

    // 2. Create invoice_items table (invoice_id uses CHAR(36) to match invoices.id)
    await db.query(`
        CREATE TABLE IF NOT EXISTS invoice_items (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            invoice_id   CHAR(36) NOT NULL,
            description  VARCHAR(512) NOT NULL,
            quantity     DECIMAL(10,2) NOT NULL DEFAULT 1.00,
            unit_price   DECIMAL(10,2) NOT NULL,
            total        DECIMAL(10,2) NOT NULL,
            sort_order   INT DEFAULT 0,
            
            INDEX idx_invoice_id (invoice_id),
            
            CONSTRAINT fk_items_invoice FOREIGN KEY (invoice_id) 
                REFERENCES invoices(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('  ✅ Table invoice_items verified/created.');

    // 3. Create invoice_settings table
    await db.query(`
        CREATE TABLE IF NOT EXISTS invoice_settings (
            id              INT PRIMARY KEY DEFAULT 1,
            company_name    VARCHAR(255) DEFAULT NULL,
            company_address TEXT DEFAULT NULL,
            company_tax_id  VARCHAR(64) DEFAULT NULL,
            company_iban    VARCHAR(64) DEFAULT NULL,
            company_bic     VARCHAR(32) DEFAULT NULL,
            invoice_prefix  VARCHAR(16) DEFAULT 'INV',
            next_number     INT DEFAULT 1,
            logo_path       VARCHAR(512) DEFAULT NULL,
            footer_text     TEXT DEFAULT NULL,
            updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('  ✅ Table invoice_settings verified/created.');

    // 4. Seed default settings if not exists
    const [settings] = await db.query('SELECT COUNT(*) AS count FROM invoice_settings WHERE id = 1');
    if (settings[0].count === 0) {
        await db.query(`
            INSERT INTO invoice_settings (id, company_name, company_address, invoice_prefix, next_number)
            VALUES (1, 'OPA! Santorini', 'Main Street 42, 10115 Berlin', 'INV', 1)
        `);
        console.log('  ✅ Seeded default row in invoice_settings.');
    }

    console.log('✅ Migration 0017 up completed.');
}

export async function down(db) {
    console.log('⏬ Migration 0017: Reverting invoice changes...');
    await db.query(`DROP TABLE IF EXISTS invoice_items`);
    await db.query(`DROP TABLE IF EXISTS invoices`);
    await db.query(`DROP TABLE IF EXISTS invoice_settings`);
    console.log('  ✅ Dropped invoice_items, invoices, and invoice_settings tables.');
    console.log('✅ Migration 0017 down completed.');
}

export default up;
