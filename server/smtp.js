/**
 * server/smtp.js
 * Legacy-Kompatibilitäts-Wrapper.
 * Alle echten Funktionen liegen in server/mailer/index.js
 */
import {
    buildTransporter as createSmtpTransporter,
    getActiveSmtpConfig,
    sendMail,
    sendTemplateMail,
    verifySmtp
} from './mailer/index.js';

// getActiveSmtp wird an einigen Stellen im alten Code noch verwendet
async function getActiveSmtp() {
    const cfg = await getActiveSmtpConfig();
    if (!cfg) return null;
    const transporter = createSmtpTransporter(cfg);
    return { transporter, from: cfg.from };
}

const envSmtp = {
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT || '587',
    secure: process.env.SMTP_SECURE || 'false',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || ''
};

export {
    createSmtpTransporter,
    getActiveSmtp,
    getActiveSmtpConfig,
    sendMail,
    sendTemplateMail,
    verifySmtp,
    envSmtp
};
