import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';
const HMAC_SECRET = process.env.HMAC_SECRET || 'hmac-change-me-in-production';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// ─────────────────────────────────────────────────────────────────────────────
// MySQL Connection Pool
// ─────────────────────────────────────────────────────────────────────────────
const db = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'opa_licenses',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+00:00'
});

// Test DB connection on startup
try {
    const conn = await db.getConnection();
    conn.release();
    console.log('✅  MySQL Verbindung erfolgreich');
} catch (e) {
    console.error('❌  MySQL Verbindungsfehler:', e.message);
    process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// RSA Keys
// ─────────────────────────────────────────────────────────────────────────────
const RSA_PRIVATE_KEY = process.env.RSA_PRIVATE_KEY
    ? process.env.RSA_PRIVATE_KEY.replace(/\\n/g, '\n')
    : null;

export const RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAutES8Xqif1PpLJU9ClMJ
rGfeCoUVOOni5/WiwGFdTd5ygYyie22fBheBA2fRek6xXDfGtC/QdIg7zbqI/0eQ
V7DCcytIGJSfPRNW4t6cb7oRUVTbo74jia5GUDyJNLJPQDsPVWDvi6rpB+/hv+Uh
rL3UQbHYwoJi/H5R2uwPsd9JaznGoygWhmaWpueXQkxYMRlupUWD1hT+OBSYWBnI
l7NUVsJ8pDOE2u9REwVgBnJEbdA39YnZ2NB4W/5JZPLsM8pkp1QO32THcHixFUvC
N+xMcoOA3fRdAICdI6kI9LccR4hzr7Btf/8Wbk0erF48Xw5NjFj0CZcRIjegiq2m
HQIDAQAB
-----END PUBLIC KEY-----`;

if (!RSA_PRIVATE_KEY) console.warn('⚠️  RSA_PRIVATE_KEY nicht gesetzt – JWT Signing deaktiviert!');
if (ADMIN_SECRET === 'change-me-in-production') console.warn('⚠️  ADMIN_SECRET ist unsicher!');
if (HMAC_SECRET === 'hmac-change-me-in-production') console.warn('⚠️  HMAC_SECRET ist unsicher!');

const createSignedLicenseToken = (payload, expiresIn = '25h') => {
    if (!RSA_PRIVATE_KEY) return null;
    return jwt.sign(payload, RSA_PRIVATE_KEY, { algorithm: 'RS256', expiresIn });
};

// ─────────────────────────────────────────────────────────────────────────────
// OPA! Santorini Plan Definitionen
// ─────────────────────────────────────────────────────────────────────────────
export const PLAN_DEFINITIONS = {
    FREE: {
        label: 'Free',
        menu_items: 30,
        max_tables: 5,
        expires_days: 36500,
        modules: {
            menu_edit: true,
            multilanguage: false,
            seasonal_menu: false,
            orders_kitchen: false,
            reservations_online: false,
            reservations_phone: true,
            custom_branding: false,
            analytics: false,
            qr_pay: false
        }
    },
    STARTER: {
        label: 'Starter',
        menu_items: 60,
        max_tables: 10,
        expires_days: 365,
        modules: {
            menu_edit: true,
            multilanguage: true,
            seasonal_menu: false,
            orders_kitchen: true,
            reservations_online: false,
            reservations_phone: true,
            custom_branding: false,
            analytics: false,
            qr_pay: false
        }
    },
    PRO: {
        label: 'Pro',
        menu_items: 150,
        max_tables: 25,
        expires_days: 365,
        modules: {
            menu_edit: true,
            multilanguage: true,
            seasonal_menu: true,
            orders_kitchen: true,
            reservations_online: true,
            reservations_phone: true,
            custom_branding: true,
            analytics: false,
            qr_pay: true
        }
    },
    PRO_PLUS: {
        label: 'Pro+',
        menu_items: 300,
        max_tables: 50,
        expires_days: 365,
        modules: {
            menu_edit: true,
            multilanguage: true,
            seasonal_menu: true,
            orders_kitchen: true,
            reservations_online: true,
            reservations_phone: true,
            custom_branding: true,
            analytics: true,
            qr_pay: true
        }
    },
    ENTERPRISE: {
        label: 'Enterprise',
        menu_items: 999,
        max_tables: 999,
        expires_days: 365,
        modules: {
            menu_edit: true,
            multilanguage: true,
            seasonal_menu: true,
            orders_kitchen: true,
            reservations_online: true,
            reservations_phone: true,
            custom_branding: true,
            analytics: true,
            qr_pay: true
        }
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// SMTP
// ─────────────────────────────────────────────────────────────────────────────
let smtpTransporter = null;
function createSmtpTransporter(config) {
    if (!config.host || !config.user || !config.pass) return null;
    return nodemailer.createTransport({
        host: config.host,
        port: parseInt(config.port) || 587,
        secure: config.secure === 'true' || config.secure === true,
        auth: { user: config.user, pass: config.pass }
    });
}

const envSmtp = {
    host: process.env.SMTP_HOST || '',
    port: process.env.SMTP_PORT || '587',
    secure: process.env.SMTP_SECURE || 'false',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || ''
};
if (envSmtp.host && envSmtp.user && envSmtp.pass) {
    smtpTransporter = createSmtpTransporter(envSmtp);
    console.log('📧  SMTP: Konfiguriert über .env');
}

async function getActiveSmtp() {
    const [rows] = await db.query('SELECT * FROM smtp_config WHERE id = 1 LIMIT 1');
    const cfg = rows[0];
    if (cfg && cfg.host && cfg.smtp_user && cfg.smtp_pass) {
        const t = createSmtpTransporter({ host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.smtp_user, pass: cfg.smtp_pass });
        return { transporter: t, from: cfg.smtp_from || cfg.smtp_user };
    }
    if (smtpTransporter) return { transporter: smtpTransporter, from: envSmtp.from || envSmtp.user };
    return null;
}

async function sendMail(to, subject, html) {
    const smtp = await getActiveSmtp();
    if (!smtp) throw new Error('SMTP nicht konfiguriert');
    await smtp.transporter.sendMail({ from: smtp.from, to, subject, html });
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────────────────────────────────────
async function fireWebhook(event, payload) {
    const urls = [];
    if (process.env.WEBHOOK_URL) urls.push({ url: process.env.WEBHOOK_URL, secret: WEBHOOK_SECRET });
    try {
        const [rows] = await db.query('SELECT url, secret FROM webhooks WHERE active = 1');
        for (const r of rows) urls.push({ url: r.url, secret: r.secret });
    } catch {}

    const body = JSON.stringify({ event, ts: new Date().toISOString(), ...payload });
    for (const { url, secret } of urls) {
        try {
            const sig = secret ? crypto.createHmac('sha256', secret).update(body).digest('hex') : null;
            const headers = { 'Content-Type': 'application/json' };
            if (sig) headers['X-OPA-Signature'] = sig;
            await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
        } catch (e) {
            console.warn(`⚠️  Webhook ${url} fehlgeschlagen:`, e.message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express Setup
// ─────────────────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

const rawCorsOrigins = process.env.CORS_ORIGINS || '';
const allowedOrigins = rawCorsOrigins
    ? rawCorsOrigins.split(',').map(o => o.trim()).filter(Boolean)
    : null;

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (!allowedOrigins || allowedOrigins.length === 0) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`CORS: Origin ${origin} nicht erlaubt`), false);
    },
    credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiters
// ─────────────────────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    message: { success: false, message: 'Too many login attempts. Please wait 15 minutes.' }
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const validateLimiter = rateLimit({
    windowMs: 60 * 1000, max: 30,
    message: { status: 'rate_limited', message: 'Too many validation requests.' }
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
    const token = req.headers['authorization']?.startsWith('Bearer ')
        ? req.headers['authorization'].slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
    try { req.admin = jwt.verify(token, ADMIN_SECRET); next(); }
    catch { return res.status(401).json({ success: false, message: 'Invalid or expired token' }); }
};

const requireSuperAdmin = (req, res, next) => {
    if (req.admin.role !== 'superadmin')
        return res.status(403).json({ success: false, message: 'Superadmin required' });
    next();
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const generateKey = (type) => {
    const prefix = { FREE: 'OPA-FREE', STARTER: 'OPA-START', PRO: 'OPA-PRO', PRO_PLUS: 'OPA-PROPLUS', ENTERPRISE: 'OPA-ENT' }[type] || 'OPA-UNKNOWN';
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${rand}-${new Date().getFullYear()}`;
};

