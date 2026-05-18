import crypto from 'crypto';
import { PLAN_DEFINITIONS } from './plans.js';

// Central price map matching existing admin pricing definitions
const priceMap = {
    FREE: 0.00,
    TRIAL: 0.00,
    STARTER: 29.00,
    PRO: 59.00,
    PRO_PLUS: 89.00,
    ENTERPRISE: 199.00
};

/**
 * Generates the next sequential invoice number and increments the counter in invoice_settings atomically.
 * @param {object} db - MySQL Connection or Pool
 * @returns {Promise<string>} Generated invoice number
 */
export async function generateInvoiceNumber(db) {
    // 1. Get settings and lock the row for update (if in transaction)
    const [[settings]] = await db.query(
        'SELECT invoice_prefix, next_number FROM invoice_settings WHERE id = 1 FOR UPDATE'
    );
    
    if (!settings) {
        throw new Error('Invoice settings with ID 1 not found in database.');
    }

    const prefix = settings.invoice_prefix || 'INV';
    const nextNumber = settings.next_number || 1;
    const year = new Date().getFullYear();
    const paddedNumber = String(nextNumber).padStart(4, '0');
    const invoiceNumber = `${prefix}-${year}-${paddedNumber}`;

    // 2. Increment next_number atomically
    await db.query(
        'UPDATE invoice_settings SET next_number = next_number + 1 WHERE id = 1'
    );

    return invoiceNumber;
}

/**
 * Calculates net, tax, and gross amounts for a list of invoice items.
 * @param {Array<{quantity: number, unit_price: number}>} items - List of items
 * @param {number} taxRate - Tax percentage (e.g. 19.00)
 * @returns {{amount_net: number, amount_tax: number, amount_gross: number}}
 */
export function calculateInvoiceTotals(items, taxRate) {
    let amount_net = 0;
    
    for (const item of items) {
        const qty = parseFloat(item.quantity) || 0;
        const price = parseFloat(item.unit_price) || 0;
        amount_net += qty * price;
    }

    amount_net = parseFloat(amount_net.toFixed(2));
    const rate = parseFloat(taxRate) || 0;
    const amount_tax = parseFloat((amount_net * (rate / 100)).toFixed(2));
    const amount_gross = parseFloat((amount_net + amount_tax).toFixed(2));

    return { amount_net, amount_tax, amount_gross };
}

/**
 * Automatically creates a draft invoice and an invoice item (license fee) for a license in a transaction.
 * @param {object} db - MySQL Connection or Pool
 * @param {string} licenseKey - License key to invoice
 * @param {string} createdBy - Initiator of the invoice
 * @returns {Promise<string>} Created invoice ID (UUID)
 */
export async function createInvoiceFromLicense(db, licenseKey, createdBy = 'system') {
    const conn = await db.getConnection();
    
    try {
        await conn.beginTransaction();

        // 1. Get license details
        const [[license]] = await conn.query(
            'SELECT * FROM licenses WHERE license_key = ?',
            [licenseKey]
        );
        if (!license) {
            throw new Error(`License with key ${licenseKey} not found.`);
        }
        if (!license.customer_id) {
            throw new Error(`License with key ${licenseKey} has no customer linked.`);
        }

        // 2. Get customer details
        const [[customer]] = await conn.query(
            'SELECT name, currency FROM customers WHERE id = ?',
            [license.customer_id]
        );
        if (!customer) {
            throw new Error(`Customer with ID ${license.customer_id} linked to license ${licenseKey} not found.`);
        }

        // 3. Determine price based on license type
        const planType = license.type || 'FREE';
        const planDetails = PLAN_DEFINITIONS[planType] || { label: planType };
        const price = priceMap[planType] || 0.00;

        const items = [{
            description: `Lizenzgebühr OPA! Santorini - ${planDetails.label || planType}`,
            quantity: 1,
            unit_price: price
        }];

        const taxRate = 19.00; // Standard German tax rate
        const { amount_net, amount_tax, amount_gross } = calculateInvoiceTotals(items, taxRate);

        // 4. Generate next invoice number within transaction
        const invoiceNumber = await generateInvoiceNumber(conn);

        // 5. Create invoice
        const invoiceId = crypto.randomUUID();
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 14); // 14 days payment terms
        const dueDateStr = dueDate.toISOString().slice(0, 10);
        const currency = customer.currency || 'EUR';

        await conn.query(`
            INSERT INTO invoices (
                id, invoice_number, customer_id, license_key, status, type,
                amount_net, amount_tax, amount_gross, tax_rate, currency,
                due_date, created_by
            ) VALUES (?, ?, ?, ?, 'draft', 'invoice', ?, ?, ?, ?, ?, ?, ?)
        `, [
            invoiceId, invoiceNumber, license.customer_id, licenseKey,
            amount_net, amount_tax, amount_gross, taxRate, currency,
            dueDateStr, createdBy
        ]);

        // 6. Create invoice item
        await conn.query(`
            INSERT INTO invoice_items (
                invoice_id, description, quantity, unit_price, total, sort_order
            ) VALUES (?, ?, ?, ?, ?, 0)
        `, [
            invoiceId, items[0].description, items[0].quantity, items[0].unit_price, amount_net
        ]);

        await conn.commit();
        return invoiceId;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

/**
 * Returns a fully joined invoice details object including all items and customer info.
 * @param {object} db - MySQL Connection or Pool
 * @param {string} invoiceId - UUID of the invoice
 * @returns {Promise<object|null>} Complete invoice details or null if not found
 */
export async function getInvoiceWithItems(db, invoiceId) {
    const [[invoice]] = await db.query(`
        SELECT i.*, 
               c.name AS customer_name, 
               c.email AS customer_email, 
               c.phone AS customer_phone,
               c.company AS customer_company,
               c.billing_address AS customer_billing_address,
               c.tax_id AS customer_tax_id,
               c.country AS customer_country
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        WHERE i.id = ?
    `, [invoiceId]);

    if (!invoice) return null;

    const [items] = await db.query(`
        SELECT * FROM invoice_items 
        WHERE invoice_id = ? 
        ORDER BY sort_order ASC, id ASC
    `, [invoiceId]);

    invoice.items = items;
    return invoice;
}
