/**
 * server/mailer/index.js
 * Zentrales Nodemailer-Modul mit robuster SMTP-Unterstützung.
 * Unterstützt: STARTTLS (Port 587), SSL (Port 465), Plain (Port 25)
 */
import nodemailer from 'nodemailer';
import db from '../db.js';
import { renderTemplate } from './templates.js';

// ── Transporter-Factory ────────────────────────────────────────────────────
export function buildTransporter(cfg) {
    const port = parseInt(cfg.port) || 587;
    const secure = cfg.secure === true || cfg.secure === 'true' || port === 465;

    const options = {
        host: cfg.host,
        port,
        secure,                          // true = SSL direkt (465), false = STARTTLS (587)
        auth: {
            user: cfg.user,
            pass: cfg.pass
        },
        // STARTTLS erzwingen wenn Port 587 und nicht secure
        requireTLS: !secure && port === 587,
        // Timeout erhöhen für langsame Provider
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        // TLS-Optionen: selbstsignierte Zertifikate erlauben (für Eigenserver)
        tls: {
            rejectUnauthorized: false
        },
        logger: false,
        debug: false
    };

    console.log(`[Mailer] Transporter erstellt: ${cfg.host}:${port} secure=${secure} requireTLS=${options.requireTLS}`);
    return nodemailer.createTransport(options);
}

// ── Aktive SMTP-Config laden (DB bevorzugt, dann .env) ─────────────────────
export async function getActiveSmtpConfig() {
    try {
        const [rows] = await db.query('SELECT * FROM smtp_config WHERE id = 1 LIMIT 1');
        const cfg = rows[0];
        if (cfg?.host && cfg?.smtp_user && cfg?.smtp_pass) {
            return {
                host: cfg.host,
                port: cfg.port || '587',
                secure: cfg.secure,
                user: cfg.smtp_user,
                pass: cfg.smtp_pass,
                from: cfg.smtp_from || cfg.smtp_user,
                source: 'database'
            };
        }
    } catch (e) {
        console.warn('[Mailer] DB-Abfrage fehlgeschlagen, fallback auf .env:', e.message);
    }

    // Fallback: .env
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        return {
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT || '587',
            secure: process.env.SMTP_SECURE || 'false',
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            source: 'env'
        };
    }

    return null;
}

// ── Verbindung testen ──────────────────────────────────────────────────────
export async function verifySmtp(cfg) {
    const transporter = buildTransporter(cfg);
    await transporter.verify();
    return transporter;
}

// ── Generische Mail senden ─────────────────────────────────────────────────
export async function sendMail({ to, subject, html, text }) {
    const cfg = await getActiveSmtpConfig();
    if (!cfg) throw new Error('SMTP nicht konfiguriert. Bitte zuerst SMTP-Einstellungen speichern.');

    const transporter = buildTransporter(cfg);

    const info = await transporter.sendMail({
        from: cfg.from,
        to,
        subject,
        html,
        text: text || subject  // Plaintext-Fallback
    });

    console.log(`[Mailer] E-Mail gesendet an ${to} | MessageId: ${info.messageId} | SMTP: ${cfg.source}`);
    return info;
}

// ── Template-Mail senden ───────────────────────────────────────────────────
/**
 * Sendet eine E-Mail anhand eines benannten Templates.
 * @param {string} templateName  - z.B. 'test', 'licenseCreated', 'licenseExpiringSoon'
 * @param {string} to            - Empfänger-Adresse
 * @param {object} data          - Template-Variablen
 */
export async function sendTemplateMail(templateName, to, data = {}) {
    const { subject, html, text } = renderTemplate(templateName, data);
    return sendMail({ to, subject, html, text });
}

// ── Legacy-Export (Kompatibilität mit altem smtp.js) ──────────────────────
export { getActiveSmtpConfig as getActiveSmtp };
