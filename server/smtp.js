import nodemailer from 'nodemailer';
import db from './db.js';

const envSmtp = {
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT || '587',
    secure: process.env.SMTP_SECURE || 'false',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || ''
};

export function createSmtpTransporter(config) {
    if (!config.host || !config.user || !config.pass) return null;
    return nodemailer.createTransport({
        host: config.host,
        port: parseInt(config.port) || 587,
        secure: config.secure === 'true' || config.secure === true,
        auth: { user: config.user, pass: config.pass }
    });
}

let envTransporter = null;
if (envSmtp.host && envSmtp.user && envSmtp.pass) {
    envTransporter = createSmtpTransporter(envSmtp);
    console.log('📧  SMTP: Konfiguriert über .env');
}

export async function getActiveSmtp() {
    const [rows] = await db.query('SELECT * FROM smtp_config WHERE id = 1 LIMIT 1');
    const cfg = rows[0];
    if (cfg?.host && cfg?.smtp_user && cfg?.smtp_pass) {
        const t = createSmtpTransporter({ host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.smtp_user, pass: cfg.smtp_pass });
        return { transporter: t, from: cfg.smtp_from || cfg.smtp_user };
    }
    if (envTransporter) return { transporter: envTransporter, from: envSmtp.from || envSmtp.user };
    return null;
}

export async function sendMail(to, subject, html) {
    const smtp = await getActiveSmtp();
    if (!smtp) throw new Error('SMTP nicht konfiguriert');
    await smtp.transporter.sendMail({ from: smtp.from, to, subject, html });
}

export { envSmtp };
