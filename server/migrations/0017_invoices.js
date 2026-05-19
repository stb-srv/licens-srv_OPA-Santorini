/**
 * Migration 0017 – Invoices, Items and Settings
 * Creates the invoices, invoice_items, and invoice_settings tables.
 */
import { DB_SCHEMA } from '../db-schema.js';

export async function up(db) {
    console.log('⏫ Migration 0017: Creating billing schema tables...');

    // 1. Create invoices table (WITHOUT foreign keys initially)
    await db.query(`
        CREATE TABLE IF NOT EXISTS invoices (
            id              ${DB_SCHEMA.PK.invoices} NOT NULL PRIMARY KEY,
            invoice_number  VARCHAR(32) NOT NULL UNIQUE,
            customer_id     ${DB_SCHEMA.PK.customers} NOT NULL,
            license_key     ${DB_SCHEMA.PK.licenses} DEFAULT NULL,
            status          ENUM('draft', 'sent', 'paid', 'overdue', 'cancelled') DEFAULT 'draft',
            type            ENUM('invoice', 'credit_note', 'reminder') DEFAULT 'invoice',
            amount_net      ${DB_SCHEMA.FIELDS.money} NOT NULL,
            amount_tax      ${DB_SCHEMA.FIELDS.money} NOT NULL DEFAULT 0.00,
            amount_gross    ${DB_SCHEMA.FIELDS.money} NOT NULL,
            tax_rate        ${DB_SCHEMA.FIELDS.taxRate} NOT NULL DEFAULT 19.00,
            currency        ${DB_SCHEMA.FIELDS.currency} NOT NULL DEFAULT 'EUR',
            due_date        DATE DEFAULT NULL,
            paid_at         ${DB_SCHEMA.FIELDS.timestamp} DEFAULT NULL,
            sent_at         ${DB_SCHEMA.FIELDS.timestamp} DEFAULT NULL,
            notes           ${DB_SCHEMA.FIELDS.longText} DEFAULT NULL,
            pdf_path        ${DB_SCHEMA.FIELDS.shortText} DEFAULT NULL,
            created_by      ${DB_SCHEMA.FIELDS.shortText} DEFAULT 'system',
            created_at      ${DB_SCHEMA.FIELDS.timestamp} DEFAULT CURRENT_TIMESTAMP,
            updated_at      ${DB_SCHEMA.FIELDS.timestamp} DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
            
            INDEX idx_customer_id (customer_id),
            INDEX idx_license_key (license_key),
            INDEX idx_status (status),
            INDEX idx_type (type),
            INDEX idx_due_date (due_date)
        ) ENGINE=${DB_SCHEMA.ENGINE} DEFAULT CHARSET=${DB_SCHEMA.CHARSET};
    `);
    console.log('  ✅ Table invoices verified/created.');

    // Robust constraint adding for fk_invoices_customer
    try {
        const [custColumns] = await db.query(`
            SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'customers' 
              AND COLUMN_NAME = 'id'
        `);
        if (custColumns.length > 0) {
            const { DATA_TYPE, CHARACTER_MAXIMUM_LENGTH } = custColumns[0];
            if (DATA_TYPE.toLowerCase() !== 'char' || parseInt(CHARACTER_MAXIMUM_LENGTH) !== 36) {
                console.warn(`⚠️  customers.id hat unerwarteten Typ (${DATA_TYPE}(${CHARACTER_MAXIMUM_LENGTH})) — Foreign Key fk_invoices_customer wird OHNE Constraint angelegt. Bitte customers.id auf CHAR(36) migrieren.`);
            } else {
                const [existingFkCustomer] = await db.query(`
                    SELECT CONSTRAINT_NAME
                    FROM information_schema.KEY_COLUMN_USAGE
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME = 'invoices'
                      AND CONSTRAINT_NAME = 'fk_invoices_customer'
                `);
                if (existingFkCustomer.length === 0) {
                    await db.query(`
                        ALTER TABLE invoices ADD CONSTRAINT fk_invoices_customer 
                        FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT
                    `);
                    console.log('  ✅ Constraint fk_invoices_customer added.');
                } else {
                    console.log('  ⏭  Constraint fk_invoices_customer already exists.');
                }
            }
        } else {
            console.warn('⚠️  Tabelle customers oder Spalte id existiert nicht — Foreign Key fk_invoices_customer wird übersprungen.');
        }
    } catch (e) {
        console.error('❌ Fehler bei Foreign Key Prüfung (fk_invoices_customer):', e.message);
    }

    // Robust constraint adding for fk_invoices_license
    try {
        const [licenseColumns] = await db.query(`
            SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH 
            FROM information_schema.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE() 
              AND TABLE_NAME = 'licenses' 
              AND COLUMN_NAME = 'license_key'
        `);
        if (licenseColumns.length > 0) {
            const { DATA_TYPE, CHARACTER_MAXIMUM_LENGTH } = licenseColumns[0];
            if (DATA_TYPE.toLowerCase() !== 'varchar' || parseInt(CHARACTER_MAXIMUM_LENGTH) !== 64) {
                console.warn(`⚠️  licenses.license_key hat unerwarteten Typ (${DATA_TYPE}(${CHARACTER_MAXIMUM_LENGTH})) — Foreign Key fk_invoices_license wird OHNE Constraint angelegt. Bitte licenses.license_key auf VARCHAR(64) migrieren.`);
            } else {
                const [existingFkLicense] = await db.query(`
                    SELECT CONSTRAINT_NAME
                    FROM information_schema.KEY_COLUMN_USAGE
                    WHERE TABLE_SCHEMA = DATABASE()
                      AND TABLE_NAME = 'invoices'
                      AND CONSTRAINT_NAME = 'fk_invoices_license'
                `);
                if (existingFkLicense.length === 0) {
                    await db.query(`
                        ALTER TABLE invoices ADD CONSTRAINT fk_invoices_license 
                        FOREIGN KEY (license_key) REFERENCES licenses(license_key) ON DELETE SET NULL
                    `);
                    console.log('  ✅ Constraint fk_invoices_license added.');
                } else {
                    console.log('  ⏭  Constraint fk_invoices_license already exists.');
                }
            }
        } else {
            console.warn('⚠️  Tabelle licenses oder Spalte license_key existiert nicht — Foreign Key fk_invoices_license wird übersprungen.');
        }
    } catch (e) {
        console.error('❌ Fehler bei Foreign Key Prüfung (fk_invoices_license):', e.message);
    }

    // 2. Create invoice_items table (invoice_id uses PK.invoices type to match invoices.id)
    await db.query(`
        CREATE TABLE IF NOT EXISTS invoice_items (
            id           ${DB_SCHEMA.PK.invoice_items} AUTO_INCREMENT PRIMARY KEY,
            invoice_id   ${DB_SCHEMA.PK.invoices} NOT NULL,
            description  ${DB_SCHEMA.FIELDS.shortText} NOT NULL,
            quantity     DECIMAL(10,2) NOT NULL DEFAULT 1.00,
            unit_price   ${DB_SCHEMA.FIELDS.money} NOT NULL,
            total        ${DB_SCHEMA.FIELDS.money} NOT NULL,
            sort_order   INT DEFAULT 0,
            
            INDEX idx_invoice_id (invoice_id),
            
            CONSTRAINT fk_items_invoice FOREIGN KEY (invoice_id) 
                REFERENCES invoices(id) ON DELETE CASCADE
        ) ENGINE=${DB_SCHEMA.ENGINE} DEFAULT CHARSET=${DB_SCHEMA.CHARSET};
    `);
    console.log('  ✅ Table invoice_items verified/created.');

    // 3. Create invoice_settings table
    await db.query(`
        CREATE TABLE IF NOT EXISTS invoice_settings (
            id              INT PRIMARY KEY DEFAULT 1,
            company_name    ${DB_SCHEMA.FIELDS.shortText} DEFAULT NULL,
            company_address ${DB_SCHEMA.FIELDS.longText} DEFAULT NULL,
            company_tax_id  VARCHAR(64) DEFAULT NULL,
            company_iban    VARCHAR(64) DEFAULT NULL,
            company_bic     VARCHAR(32) DEFAULT NULL,
            invoice_prefix  VARCHAR(16) DEFAULT 'INV',
            next_number     INT DEFAULT 1,
            logo_path       ${DB_SCHEMA.FIELDS.shortText} DEFAULT NULL,
            footer_text     ${DB_SCHEMA.FIELDS.longText} DEFAULT NULL,
            updated_at      ${DB_SCHEMA.FIELDS.timestamp} DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=${DB_SCHEMA.ENGINE} DEFAULT CHARSET=${DB_SCHEMA.CHARSET};
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
    
    // Drop constraints if they exist
    try {
        const [existingFkCustomer] = await db.query(`
            SELECT CONSTRAINT_NAME
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'invoices'
              AND CONSTRAINT_NAME = 'fk_invoices_customer'
        `);
        if (existingFkCustomer.length > 0) {
            await db.query(`ALTER TABLE invoices DROP FOREIGN KEY fk_invoices_customer`);
        }
    } catch(e) {}

    try {
        const [existingFkLicense] = await db.query(`
            SELECT CONSTRAINT_NAME
            FROM information_schema.KEY_COLUMN_USAGE
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'invoices'
              AND CONSTRAINT_NAME = 'fk_invoices_license'
        `);
        if (existingFkLicense.length > 0) {
            await db.query(`ALTER TABLE invoices DROP FOREIGN KEY fk_invoices_license`);
        }
    } catch(e) {}

    await db.query(`DROP TABLE IF EXISTS invoice_items`);
    await db.query(`DROP TABLE IF EXISTS invoices`);
    await db.query(`DROP TABLE IF EXISTS invoice_settings`);
    console.log('  ✅ Dropped invoice_items, invoices, and invoice_settings tables.');
    console.log('✅ Migration 0017 down completed.');
}

export default up;
