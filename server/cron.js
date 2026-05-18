import db from './db.js';
import { sendTemplateMail } from './mailer/index.js';
import { addAuditLog } from './helpers.js';
import { fireWebhook } from './webhook.js';

export async function runExpiryCron() {
    try {
        const [expiring] = await db.query(`
            SELECT l.license_key, l.customer_name, l.type, l.expires_at, l.notes, c.email
            FROM licenses l
            LEFT JOIN customers c ON l.customer_id = c.id
            WHERE l.status = 'active'
              AND l.expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)
              AND l.expiry_notified_at IS NULL
        `);

        for (const lic of expiring) {
            // Fix #9: Für Trial-Lizenzen contact_email aus notes JSON lesen
            let email = lic.email;
            if (!email && lic.notes) {
                try {
                    const parsed = JSON.parse(lic.notes);
                    email = parsed.contact_email || null;
                } catch (e) { /* notes nicht parsebar, ignorieren */ }
            }

            if (!email) continue;

            const daysLeft = Math.ceil((new Date(lic.expires_at) - new Date()) / 86400000);
            try {
                await sendTemplateMail('licenseExpiringSoon', email, {
                    customer_name: lic.customer_name,
                    license_key:   lic.license_key,
                    type:          lic.type,
                    expires_at:    lic.expires_at,
                    days_left:     daysLeft
                });
                await db.query(
                    'UPDATE licenses SET expiry_notified_at = NOW() WHERE license_key = ?',
                    [lic.license_key]
                );
                await addAuditLog('expiry_notification_sent', { license_key: lic.license_key, days_left: daysLeft, email });
            } catch (e) {
                console.warn(`📧 Ablauf-Mail fehlgeschlagen für ${lic.license_key}:`, e.message);
            }
        }

        // 2. 7-Tage Erinnerung (Zweite Mahnung)
        const [expiring7d] = await db.query(`
            SELECT l.license_key, l.customer_name, l.type, l.expires_at, l.notes, c.email
            FROM licenses l
            LEFT JOIN customers c ON l.customer_id = c.id
            WHERE l.status = 'active'
              AND l.expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)
              AND l.expiry_notified_7d_at IS NULL
        `);

        for (const lic of expiring7d) {
            let email = lic.email;
            if (!email && lic.notes) {
                try {
                    const parsed = JSON.parse(lic.notes);
                    email = parsed.contact_email || null;
                } catch (e) {}
            }
            if (!email) continue;

            const daysLeft = Math.ceil((new Date(lic.expires_at) - new Date()) / 86400000);
            try {
                await sendTemplateMail('licenseExpiring7d', email, {
                    customer_name: lic.customer_name,
                    license_key:   lic.license_key,
                    type:          lic.type,
                    expires_at:    lic.expires_at
                });
                await db.query(
                    'UPDATE licenses SET expiry_notified_7d_at = NOW() WHERE license_key = ?',
                    [lic.license_key]
                );
                await addAuditLog('expiry_notification_7d_sent', { license_key: lic.license_key, days_left: daysLeft, email });
            } catch (e) {
                console.warn(`📧 7-Tage-Ablauf-Mail fehlgeschlagen für ${lic.license_key}:`, e.message);
            }
        }

        const [result] = await db.query(`
            UPDATE licenses SET status = 'expired'
            WHERE status = 'active' AND expires_at < NOW()
        `);
        if (result.affectedRows > 0) {
            console.log(`🕐 ${result.affectedRows} Lizenz(en) auf 'expired' gesetzt.`);
            await addAuditLog('licenses_auto_expired', { count: result.affectedRows });
            await fireWebhook('licenses.auto_expired', { count: result.affectedRows });
        }
    } catch (e) {
        console.error('Expiry-Cron Fehler:', e.message);
    }
}

export async function runNonceCleanup() {
    try {
        const [nonceResult] = await db.query(
            'DELETE FROM used_nonces WHERE ts < ?',
            [Date.now() - 2 * 60 * 60 * 1000]
        );
        if (nonceResult.affectedRows > 0)
            console.log(`🧹 ${nonceResult.affectedRows} abgelaufene Nonce(s) bereinigt.`);

        const [sessResult] = await db.query(
            'DELETE FROM customer_sessions WHERE expires_at < NOW() OR revoked = 1'
        );
        if (sessResult.affectedRows > 0)
            console.log(`🧹 ${sessResult.affectedRows} abgelaufene Kunden-Session(s) bereinigt.`);

        const [adminSessResult] = await db.query(
            'DELETE FROM admin_sessions WHERE expires_at < NOW() OR revoked = 1'
        );
        if (adminSessResult.affectedRows > 0)
            console.log(`🧹 ${adminSessResult.affectedRows} abgelaufene Admin-Session(s) bereinigt.`);

    } catch (e) {
        console.error('Nonce/Session-Cleanup Fehler:', e.message);
    }
}

