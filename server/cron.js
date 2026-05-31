import db from './db.js';
import { sendTemplateMail } from './mailer/index.js';
import { addAuditLog } from './helpers.js';
import { fireWebhook } from './webhook.js';
import { createInvoiceFromLicense } from './invoiceHelper.js';

export async function runExpiryCron() {
    try {
        const [expiring] = db.query(`
            SELECT l.license_key, l.customer_name, l.type, l.expires_at, l.notes, c.email
            FROM licenses l
            LEFT JOIN customers c ON l.customer_id = c.id
            WHERE l.status = 'active'
              AND l.expires_at BETWEEN datetime('now') AND datetime('now', '+30 days')
              AND l.expiry_notified_at IS NULL
        `);

        for (const lic of expiring) {
            let email = lic.email;
            if (!email && lic.notes) {
                try { email = JSON.parse(lic.notes).contact_email || null; } catch {}
            }
            if (!email) continue;

            const daysLeft = Math.ceil((new Date(lic.expires_at) - new Date()) / 86400000);
            try {
                await sendTemplateMail('licenseExpiringSoon', email, {
                    customer_name: lic.customer_name, license_key: lic.license_key,
                    type: lic.type, expires_at: lic.expires_at, days_left: daysLeft
                });
                db.query(
                    `UPDATE licenses SET expiry_notified_at = datetime('now') WHERE license_key = ?`,
                    [lic.license_key]
                );
                await addAuditLog('expiry_notification_sent', { license_key: lic.license_key, days_left: daysLeft, email });
            } catch (e) {
                console.warn(`📧 Ablauf-Mail fehlgeschlagen für ${lic.license_key}:`, e.message);
            }
        }

        const [expiring7d] = db.query(`
            SELECT l.license_key, l.customer_name, l.type, l.expires_at, l.notes, c.email
            FROM licenses l
            LEFT JOIN customers c ON l.customer_id = c.id
            WHERE l.status = 'active'
              AND l.expires_at BETWEEN datetime('now') AND datetime('now', '+7 days')
              AND l.expiry_notified_7d_at IS NULL
        `);

        for (const lic of expiring7d) {
            let email = lic.email;
            if (!email && lic.notes) {
                try { email = JSON.parse(lic.notes).contact_email || null; } catch {}
            }
            if (!email) continue;

            const daysLeft = Math.ceil((new Date(lic.expires_at) - new Date()) / 86400000);
            try {
                await sendTemplateMail('licenseExpiring7d', email, {
                    customer_name: lic.customer_name, license_key: lic.license_key,
                    type: lic.type, expires_at: lic.expires_at
                });
                db.query(
                    `UPDATE licenses SET expiry_notified_7d_at = datetime('now') WHERE license_key = ?`,
                    [lic.license_key]
                );
                await addAuditLog('expiry_notification_7d_sent', { license_key: lic.license_key, days_left: daysLeft, email });
            } catch (e) {
                console.warn(`📧 7-Tage-Ablauf-Mail fehlgeschlagen für ${lic.license_key}:`, e.message);
            }
        }

        const [result] = db.query(
            `UPDATE licenses SET status = 'expired' WHERE status = 'active' AND expires_at < datetime('now')`
        );
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
        const [nonceResult] = db.query(
            'DELETE FROM used_nonces WHERE ts < ?',
            [Date.now() - 2 * 60 * 60 * 1000]
        );
        if (nonceResult.affectedRows > 0)
            console.log(`🧹 ${nonceResult.affectedRows} abgelaufene Nonce(s) bereinigt.`);

        const [sessResult] = db.query(
            `DELETE FROM customer_sessions WHERE expires_at < datetime('now') OR revoked = 1`
        );
        if (sessResult.affectedRows > 0)
            console.log(`🧹 ${sessResult.affectedRows} abgelaufene Kunden-Session(s) bereinigt.`);

        const [adminSessResult] = db.query(
            `DELETE FROM admin_sessions WHERE expires_at < datetime('now') OR revoked = 1`
        );
        if (adminSessResult.affectedRows > 0)
            console.log(`🧹 ${adminSessResult.affectedRows} abgelaufene Admin-Session(s) bereinigt.`);
    } catch (e) {
        console.error('Nonce/Session-Cleanup Fehler:', e.message);
    }
}