const domainMatches = (pattern, domain) => {
    if (!pattern || pattern === '*') return true;
    if (!domain) return true;
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/:\d+$/, '').split('/')[0];
    if (pattern === cleanDomain) return true;
    if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        return cleanDomain === suffix || cleanDomain.endsWith('.' + suffix);
    }
    return false;
};

const signResponse = (payload) => {
    const data = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('hex');
    return { ...payload, _sig: sig, _ts: Date.now() };
};

const addAuditLog = async (action, details, actor = 'system') => {
    try {
        await db.query(
            'INSERT INTO audit_log (id, actor, action, details) VALUES (?, ?, ?, ?)',
            [crypto.randomUUID(), actor, action, JSON.stringify(details)]
        );
    } catch (e) {
        console.error('Audit-Log Fehler:', e.message);
    }
};

const getClientIp = (req) =>
    req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

// ─────────────────────────────────────────────────────────────────────────────
// Ablauf-Cron: täglich prüfen, Mails senden
// ─────────────────────────────────────────────────────────────────────────────
async function runExpiryCron() {
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
                await sendMail(
                    lic.email,
                    `⏰ OPA! Santorini Lizenz läuft in ${daysLeft} Tagen ab`,
                    `<h2>🏛️ OPA! Santorini – Lizenzablauf</h2>
                    <p>Hallo ${lic.customer_name},</p>
                    <p>deine <strong>${lic.type}</strong>-Lizenz (<code>${lic.license_key}</code>) läuft am 
                    <strong>${new Date(lic.expires_at).toLocaleDateString('de-DE')}</strong> ab (in ${daysLeft} Tagen).</p>
                    <p>Bitte wende dich an deinen Administrator, um die Lizenz zu verlängern.</p>
                    <p style="color:#888;font-size:12px">OPA! Santorini License Server</p>`
                );
                await addAuditLog('expiry_notification_sent', { license_key: lic.license_key, days_left: daysLeft, email: lic.email });
            } catch (e) {
                console.warn(`📧 Ablauf-Mail fehlgeschlagen für ${lic.license_key}:`, e.message);
            }
        }

        // Abgelaufene Lizenzen automatisch auf 'expired' setzen
        const [result] = await db.query(`
            UPDATE licenses SET status = 'expired'
            WHERE status = 'active' AND expires_at < NOW()
        `);
        if (result.affectedRows > 0) {
            console.log(`🕐 ${result.affectedRows} Lizenz(en) auf 'expired' gesetzt.`);
            await addAuditLog('licenses_auto_expired', { count: result.affectedRows });
            await fireWebhook('licenses.auto_expired', { count: result.affectedRows });
        }

        // Nonces aufräumen
        await db.query('DELETE FROM used_nonces WHERE ts < ?', [Date.now() - 5 * 60 * 1000]);

    } catch (e) {
        console.error('Expiry-Cron Fehler:', e.message);
    }
}