/**
 * Routine to mark sent invoices as overdue once they pass their due date,
 * and email a warning to the customer.
 */
export async function runOverdueInvoiceCron() {
    try {
        const [overdueInvoices] = await db.query(`
            SELECT i.id, i.invoice_number, i.customer_id, i.amount_gross, i.due_date, c.email, c.name AS customer_name
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            WHERE i.status = 'sent' AND i.due_date < CURDATE()
        `);

        for (const invoice of overdueInvoices) {
            const conn = await db.getConnection();
            try {
                await conn.beginTransaction();

                // 1. Update invoice status to 'overdue'
                await conn.query("UPDATE invoices SET status = 'overdue' WHERE id = ?", [invoice.id]);

                // 2. Update customer payment_status to 'overdue'
                await conn.query("UPDATE customers SET payment_status = 'overdue' WHERE id = ?", [invoice.customer_id]);

                await conn.commit();

                await addAuditLog('invoice_auto_overdue', { invoice_id: invoice.id, invoice_number: invoice.invoice_number, customer_id: invoice.customer_id });

                // 3. Send warning email
                if (invoice.email) {
                    try {
                        const portalUrl = (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
                        const invoiceUrl = `${portalUrl}/portal.html?tab=invoices`;

                        await sendTemplateMail('invoiceOverdue', invoice.email, {
                            customer_name: invoice.customer_name,
                            invoice_number: invoice.invoice_number,
                            amount_gross: invoice.amount_gross,
                            due_date: invoice.due_date,
                            invoice_url: invoiceUrl
                        });
                    } catch (mailErr) {
                        console.warn(`📧 Mahn-Mail fehlgeschlagen für ${invoice.invoice_number}:`, mailErr.message);
                    }
                }
            } catch (err) {
                await conn.rollback();
                console.error(`Fehler bei Mahnung für Rechnung ${invoice.invoice_number}:`, err.message);
            } finally {
                conn.release();
            }
        }
    } catch (e) {
        console.error('Overdue-Invoice-Cron Fehler:', e.message);
    }
}

/**
 * Routine to automatically generate a draft invoice for paid plans
 * that expire in exactly 7 days, avoiding duplicate invoices in a 30-day window.
 */
export async function runAutoInvoiceCron() {
    try {
        const { createInvoiceFromLicense } = await import('./invoiceHelper.js');

        // Find active licenses that expire in the next 7 days on paid plans
        const [licenses] = await db.query(`
            SELECT l.license_key, l.type, l.customer_id
            FROM licenses l
            WHERE l.status = 'active'
              AND l.type IN ('STARTER', 'PRO', 'PRO_PLUS', 'ENTERPRISE')
              AND l.expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)
        `);

        for (const lic of licenses) {
            // Check if an invoice has already been created for this license in the last 30 days
            const [existing] = await db.query(`
                SELECT id FROM invoices 
                WHERE license_key = ? 
                  AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
                LIMIT 1
            `, [lic.license_key]);

            if (existing.length > 0) {
                continue; // Already invoiced in the last 30 days
            }

            try {
                // Generate draft invoice via helper
                const invoiceId = await createInvoiceFromLicense(db, lic.license_key, 'cron');
                await addAuditLog('invoice_auto_generated', { license_key: lic.license_key, invoice_id: invoiceId, customer_id: lic.customer_id });
                console.log(`🧾 Auto-Rechnung (Draft) erstellt für Lizenz: ${lic.license_key}`);
            } catch (err) {
                console.error(`Fehler bei Auto-Rechnung für Lizenz ${lic.license_key}:`, err.message);
            }
        }
    } catch (e) {
        console.error('Auto-Invoice-Cron Fehler:', e.message);
    }
}

export function startCron() {
    setInterval(runExpiryCron, 24 * 60 * 60 * 1000);
    runExpiryCron();

    setInterval(runNonceCleanup, 60 * 60 * 1000);
    runNonceCleanup();

    setInterval(runOverdueInvoiceCron, 24 * 60 * 60 * 1000);
    runOverdueInvoiceCron();

    setInterval(runAutoInvoiceCron, 24 * 60 * 60 * 1000);
    runAutoInvoiceCron();
}