export async function runOverdueInvoiceCron() {
    try {
        const [overdueInvoices] = db.query(`
            SELECT i.id, i.invoice_number, i.customer_id, i.amount_gross, i.due_date, c.email, c.name AS customer_name
            FROM invoices i
            JOIN customers c ON i.customer_id = c.id
            WHERE i.status = 'sent' AND i.due_date < date('now')
        `);

        for (const invoice of overdueInvoices) {
            try {
                db.runTransaction(() => {
                    db.query("UPDATE invoices SET status = 'overdue' WHERE id = ?", [invoice.id]);
                    db.query("UPDATE customers SET payment_status = 'overdue' WHERE id = ?", [invoice.customer_id]);
                });

                await addAuditLog('invoice_auto_overdue', {
                    invoice_id: invoice.id,
                    invoice_number: invoice.invoice_number,
                    customer_id: invoice.customer_id
                });

                if (invoice.email) {
                    try {
                        const portalUrl = (process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
                        await sendTemplateMail('invoiceOverdue', invoice.email, {
                            customer_name: invoice.customer_name,
                            invoice_number: invoice.invoice_number,
                            amount_gross: invoice.amount_gross,
                            due_date: invoice.due_date,
                            invoice_url: `${portalUrl}/portal.html?tab=invoices`
                        });
                    } catch (mailErr) {
                        console.warn(`📧 Mahn-Mail fehlgeschlagen für ${invoice.invoice_number}:`, mailErr.message);
                    }
                }
            } catch (err) {
                console.error(`Fehler bei Mahnung für Rechnung ${invoice.invoice_number}:`, err.message);
            }
        }
    } catch (e) {
        console.error('Overdue-Invoice-Cron Fehler:', e.message);
    }
}

export async function runAutoInvoiceCron() {
    try {
        const [licenses] = db.query(`
            SELECT l.license_key, l.type, l.customer_id
            FROM licenses l
            WHERE l.status = 'active'
              AND l.type IN ('STARTER', 'PRO', 'PRO_PLUS', 'ENTERPRISE')
              AND l.expires_at BETWEEN datetime('now') AND datetime('now', '+7 days')
        `);

        for (const lic of licenses) {
            const [existing] = db.query(
                `SELECT id FROM invoices WHERE license_key = ? AND created_at > datetime('now', '-30 days') LIMIT 1`,
                [lic.license_key]
            );
            if (existing.length > 0) continue;

            try {
                const invoiceId = createInvoiceFromLicense(lic.license_key, 'cron');
                await addAuditLog('invoice_auto_generated', {
                    license_key: lic.license_key, invoice_id: invoiceId, customer_id: lic.customer_id
                });
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

export async function createInvoiceForLicense(licenseId) {
    try {
        const invoiceId = createInvoiceFromLicense(licenseId, 'system');
        await addAuditLog('invoice_auto_generated', { license_key: licenseId, invoice_id: invoiceId });
        console.log(`🧾 Auto-Rechnung (Draft) erstellt für Lizenz bei Erstellung: ${licenseId}`);
        return invoiceId;
    } catch (err) {
        console.error(`Fehler bei Auto-Rechnung für Lizenz ${licenseId}:`, err.message);
        throw err;
    }
}

export async function createInvoiceForRenewal(licenseId) {
    try {
        const invoiceId = createInvoiceFromLicense(licenseId, 'system');
        db.query("UPDATE invoices SET type = 'renewal' WHERE id = ?", [invoiceId]);
        await addAuditLog('invoice_auto_generated', { license_key: licenseId, invoice_id: invoiceId, type: 'renewal' });
        console.log(`🧾 Auto-Rechnung (Renewal) erstellt für Lizenz bei Verlängerung: ${licenseId}`);
        return invoiceId;
    } catch (err) {
        console.error(`Fehler bei Auto-Rechnung (Renewal) für Lizenz ${licenseId}:`, err.message);
        throw err;
    }
}
