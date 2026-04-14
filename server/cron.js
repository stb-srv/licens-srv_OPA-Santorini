import db from './db.js';
import { sendTemplateMail } from './mailer/index.js';
import { addAuditLog } from './helpers.js';
import { fireWebhook } from './webhook.js';

export async function runExpiryCron() {
    try {
        const [expiring] = await db.query(`
            SELECT l.license_key, l.customer_name, l.type, l.expires_at, c.email
            FROM licenses l
            LEFT JOIN customers c ON l.customer_id = c.id
            WHERE l.status = 'active'
              AND l.expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)
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

        await db.query('DELETE FROM used_nonces WHERE ts < ?', [Date.now() - 5 * 60 * 1000]);
    } catch (e) {
        console.error('Expiry-Cron Fehler:', e.message);
    }
}

export function startCron() {
    setInterval(runExpiryCron, 24 * 60 * 60 * 1000);
    runExpiryCron();
}
