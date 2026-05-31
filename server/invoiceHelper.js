import crypto from 'crypto';
import { query, runTransaction } from './db.js';
import { PLAN_DEFINITIONS } from './plans.js';

const priceMap = {
    FREE: 0.00,
    TRIAL: 0.00,
    STARTER: 29.00,
    PRO: 59.00,
    PRO_PLUS: 89.00,
    ENTERPRISE: 199.00
};

function toDbDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

export function generateInvoiceNumber() {
    const [settings] = query('SELECT invoice_prefix, next_number FROM invoice_settings WHERE id = 1');
    if (!settings) throw new Error('Invoice settings with ID 1 not found in database.');

    const prefix = settings.invoice_prefix || 'INV';
    const nextNumber = settings.next_number || 1;
    const year = new Date().getFullYear();
    const paddedNumber = String(nextNumber).padStart(4, '0');
    const invoiceNumber = `${prefix}-${year}-${paddedNumber}`;

    query('UPDATE invoice_settings SET next_number = next_number + 1 WHERE id = 1');
    return invoiceNumber;
}

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

export function createInvoiceFromLicense(licenseKey, createdBy = 'system') {
    return runTransaction(() => {
        const [license] = query('SELECT * FROM licenses WHERE license_key = ?', [licenseKey]);
        if (!license) throw new Error(`License with key ${licenseKey} not found.`);
        if (!license.customer_id) throw new Error(`License with key ${licenseKey} has no customer linked.`);

        const [customer] = query('SELECT name, currency FROM customers WHERE id = ?', [license.customer_id]);
        if (!customer) throw new Error(`Customer with ID ${license.customer_id} linked to license ${licenseKey} not found.`);

        const planType = license.type || 'FREE';
        const planDetails = PLAN_DEFINITIONS[planType] || { label: planType };
        const price = priceMap[planType] || 0.00;

        const items = [{
            description: `Lizenzgebühr OPA! Santorini - ${planDetails.label || planType}`,
            quantity: 1,
            unit_price: price
        }];

        const taxRate = 19.00;
        const { amount_net, amount_tax, amount_gross } = calculateInvoiceTotals(items, taxRate);

        const invoiceNumber = generateInvoiceNumber();
        const invoiceId = crypto.randomUUID();
        const dueDate = toDbDate(new Date(Date.now() + 14 * 86400000));
        const currency = customer.currency || 'EUR';

        query(
            `INSERT INTO invoices (
                id, invoice_number, customer_id, license_key, status, type,
                amount_net, amount_tax, amount_gross, tax_rate, currency,
                due_date, created_by
            ) VALUES (?, ?, ?, ?, 'draft', 'invoice', ?, ?, ?, ?, ?, ?, ?)`,
            [invoiceId, invoiceNumber, license.customer_id, licenseKey,
             amount_net, amount_tax, amount_gross, taxRate, currency, dueDate, createdBy]
        );

        query(
            `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total, sort_order)
             VALUES (?, ?, ?, ?, ?, 0)`,
            [invoiceId, items[0].description, items[0].quantity, items[0].unit_price, amount_net]
        );

        return invoiceId;
    });
}

export function getInvoiceWithItems(invoiceId) {
    const [invoice] = query(
        `SELECT i.*,
                c.name AS customer_name,
                c.email AS customer_email,
                c.phone AS customer_phone,
                c.company AS customer_company,
                c.billing_street AS customer_billing_street,
                c.billing_city AS customer_billing_city,
                c.billing_zip AS customer_billing_zip,
                c.billing_country AS customer_billing_country,
                c.tax_id AS customer_tax_id
         FROM invoices i
         JOIN customers c ON i.customer_id = c.id
         WHERE i.id = ?`,
        [invoiceId]
    );
    if (!invoice) return null;

    const [items] = query(
        `SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC, id ASC`,
        [invoiceId]
    );
    invoice.items = items;
    return invoice;
}

export { createInvoiceFromLicense as createInvoice };