// Cron alle 24h ausführen
setInterval(runExpiryCron, 24 * 60 * 60 * 1000);
runExpiryCron(); // Beim Start sofort einmal ausführen

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/v1/validate', validateLimiter, async (req, res) => {
    const { license_key, domain, device_id, device_type, nonce, features_used } = req.body;
    if (!license_key) return res.status(400).json({ status: 'invalid', message: 'No key provided' });
    const clientIp = getClientIp(req);

    try {
        const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
        const l = rows[0];

        if (!l) {
            await addAuditLog('validate_failed', { license_key, reason: 'not_found', ip: clientIp });
            return res.status(404).json({ status: 'invalid', message: 'Lizenz-Key nicht gefunden.' });
        }

        if (new Date(l.expires_at) < new Date()) {
            await addAuditLog('validate_failed', { license_key, reason: 'expired', ip: clientIp });
            return res.status(403).json({ status: 'expired', message: 'Lizenz ist abgelaufen.' });
        }

        if (l.status !== 'active') {
            await addAuditLog('validate_failed', { license_key, reason: `status_${l.status}`, ip: clientIp });
            return res.status(403).json({ status: l.status, message: 'Lizenz ist nicht aktiv.' });
        }

        if (!domainMatches(l.associated_domain, domain)) {
            await addAuditLog('validate_failed', { license_key, reason: 'domain_mismatch', domain, ip: clientIp });
            return res.status(403).json({ status: 'domain_mismatch', message: `Lizenz ist nicht für Domain "${domain}" gültig.` });
        }

        // Replay Protection
        if (nonce) {
            const [nonceRows] = await db.query('SELECT val FROM used_nonces WHERE val = ?', [nonce]);
            if (nonceRows.length > 0) {
                await addAuditLog('replay_attack', { license_key, nonce, ip: clientIp });
                return res.status(400).json({ status: 'replay', message: 'Nonce already used.' });
            }
            await db.query('INSERT INTO used_nonces (val, ts) VALUES (?, ?)', [nonce, Date.now()]);
        }

        // Device Management
        if (device_id) {
            const maxDevices = l.max_devices || 0;
            const [licDevices] = await db.query(
                'SELECT * FROM devices WHERE license_key = ? AND active = 1', [license_key]
            );
            const existing = licDevices.find(d => d.device_id === device_id);

            if (!existing) {
                if (maxDevices > 0 && licDevices.length >= maxDevices) {
                    await addAuditLog('validate_failed', { license_key, reason: 'device_limit', device_id, ip: clientIp });
                    return res.status(403).json({ status: 'device_limit', message: `Maximale Geräteanzahl (${maxDevices}) erreicht.` });
                }
                await db.query(
                    'INSERT INTO devices (id, license_key, device_id, device_type, ip) VALUES (?, ?, ?, ?, ?)',
                    [crypto.randomUUID(), license_key, device_id, device_type || 'unknown', clientIp]
                );
                await addAuditLog('device_registered', { license_key, device_id, device_type, ip: clientIp });
            } else {
                await db.query(
                    'UPDATE devices SET last_seen = NOW(), ip = ?, device_type = ? WHERE id = ?',
                    [clientIp, device_type || existing.device_type, existing.id]
                );
            }
        }

        // Analytics
        const today = new Date().toISOString().slice(0, 10);
        let dailyAnalytics = {};
        let featuresAnalytics = {};
        try {
            dailyAnalytics = typeof l.analytics_daily === 'string' ? JSON.parse(l.analytics_daily) : (l.analytics_daily || {});
            featuresAnalytics = typeof l.analytics_features === 'string' ? JSON.parse(l.analytics_features) : (l.analytics_features || {});
        } catch {}

        dailyAnalytics[today] = (dailyAnalytics[today] || 0) + 1;
        const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        for (const d of Object.keys(dailyAnalytics)) { if (d < cutoff) delete dailyAnalytics[d]; }

        if (features_used && Array.isArray(features_used)) {
            for (const f of features_used) featuresAnalytics[f] = (featuresAnalytics[f] || 0) + 1;
        }

        let validatedDomains = [];
        try { validatedDomains = typeof l.validated_domains === 'string' ? JSON.parse(l.validated_domains) : (l.validated_domains || []); } catch {}
        if (domain && !validatedDomains.includes(domain)) validatedDomains.push(domain);

        await db.query(`
            UPDATE licenses SET
                last_validated = NOW(),
                usage_count = usage_count + 1,
                validated_domain = ?,
                validated_domains = ?,
                analytics_daily = ?,
                analytics_features = ?
            WHERE license_key = ?`,
            [domain || null, JSON.stringify(validatedDomains), JSON.stringify(dailyAnalytics), JSON.stringify(featuresAnalytics), license_key]
        );

        await addAuditLog('validate_success', { license_key, domain, device_id: device_id || null, ip: clientIp });

        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const [custRows] = l.customer_id
            ? await db.query('SELECT email, company FROM customers WHERE id = ?', [l.customer_id])
            : [[]]; 
        const customer = custRows[0] || null;

        let allowedModules = plan.modules;
        let limits = { max_dishes: plan.menu_items, max_tables: plan.max_tables };
        try { if (l.allowed_modules) allowedModules = typeof l.allowed_modules === 'string' ? JSON.parse(l.allowed_modules) : l.allowed_modules; } catch {}
        try { if (l.limits) limits = typeof l.limits === 'string' ? JSON.parse(l.limits) : l.limits; } catch {}

        const responsePayload = {
            status: 'active',
            customer_name: l.customer_name,
            type: l.type,
            plan_label: plan.label,
            expires_at: l.expires_at,
            allowed_modules: allowedModules,
            limits,
            ...(customer ? { account_email: customer.email, company: customer.company } : {})
        };

        const tokenPayload = {
            license_key, type: l.type, plan_label: plan.label,
            expires_at: l.expires_at, allowed_modules: allowedModules, limits,
            domain: domain || l.associated_domain,
            issued_at: Math.floor(Date.now() / 1000)
        };

        const signedToken = createSignedLicenseToken(tokenPayload, '25h');
        const finalResponse = { ...responsePayload };
        if (signedToken) {
            finalResponse.license_token = signedToken;
            finalResponse.license_token_public_key = RSA_PUBLIC_KEY;
        }

        if (HMAC_SECRET !== 'hmac-change-me-in-production') return res.json(signResponse(finalResponse));
        return res.json(finalResponse);

    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

app.get('/api/v1/public-key', (req, res) => {
    res.json({ public_key: RSA_PUBLIC_KEY, algorithm: 'RS256' });
});

app.post('/api/v1/heartbeat', validateLimiter, async (req, res) => {
    const { license_key, domain } = req.body;
    if (!license_key) return res.status(400).json({ status: 'invalid', message: 'No key provided' });
    const clientIp = getClientIp(req);

    try {
        const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
        const l = rows[0];

        if (!l || l.status !== 'active' || new Date(l.expires_at) < new Date()) {
            await addAuditLog('heartbeat_failed', { license_key, reason: 'invalid_or_expired', ip: clientIp });
            return res.status(403).json({ status: 'invalid', message: 'Lizenz ungültig oder abgelaufen.' });
        }

        if (domain && !domainMatches(l.associated_domain, domain)) {
            await addAuditLog('heartbeat_failed', { license_key, reason: 'domain_mismatch', domain, ip: clientIp });
            return res.status(403).json({ status: 'domain_mismatch', message: 'Domain stimmt nicht überein.' });
        }

        await db.query('UPDATE licenses SET last_heartbeat = NOW() WHERE license_key = ?', [license_key]);
        await addAuditLog('heartbeat_ok', { license_key, domain, ip: clientIp });

        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        let allowedModules = plan.modules;
        let limits = { max_dishes: plan.menu_items, max_tables: plan.max_tables };
        try { if (l.allowed_modules) allowedModules = typeof l.allowed_modules === 'string' ? JSON.parse(l.allowed_modules) : l.allowed_modules; } catch {}
        try { if (l.limits) limits = typeof l.limits === 'string' ? JSON.parse(l.limits) : l.limits; } catch {}

        const tokenPayload = {
            license_key, type: l.type, plan_label: plan.label,
            expires_at: l.expires_at, allowed_modules: allowedModules, limits,
            domain: domain || l.associated_domain,
            issued_at: Math.floor(Date.now() / 1000)
        };

        const signedToken = createSignedLicenseToken(tokenPayload, '25h');
        return res.json({ status: 'ok', next_heartbeat_in_hours: 24, license_token: signedToken, expires_at: l.expires_at });

    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

app.post('/api/v1/verify-license-token', validateLimiter, (req, res) => {
    const { license_token } = req.body;
    if (!license_token) return res.status(400).json({ valid: false, message: 'No token provided' });
    try {
        const decoded = jwt.verify(license_token, RSA_PUBLIC_KEY, { algorithms: ['RS256'] });
        res.json({ valid: true, payload: decoded });
    } catch (e) {
        res.status(401).json({ valid: false, message: 'Ungültiges oder abgelaufenes Token: ' + e.message });
    }
});

app.post('/api/v1/offline-token', validateLimiter, async (req, res) => {
    const { license_key, domain, device_id, duration_hours } = req.body;
    if (!license_key) return res.status(400).json({ success: false, message: 'No key provided' });
    try {
        const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
        const l = rows[0];
        if (!l || l.status !== 'active' || new Date(l.expires_at) < new Date())
            return res.status(403).json({ success: false, message: 'License invalid or expired' });

        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const hours = Math.min(duration_hours || 24, 168);
        let allowedModules = plan.modules;
        let limits = { max_dishes: plan.menu_items, max_tables: plan.max_tables };
        try { if (l.allowed_modules) allowedModules = typeof l.allowed_modules === 'string' ? JSON.parse(l.allowed_modules) : l.allowed_modules; } catch {}
        try { if (l.limits) limits = typeof l.limits === 'string' ? JSON.parse(l.limits) : l.limits; } catch {}

        const token = jwt.sign({
            license_key, domain, device_id, type: l.type,
            plan_label: plan.label, allowed_modules: allowedModules, limits, offline: true
        }, HMAC_SECRET, { expiresIn: `${hours}h` });

        await addAuditLog('offline_token_issued', { license_key, domain, device_id: device_id || null, duration_hours: hours, ip: getClientIp(req) });
        res.json({ success: true, offline_token: token, valid_hours: hours });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.post('/api/v1/verify-offline-token', (req, res) => {
    const { offline_token } = req.body;
    if (!offline_token) return res.status(400).json({ success: false });
    try {
        const decoded = jwt.verify(offline_token, HMAC_SECRET);
        res.json({ success: true, ...decoded });
    } catch (e) {
        res.status(401).json({ success: false, message: 'Invalid or expired offline token' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN API
// ════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ success: false, message: 'Username and password required' });
    try {
        const [rows] = await db.query('SELECT * FROM admins WHERE username = ?', [username]);
        const admin = rows[0];
        if (!admin) {
            await addAuditLog('admin_login_failed', { username, ip: getClientIp(req) });
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        const valid = await bcrypt.compare(password, admin.password_hash);
        if (!valid) {
            await addAuditLog('admin_login_failed', { username, ip: getClientIp(req) });
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        const token = jwt.sign({ username: admin.username, role: admin.role }, ADMIN_SECRET, { expiresIn: '8h' });
        await addAuditLog('admin_login', { username, ip: getClientIp(req) }, username);
        res.json({ success: true, token, username: admin.username, role: admin.role });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.get('/api/admin/users', requireAuth, requireSuperAdmin, async (req, res) => {
    const [rows] = await db.query('SELECT id, username, role, created_at FROM admins');
    res.json({ users: rows });
});

app.post('/api/admin/users', requireAuth, requireSuperAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password)
        return res.status(400).json({ success: false, message: 'Username and password required' });
    if (password.length < 8)
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    const assignedRole = ['admin', 'superadmin'].includes(role) ? role : 'admin';
    try {
        const hash = await bcrypt.hash(password, 12);
        await db.query('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, assignedRole]);
        await addAuditLog('admin_user_created', { username, role: assignedRole, by: req.admin.username }, req.admin.username);
        res.json({ success: true, user: { username, role: assignedRole } });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Username already exists' });
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.delete('/api/admin/users/:username', requireAuth, requireSuperAdmin, async (req, res) => {
    if (req.params.username === req.admin.username)
        return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    try {
        const [result] = await db.query('DELETE FROM admins WHERE username = ?', [req.params.username]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'User not found' });
        await addAuditLog('admin_user_deleted', { username: req.params.username, by: req.admin.username }, req.admin.username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.patch('/api/admin/users/:username/password', requireAuth, async (req, res) => {
    const isSelf = req.params.username === req.admin.username;
    const isSuperAdmin = req.admin.role === 'superadmin';
    if (!isSelf && !isSuperAdmin) return res.status(403).json({ success: false, message: 'Forbidden' });
    const { password } = req.body;
    if (!password || password.length < 8)
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    try {
        const hash = await bcrypt.hash(password, 12);
        await db.query('UPDATE admins SET password_hash = ? WHERE username = ?', [hash, req.params.username]);
        await addAuditLog('admin_password_changed', { username: req.params.username, by: req.admin.username }, req.admin.username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.get('/api/admin/plans', requireAuth, (req, res) => res.json(PLAN_DEFINITIONS));

app.get('/api/admin/licenses', requireAuth, async (req, res) => {
    const now = new Date();
    const [licenses] = await db.query('SELECT * FROM licenses ORDER BY created_at DESC');
    const stats = {
        total: licenses.length,
        active: licenses.filter(l => l.status === 'active' && new Date(l.expires_at) > now).length,
        expiring: licenses.filter(l => { const d = (new Date(l.expires_at) - now) / 86400000; return d > 0 && d < 30; }).length,
        total_usage: licenses.reduce((s, l) => s + (l.usage_count || 0), 0)
    };
    res.json({ licenses, stats });
});

app.get('/api/admin/licenses/:key', requireAuth, async (req, res) => {
    const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, license: rows[0] });
});

app.post('/api/admin/licenses', requireAuth, async (req, res) => {
    const raw = req.body;
    const plan = PLAN_DEFINITIONS[raw.type] || PLAN_DEFINITIONS['FREE'];
    const key = raw.license_key?.trim() || generateKey(raw.type);
    const expiresAt = raw.expires_at || new Date(Date.now() + plan.expires_days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const modules = plan.modules;
    const limits = { max_dishes: plan.menu_items, max_tables: plan.max_tables };
    try {
        await db.query(`
            INSERT INTO licenses (license_key, type, customer_id, customer_name, status, associated_domain, expires_at, allowed_modules, limits, max_devices, analytics_daily, analytics_features, validated_domains)
            VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, '{}', '{}', '[]')
            ON DUPLICATE KEY UPDATE
                type = VALUES(type), customer_id = VALUES(customer_id), customer_name = VALUES(customer_name),
                associated_domain = VALUES(associated_domain), expires_at = VALUES(expires_at),
                allowed_modules = VALUES(allowed_modules), limits = VALUES(limits), max_devices = VALUES(max_devices)`,
            [key, raw.type || 'FREE', raw.customer_id || null, raw.customer_name || null,
             raw.associated_domain || '*', expiresAt, JSON.stringify(modules), JSON.stringify(limits),
             raw.max_devices ? parseInt(raw.max_devices) : 0]
        );
        await addAuditLog('license_created', { license_key: key, type: raw.type, customer_name: raw.customer_name, by: req.admin.username }, req.admin.username);
        const [newRows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [key]);
        res.json({ success: true, license: newRows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.patch('/api/admin/licenses/:key/status', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT status FROM licenses WHERE license_key = ?', [req.params.key]);
        if (!rows[0]) return res.status(404).json({ success: false });
        const oldStatus = rows[0].status;
        await db.query('UPDATE licenses SET status = ? WHERE license_key = ?', [req.body.status, req.params.key]);
        await addAuditLog('license_status_changed', { license_key: req.params.key, from: oldStatus, to: req.body.status, by: req.admin.username }, req.admin.username);
        await fireWebhook('license.status_changed', { license_key: req.params.key, from: oldStatus, to: req.body.status });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// NEU: Lizenz verlängern
app.post('/api/admin/licenses/:key/renew', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
        const l = rows[0];
        if (!l) return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden' });
        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const days = req.body.days || plan.expires_days;
        // Verlängerung ab jetzt oder ab aktuellem Ablaufdatum (je nachdem was später ist)
        const baseDate = new Date(l.expires_at) > new Date() ? new Date(l.expires_at) : new Date();
        const newExpiry = new Date(baseDate.getTime() + days * 86400000);
        const newExpiryStr = newExpiry.toISOString().slice(0, 19).replace('T', ' ');
        await db.query(
            "UPDATE licenses SET expires_at = ?, status = 'active' WHERE license_key = ?",
            [newExpiryStr, req.params.key]
        );
        await addAuditLog('license_renewed', { license_key: req.params.key, days, new_expiry: newExpiryStr, by: req.admin.username }, req.admin.username);
        await fireWebhook('license.renewed', { license_key: req.params.key, new_expiry: newExpiryStr });
        res.json({ success: true, new_expires_at: newExpiryStr, days_extended: days });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.delete('/api/admin/licenses/:key', requireAuth, async (req, res) => {
    try {
        await db.query('DELETE FROM licenses WHERE license_key = ?', [req.params.key]);
        await addAuditLog('license_deleted', { license_key: req.params.key, by: req.admin.username }, req.admin.username);
        await fireWebhook('license.deleted', { license_key: req.params.key });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.get('/api/admin/customers', requireAuth, async (req, res) => {
    const [rows] = await db.query('SELECT * FROM customers ORDER BY created_at DESC');
    res.json({ customers: rows });
});

app.post('/api/admin/customers', requireAuth, async (req, res) => {
    const { name, email, phone, contact_person, company, payment_status, notes } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name required' });
    if (!email) return res.status(400).json({ success: false, message: 'E-Mail ist ein Pflichtfeld' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'Ungültige E-Mail-Adresse' });
    try {
        const id = crypto.randomUUID();
        await db.query(
            'INSERT INTO customers (id, name, email, phone, contact_person, company, payment_status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id, name, email, phone || null, contact_person || null, company || null, payment_status || 'unknown', notes || '']
        );
        await addAuditLog('customer_created', { customer_id: id, name, email, by: req.admin.username }, req.admin.username);
        const [rows] = await db.query('SELECT * FROM customers WHERE id = ?', [id]);
        res.json({ success: true, customer: rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.patch('/api/admin/customers/:id', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ success: false, message: 'Customer not found' });
        const { name, email, phone, contact_person, company, payment_status, notes } = req.body;
        if (email !== undefined) {
            if (!email) return res.status(400).json({ success: false, message: 'E-Mail ist ein Pflichtfeld' });
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ success: false, message: 'Ungültige E-Mail-Adresse' });
        }
        await db.query(`
            UPDATE customers SET
                name = COALESCE(?, name), email = COALESCE(?, email),
                phone = ?, contact_person = ?, company = COALESCE(?, company),
                payment_status = COALESCE(?, payment_status), notes = COALESCE(?, notes)
            WHERE id = ?`,
            [name || null, email || null, phone !== undefined ? phone : rows[0].phone,
             contact_person !== undefined ? contact_person : rows[0].contact_person,
             company || null, payment_status || null, notes !== undefined ? notes : rows[0].notes, req.params.id]
        );
        await addAuditLog('customer_updated', { customer_id: req.params.id, by: req.admin.username }, req.admin.username);
        const [updated] = await db.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
        res.json({ success: true, customer: updated[0] });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.delete('/api/admin/customers/:id', requireAuth, async (req, res) => {
    try {
        await db.query('DELETE FROM customers WHERE id = ?', [req.params.id]);
        await addAuditLog('customer_deleted', { customer_id: req.params.id, by: req.admin.username }, req.admin.username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.patch('/api/admin/licenses/:key/customer', requireAuth, async (req, res) => {
    try {
        await db.query('UPDATE licenses SET customer_id = ? WHERE license_key = ?', [req.body.customer_id || null, req.params.key]);
        await addAuditLog('license_customer_linked', { license_key: req.params.key, customer_id: req.body.customer_id, by: req.admin.username }, req.admin.username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.get('/api/admin/smtp', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT host, port, secure, smtp_user, smtp_from FROM smtp_config WHERE id = 1');
        const cfg = rows[0] || {};
        res.json({ success: true, smtp: { host: cfg.host || '', port: cfg.port || '587', secure: cfg.secure || 'false', user: cfg.smtp_user || '', from: cfg.smtp_from || '', configured: !!(cfg.host && cfg.smtp_user) } });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.post('/api/admin/smtp', requireAuth, requireSuperAdmin, async (req, res) => {
    const { host, port, secure, user, pass, from } = req.body;
    if (!host || !user || !pass)
        return res.status(400).json({ success: false, message: 'Host, Benutzer und Passwort sind Pflichtfelder' });
    try {
        const transporter = createSmtpTransporter({ host, port: port || '587', secure: secure || 'false', user, pass });
        await transporter.verify();
        await db.query(`
            INSERT INTO smtp_config (id, host, port, secure, smtp_user, smtp_pass, smtp_from) VALUES (1, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE host=VALUES(host), port=VALUES(port), secure=VALUES(secure), smtp_user=VALUES(smtp_user), smtp_pass=VALUES(smtp_pass), smtp_from=VALUES(smtp_from)`,
            [host, port || '587', secure || 'false', user, pass, from || user]
        );
        await addAuditLog('smtp_config_updated', { host, user, by: req.admin.username }, req.admin.username);
        res.json({ success: true, message: 'SMTP-Konfiguration gespeichert und Verbindung erfolgreich getestet.' });
    } catch (e) {
        res.status(400).json({ success: false, message: `SMTP-Verbindungsfehler: ${e.message}` });
    }
});

app.post('/api/admin/smtp/test', requireAuth, requireSuperAdmin, async (req, res) => {
    const { to } = req.body;
    if (!to) return res.status(400).json({ success: false, message: 'Empfänger-E-Mail fehlt' });
    try {
        await sendMail(to, 'OPA! Santorini License Server — SMTP Test',
            '<h2>✅ SMTP Test erfolgreich</h2><p>Die SMTP-Konfiguration deines OPA! Santorini License Servers funktioniert korrekt.</p>');
        res.json({ success: true, message: `Test-E-Mail an ${to} gesendet.` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.delete('/api/admin/smtp', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM smtp_config WHERE id = 1');
        await addAuditLog('smtp_config_deleted', { by: req.admin.username }, req.admin.username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.get('/api/admin/devices', requireAuth, async (req, res) => {
    const { license_key } = req.query;
    let query = 'SELECT * FROM devices';
    const params = [];
    if (license_key) { query += ' WHERE license_key = ?'; params.push(license_key); }
    const [devices] = await db.query(query, params);
    res.json({ devices });
});

app.patch('/api/admin/devices/:id/deactivate', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ success: false });
        await db.query('UPDATE devices SET active = 0, deactivated_at = NOW() WHERE id = ?', [req.params.id]);
        await addAuditLog('device_deactivated', { device_id: rows[0].device_id, license_key: rows[0].license_key, by: req.admin.username }, req.admin.username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.delete('/api/admin/devices/:id', requireAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ success: false });
        await db.query('DELETE FROM devices WHERE id = ?', [req.params.id]);
        await addAuditLog('device_removed', { device_id: rows[0].device_id, license_key: rows[0].license_key, by: req.admin.username }, req.admin.username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.get('/api/admin/analytics', requireAuth, async (req, res) => {
    const now = new Date();
    const [licenses] = await db.query('SELECT license_key, customer_name, type, usage_count, last_validated, analytics_daily, analytics_features FROM licenses ORDER BY usage_count DESC LIMIT 10');
    const topLicenses = licenses.map(l => ({ license_key: l.license_key, customer_name: l.customer_name, type: l.type, usage_count: l.usage_count || 0, last_validated: l.last_validated }));

    const [allLicenses] = await db.query('SELECT analytics_daily, analytics_features FROM licenses');
    const daily = {};
    const features = {};
    for (const l of allLicenses) {
        try {
            const d = typeof l.analytics_daily === 'string' ? JSON.parse(l.analytics_daily) : (l.analytics_daily || {});
            for (const [day, count] of Object.entries(d)) daily[day] = (daily[day] || 0) + count;
        } catch {}
        try {
            const f = typeof l.analytics_features === 'string' ? JSON.parse(l.analytics_features) : (l.analytics_features || {});
            for (const [feat, count] of Object.entries(f)) features[feat] = (features[feat] || 0) + count;
        } catch {}
    }

    const [[{ total_devices }]] = await db.query('SELECT COUNT(*) as total_devices FROM devices');
    const [[{ active_devices }]] = await db.query('SELECT COUNT(*) as active_devices FROM devices WHERE active = 1');

    res.json({ top_licenses: topLicenses, daily_requests: daily, feature_usage: features, total_devices, active_devices });
});

app.get('/api/admin/audit-log', requireAuth, async (req, res) => {
    const { limit = 100, action, license_key } = req.query;
    let query = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];
    if (action) { query += ' AND action = ?'; params.push(action); }
    if (license_key) { query += ' AND JSON_EXTRACT(details, "$.license_key") = ?'; params.push(license_key); }
    query += ' ORDER BY ts DESC LIMIT ?';
    params.push(parseInt(limit));
    const [logs] = await db.query(query, params);
    res.json({ logs });
});

// Webhooks verwalten
app.get('/api/admin/webhooks', requireAuth, requireSuperAdmin, async (req, res) => {
    const [rows] = await db.query('SELECT id, url, events, active, created_at FROM webhooks');
    res.json({ webhooks: rows });
});

app.post('/api/admin/webhooks', requireAuth, requireSuperAdmin, async (req, res) => {
    const { url, secret, events } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'URL erforderlich' });
    try {
        const [result] = await db.query(
            'INSERT INTO webhooks (url, secret, events) VALUES (?, ?, ?)',
            [url, secret || null, JSON.stringify(events || ['*'])]
        );
        await addAuditLog('webhook_created', { url, by: req.admin.username }, req.admin.username);
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.delete('/api/admin/webhooks/:id', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM webhooks WHERE id = ?', [req.params.id]);
        await addAuditLog('webhook_deleted', { webhook_id: req.params.id, by: req.admin.username }, req.admin.username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.post('/api/admin/impersonate', requireAuth, requireSuperAdmin, async (req, res) => {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ success: false });
    try {
        const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
        const l = rows[0];
        if (!l) return res.status(404).json({ success: false });
        const [custRows] = l.customer_id
            ? await db.query('SELECT * FROM customers WHERE id = ?', [l.customer_id])
            : [[]];
        const [devices] = await db.query('SELECT * FROM devices WHERE license_key = ?', [license_key]);
        await addAuditLog('impersonate', { license_key, by: req.admin.username }, req.admin.username);
        res.json({ success: true, license: l, customer: custRows[0] || null, devices });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.listen(PORT, () => {
    console.log(`\n🏛️  OPA! Santorini License Server v2.0 läuft auf http://localhost:${PORT}`);
    console.log(`📋  Pläne: ${Object.keys(PLAN_DEFINITIONS).join(' | ')}`);
    console.log(`🌐  CORS: ${allowedOrigins ? allowedOrigins.join(', ') : 'alle Origins erlaubt'}`);
    console.log(`🔐  HMAC Signing: ${HMAC_SECRET !== 'hmac-change-me-in-production' ? 'AKTIV' : 'INAKTIV'}`);
    console.log(`🔑  RSA JWT Signing: ${RSA_PRIVATE_KEY ? 'AKTIV (RS256)' : 'INAKTIV – RSA_PRIVATE_KEY nicht gesetzt!'}`);
    console.log(`📧  SMTP: ${(envSmtp.host && envSmtp.user) ? `${envSmtp.host}:${envSmtp.port}` : 'nicht konfiguriert'}\n`);
});
