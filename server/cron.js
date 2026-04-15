import db from './db.js';
import { sendTemplateMail } from './mailer/index.js';
import { addAuditLog } from './helpers.js';
import { fireWebhook } from './webhook.js';

export async function runExpiryCron() {
    try {
        // Fix #3: Nur Lizenzen benachrichtigen, für die noch KEINE Mail gesendet wurde
        const [expiring] = await db.query(`
            SELECT l.license_key, l.customer_name, l.type, l.expires_at, c.email
            FROM licenses l
            LEFT JOIN customers c ON l.customer_id = c.id
            WHERE l.status = 'active'
              AND l.expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)
              AND l.expiry_notified_at IS NULL
        `);

        for (const lic of expiring) {
            if (!lic.email) continue;
            const daysLeft = Math.ceil((new Date(lic.expires_at) - new Date()) / 86400000);
            try {
                await sendTemplateMail('licenseExpiringSoon', lic.email, {
                    customer_name: lic.customer_name,
                    license_key:   lic.license_key,
                    type:          lic.type,
                    expires_at:    lic.expires_at,
                    days_left:     daysLeft
                });
                // Merken dass wir diese Lizenz benachrichtigt haben
                await db.query(
                    'UPDATE licenses SET expiry_notified_at = NOW() WHERE license_key = ?',
                    [lic.license_key]
                );
                await addAuditLog('expiry_notification_sent', { license_key: lic.license_key, days_left: daysLeft, email: lic.email });
            } catch (e) {
                console.warn(`📧 Ablauf-Mail fehlgeschlagen für ${lic.license_key}:`, e.message);
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

// Fix #7: Nonce-Cleanup in eigenem Intervall (stündlich), TTL = 2 Stunden
export async function runNonceCleanup() {
    try {
        const [result] = await db.query(
            'DELETE FROM used_nonces WHERE ts < ?',
            [Date.now() - 2 * 60 * 60 * 1000]  // 2h TTL statt 5min
        );
        if (result.affectedRows > 0)
            console.log(`🧹 ${result.affectedRows} abgelaufene Nonce(s) bereinigt.`);
    } catch (e) {
        console.error('Nonce-Cleanup Fehler:', e.message);
    }
}

export function startCron() {
    // Expiry-Check: täglich
    setInterval(runExpiryCron, 24 * 60 * 60 * 1000);
    runExpiryCron();

    // Nonce-Cleanup: stündlich (Fix #7)
    setInterval(runNonceCleanup, 60 * 60 * 1000);
    runNonceCleanup();
}
