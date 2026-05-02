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
                // Sende die gleiche Vorlage, aber days_left wird der Hinweis auf die 7 Tage sein
                await sendTemplateMail('licenseExpiringSoon', email, {
                    customer_name: lic.customer_name,
                    license_key:   lic.license_key,
                    type:          lic.type,
                    expires_at:    lic.expires_at,
                    days_left:     daysLeft
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

export function startCron() {
    setInterval(runExpiryCron, 24 * 60 * 60 * 1000);
    runExpiryCron();

    setInterval(runNonceCleanup, 60 * 60 * 1000);
    runNonceCleanup();
}
