import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../db.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import { RSA_PUBLIC_KEY, createSignedLicenseToken, signResponse, isHmacActive, HMAC_SECRET } from '../crypto.js';
import { domainMatches, getClientIp, addAuditLog, parseJsonField } from '../helpers.js';
import { validateLimiter, setupLimiter } from '../middleware.js';

const router = Router();
const SETUP_TOKEN = process.env.SETUP_TOKEN || '';

// ── Setup ────────────────────────────────────────────────────────────────────
router.post('/setup', setupLimiter, async (req, res) => {
    if (!SETUP_TOKEN)
        return res.status(503).json({ success: false, message: 'Setup ist deaktiviert. SETUP_TOKEN nicht in .env konfiguriert.' });

    const providedToken = req.headers['x-setup-token'] || req.body?.setup_token;
    if (!providedToken || providedToken !== SETUP_TOKEN) {
        await addAuditLog('setup_attempt_failed', { reason: 'invalid_token', ip: getClientIp(req) });
        return res.status(401).json({ success: false, message: 'Ungültiger Setup-Token.' });
    }

    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ success: false, message: 'Username und Passwort sind Pflichtfelder.' });
    if (password.length < 12)
        return res.status(400).json({ success: false, message: 'Passwort muss mindestens 12 Zeichen haben.' });

    try {
        const [existing] = await db.query('SELECT COUNT(*) as count FROM admins');
        if (existing[0].count > 0)
            return res.status(409).json({ success: false, message: 'Setup bereits abgeschlossen. Admin-Account existiert bereits.' });

        const { default: bcrypt } = await import('bcryptjs');
        const hash = await bcrypt.hash(password, 12);
        await db.query('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, 'superadmin']);
        await addAuditLog('setup_completed', { username, ip: getClientIp(req) });
        console.log(`\u2705  Setup abgeschlossen: Superadmin '${username}' erstellt.`);
        res.json({ success: true, message: `Superadmin '${username}' erfolgreich erstellt. SETUP_TOKEN kann jetzt aus .env entfernt werden.` });
    } catch (e) {
        console.error('Setup-Fehler:', e.message);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// ── Validate ─────────────────────────────────────────────────────────────────
router.post('/validate', validateLimiter, async (req, res) => {
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
            return res.status(403).json({ status: 'domain_mismatch', message: `Lizenz ist nicht f\u00fcr Domain "${domain}" g\u00fcltig.` });
        }

        if (nonce) {
            const [nonceRows] = await db.query('SELECT val FROM used_nonces WHERE val = ?', [nonce]);
            if (nonceRows.length > 0) {
                await addAuditLog('replay_attack', { license_key, nonce, ip: clientIp });
                return res.status(400).json({ status: 'replay', message: 'Nonce already used.' });
            }
            await db.query('INSERT INTO used_nonces (val, ts) VALUES (?, ?)', [nonce, Date.now()]);
        }

        if (device_id) {
            const maxDevices = l.max_devices || 0;
            const [licDevices] = await db.query('SELECT * FROM devices WHERE license_key = ? AND active = 1', [license_key]);
            const existing = licDevices.find(d => d.device_id === device_id);
            if (!existing) {
                if (maxDevices > 0 && licDevices.length >= maxDevices) {
                    await addAuditLog('validate_failed', { license_key, reason: 'device_limit', device_id, ip: clientIp });
                    return res.status(403).json({ status: 'device_limit', message: `Maximale Ger\u00e4teanzahl (${maxDevices}) erreicht.` });
                }
                await db.query(
                    'INSERT INTO devices (id, license_key, device_id, device_type, ip) VALUES (?, ?, ?, ?, ?)',
                    [crypto.randomUUID(), license_key, device_id, device_type || 'unknown', clientIp]
                );
                await addAuditLog('device_registered', { license_key, device_id, device_type, ip: clientIp });
            } else {
                await db.query('UPDATE devices SET last_seen = NOW(), ip = ?, device_type = ? WHERE id = ?',
                    [clientIp, device_type || existing.device_type, existing.id]);
            }
        }

        const today = new Date().toISOString().slice(0, 10);
        const dailyAnalytics = parseJsonField(l.analytics_daily, {});
        const featuresAnalytics = parseJsonField(l.analytics_features, {});
        dailyAnalytics[today] = (dailyAnalytics[today] || 0) + 1;
        const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        for (const d of Object.keys(dailyAnalytics)) { if (d < cutoff) delete dailyAnalytics[d]; }
        if (features_used && Array.isArray(features_used)) {
            for (const f of features_used) featuresAnalytics[f] = (featuresAnalytics[f] || 0) + 1;
        }

        const validatedDomains = parseJsonField(l.validated_domains, []);
        if (domain && !validatedDomains.includes(domain)) validatedDomains.push(domain);

        await db.query(`UPDATE licenses SET last_validated = NOW(), usage_count = usage_count + 1,
            validated_domain = ?, validated_domains = ?, analytics_daily = ?, analytics_features = ?
            WHERE license_key = ?`,
            [domain || null, JSON.stringify(validatedDomains), JSON.stringify(dailyAnalytics), JSON.stringify(featuresAnalytics), license_key]
        );

        await addAuditLog('validate_success', { license_key, domain, device_id: device_id || null, ip: clientIp });

        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const [custRows] = l.customer_id
            ? await db.query('SELECT email, company FROM customers WHERE id = ?', [l.customer_id])
            : [[]];
        const customer = custRows[0] || null;

        const allowedModules = l.allowed_modules ? parseJsonField(l.allowed_modules, plan.modules) : plan.modules;
        const limits = l.limits
            ? parseJsonField(l.limits, { max_dishes: plan.menu_items, max_tables: plan.max_tables })
            : { max_dishes: plan.menu_items, max_tables: plan.max_tables };

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

        const signedToken = createSignedLicenseToken({
            license_key, type: l.type, plan_label: plan.label, expires_at: l.expires_at,
            allowed_modules: allowedModules, limits, domain: domain || l.associated_domain,
            issued_at: Math.floor(Date.now() / 1000)
        }, '25h');

        const finalResponse = { ...responsePayload };
        if (signedToken) {
            finalResponse.license_token = signedToken;
            finalResponse.token = signedToken;
            finalResponse.license_token_public_key = RSA_PUBLIC_KEY;
        }

        return res.json(isHmacActive() ? signResponse(finalResponse) : finalResponse);
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

// ── Public Key ───────────────────────────────────────────────────────────────
router.get('/public-key', (req, res) => {
    res.json({ public_key: RSA_PUBLIC_KEY, algorithm: 'RS256' });
});

// ── Heartbeat ────────────────────────────────────────────────────────────────
router.post('/heartbeat', validateLimiter, async (req, res) => {
    const { license_key, domain } = req.body;
    if (!license_key) return res.status(400).json({ status: 'invalid', message: 'No key provided' });
    const clientIp = getClientIp(req);

    try {
        const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
        const l = rows[0];
        if (!l || l.status !== 'active' || new Date(l.expires_at) < new Date()) {
            await addAuditLog('heartbeat_failed', { license_key, reason: 'invalid_or_expired', ip: clientIp });
            return res.status(403).json({ status: 'invalid', message: 'Lizenz ung\u00fcltig oder abgelaufen.' });
        }
        if (domain && !domainMatches(l.associated_domain, domain)) {
            await addAuditLog('heartbeat_failed', { license_key, reason: 'domain_mismatch', domain, ip: clientIp });
            return res.status(403).json({ status: 'domain_mismatch', message: 'Domain stimmt nicht \u00fcberein.' });
        }

        await db.query('UPDATE licenses SET last_heartbeat = NOW() WHERE license_key = ?', [license_key]);
        await addAuditLog('heartbeat_ok', { license_key, domain, ip: clientIp });

        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const allowedModules = l.allowed_modules ? parseJsonField(l.allowed_modules, plan.modules) : plan.modules;
        const limits = l.limits
            ? parseJsonField(l.limits, { max_dishes: plan.menu_items, max_tables: plan.max_tables })
            : { max_dishes: plan.menu_items, max_tables: plan.max_tables };

        const signedToken = createSignedLicenseToken({
            license_key, type: l.type, plan_label: plan.label, expires_at: l.expires_at,
            allowed_modules: allowedModules, limits, domain: domain || l.associated_domain,
            issued_at: Math.floor(Date.now() / 1000)
        }, '25h');

        res.json({ status: 'ok', next_heartbeat_in_hours: 24, license_token: signedToken, token: signedToken, expires_at: l.expires_at });
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

// ── Refresh (genutzt von OPA-CMS LicenseChecker alle 24h) ───────────────────
// Identisch zu /heartbeat, aber Response-Format passt zum CMS LicenseChecker:
// { status: 'active'|'revoked', token: '<RS256 JWT>' }
router.post('/refresh', validateLimiter, async (req, res) => {
    const { license_key, domain } = req.body;
    if (!license_key) return res.status(400).json({ status: 'invalid', message: 'No key provided' });
    const clientIp = getClientIp(req);

    try {
        const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
        const l = rows[0];

        if (!l) {
            await addAuditLog('refresh_failed', { license_key, reason: 'not_found', ip: clientIp });
            return res.status(404).json({ status: 'invalid', message: 'Lizenz-Key nicht gefunden.' });
        }
        if (l.status === 'revoked' || l.status === 'cancelled') {
            await addAuditLog('refresh_failed', { license_key, reason: l.status, ip: clientIp });
            return res.status(403).json({ status: l.status, message: `Lizenz wurde widerrufen (${l.status}).` });
        }
        if (l.status !== 'active' || new Date(l.expires_at) < new Date()) {
            await addAuditLog('refresh_failed', { license_key, reason: 'expired_or_inactive', ip: clientIp });
            return res.status(403).json({ status: 'expired', message: 'Lizenz ist abgelaufen oder inaktiv.' });
        }
        if (domain && !domainMatches(l.associated_domain, domain)) {
            await addAuditLog('refresh_failed', { license_key, reason: 'domain_mismatch', domain, ip: clientIp });
            return res.status(403).json({ status: 'domain_mismatch', message: 'Domain stimmt nicht \u00fcberein.' });
        }

        await db.query('UPDATE licenses SET last_heartbeat = NOW() WHERE license_key = ?', [license_key]);
        await addAuditLog('refresh_ok', { license_key, domain, ip: clientIp });

        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const allowedModules = l.allowed_modules ? parseJsonField(l.allowed_modules, plan.modules) : plan.modules;
        const limits = l.limits
            ? parseJsonField(l.limits, { max_dishes: plan.menu_items, max_tables: plan.max_tables })
            : { max_dishes: plan.menu_items, max_tables: plan.max_tables };

        const signedToken = createSignedLicenseToken({
            license_key, type: l.type, plan_label: plan.label, expires_at: l.expires_at,
            allowed_modules: allowedModules, limits, domain: domain || l.associated_domain,
            issued_at: Math.floor(Date.now() / 1000)
        }, '25h');

        // Response-Format: { status, token } – exakt was OPA-CMS LicenseChecker erwartet
        res.json({
            status: 'active',
            token: signedToken,
            type: l.type,
            plan_label: plan.label,
            expires_at: l.expires_at,
            allowed_modules: allowedModules,
            limits
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

// ── Verify License Token ─────────────────────────────────────────────────────
router.post('/verify-license-token', validateLimiter, (req, res) => {
    const { license_token } = req.body;
    if (!license_token) return res.status(400).json({ valid: false, message: 'No token provided' });
    try {
        const decoded = jwt.verify(license_token, RSA_PUBLIC_KEY, { algorithms: ['RS256'] });
        res.json({ valid: true, payload: decoded });
    } catch (e) {
        res.status(401).json({ valid: false, message: 'Ung\u00fcltiges oder abgelaufenes Token: ' + e.message });
    }
});

// ── Offline Token ────────────────────────────────────────────────────────────
router.post('/offline-token', validateLimiter, async (req, res) => {
    const { license_key, domain, device_id, duration_hours } = req.body;
    if (!license_key) return res.status(400).json({ success: false, message: 'No key provided' });
    try {
        const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
        const l = rows[0];
        if (!l || l.status !== 'active' || new Date(l.expires_at) < new Date())
            return res.status(403).json({ success: false, message: 'License invalid or expired' });

        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const hours = Math.min(duration_hours || 24, 168);
        const allowedModules = l.allowed_modules ? parseJsonField(l.allowed_modules, plan.modules) : plan.modules;
        const limits = l.limits
            ? parseJsonField(l.limits, { max_dishes: plan.menu_items, max_tables: plan.max_tables })
            : { max_dishes: plan.menu_items, max_tables: plan.max_tables };

        const token = jwt.sign(
            { license_key, domain, device_id, type: l.type, plan_label: plan.label, allowed_modules: allowedModules, limits, offline: true },
            HMAC_SECRET,
            { expiresIn: `${hours}h` }
        );

        await addAuditLog('offline_token_issued', { license_key, domain, device_id: device_id || null, duration_hours: hours, ip: getClientIp(req) });
        res.json({ success: true, offline_token: token, valid_hours: hours });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

router.post('/verify-offline-token', (req, res) => {
    const { offline_token } = req.body;
    if (!offline_token) return res.status(400).json({ success: false });
    try {
        const decoded = jwt.verify(offline_token, HMAC_SECRET);
        res.json({ success: true, ...decoded });
    } catch (e) {
        res.status(401).json({ success: false, message: 'Invalid or expired offline token' });
    }
});

export default router;
