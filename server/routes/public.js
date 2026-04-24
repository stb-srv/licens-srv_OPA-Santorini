import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../db.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import { RSA_PUBLIC_KEY, createSignedLicenseToken, signResponse, isHmacActive, HMAC_SECRET } from '../crypto.js';
import { domainMatches, getClientIp, addAuditLog, parseJsonField } from '../helpers.js';
import { validateLimiter, setupLimiter, trialLimiter, offlineTokenLimiter, MIN_PASSWORD_LENGTH, asyncHandler } from '../middleware.js';

const router = Router();
const SETUP_TOKEN = process.env.SETUP_TOKEN || '';

// ── Setup ─────────────────────────────────────────────────────────────────────
router.post('/setup', setupLimiter, asyncHandler(async (req, res) => {
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
    if (password.length < MIN_PASSWORD_LENGTH)
        return res.status(400).json({ success: false, message: `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.` });

    try {
        const [existing] = await db.query('SELECT COUNT(*) as count FROM admins');
        if (existing[0].count > 0)
            return res.status(409).json({ success: false, message: 'Setup bereits abgeschlossen. Admin-Account existiert bereits.' });

        const { default: bcrypt } = await import('bcryptjs');
        const hash = await bcrypt.hash(password, 12);
        await db.query('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, 'superadmin']);
        await addAuditLog('setup_completed', { username, ip: getClientIp(req) });
        console.log(`✅  Setup abgeschlossen: Superadmin '${username}' erstellt.`);
        res.json({ success: true, message: `Superadmin '${username}' erfolgreich erstellt. SETUP_TOKEN kann jetzt aus .env entfernt werden.` });
    } catch (e) {
        console.error('Setup-Fehler:', e.message);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
}));

// ── Trial Self-Registration ────────────────────────────────────────────────────
router.post('/trial/register', trialLimiter, asyncHandler(async (req, res) => {
    const { domain, contact_email, restaurant_name, instance_id } = req.body;
    if (!domain) return res.status(400).json({ success: false, message: 'Domain ist Pflichtfeld.' });

    const clientIp = getClientIp(req);

    // Prüfen ob für diese Domain bereits ein Trial existiert (license_key ist PK, kein id)
    const [existing] = await db.query(
        "SELECT license_key FROM licenses WHERE associated_domain = ? AND type = 'TRIAL'",
        [domain]
    );
    if (existing.length > 0) {
        return res.status(409).json({
            success: false,
            message: 'Für diese Domain ist bereits ein Trial aktiv.',
            hint: 'Bitte nutzen Sie Ihren bestehenden Trial-Key oder kontaktieren Sie den Support.'
        });
    }

    // Trial-Key generieren: OPA-TRIAL-XXXXXXXX-XXXXXXXX
    const key = `OPA-TRIAL-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 Tage

    const notes = JSON.stringify({
        contact_email: contact_email || null,
        instance_id:   instance_id   || null,
        registered_ip: clientIp,
        registered_at: new Date().toISOString(),
        source:        'self-registration'
    });

    // Fix #2: license_key ist der PRIMARY KEY – kein id-Feld in der licenses-Tabelle
    await db.query(
        `INSERT INTO licenses
            (license_key, type, status, customer_name, associated_domain, expires_at, notes, max_devices)
         VALUES (?, 'TRIAL', 'active', ?, ?, ?, ?, 1)`,
        [key, restaurant_name || domain, domain, expiresAt, notes]
    );

    await addAuditLog('trial_registered', {
        license_key:     key,
        domain,
        contact_email:   contact_email || null,
        restaurant_name: restaurant_name || null,
        instance_id:     instance_id || null,
        ip:              clientIp
    });

    console.log(`🎉 Neuer Trial registriert: ${restaurant_name || domain} (${domain}) – Key: ${key}`);

    const plan = PLAN_DEFINITIONS['TRIAL'];

    return res.status(201).json({
        success:     true,
        license_key: key,
        plan:        'TRIAL',
        plan_label:  plan.label,
        expires_at:  expiresAt,
        modules:     plan.modules,
        limits: {
            max_dishes: plan.menu_items,
            max_tables: plan.max_tables
        },
        message: `Ihr 30-Tage Trial wurde aktiviert. Key: ${key}`
    });
}));

// ── Validate ───────────────────────────────────────────────────────────────────
router.post('/validate', validateLimiter, asyncHandler(async (req, res) => {
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
                    return res.status(403).json({ status: 'device_limit', message: `Maximale Geräteanzahl (${maxDevices}) erreicht.` });
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
        }, '73h');

        const finalResponse = { ...responsePayload };
        if (signedToken) {
            finalResponse.license_token = signedToken;
            finalResponse.token = signedToken;
        }

        return res.json(isHmacActive() ? signResponse(finalResponse) : finalResponse);
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
}));

// ── Public Key ───────────────────────────────────────────────────────────────────
router.get('/public-key', (req, res) => {
    res.json({ public_key: RSA_PUBLIC_KEY, algorithm: 'RS256' });
});

// ── Heartbeat ────────────────────────────────────────────────────────────────────
router.post('/heartbeat', validateLimiter, asyncHandler(async (req, res) => {
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
        const allowedModules = l.allowed_modules ? parseJsonField(l.allowed_modules, plan.modules) : plan.modules;
        const limits = l.limits
            ? parseJsonField(l.limits, { max_dishes: plan.menu_items, max_tables: plan.max_tables })
            : { max_dishes: plan.menu_items, max_tables: plan.max_tables };

        const signedToken = createSignedLicenseToken({
            license_key, type: l.type, plan_label: plan.label, expires_at: l.expires_at,
            allowed_modules: allowedModules, limits, domain: domain || l.associated_domain,
            issued_at: Math.floor(Date.now() / 1000)
        }, '73h');

        res.json({ status: 'ok', next_heartbeat_in_hours: 72, license_token: signedToken, token: signedToken, expires_at: l.expires_at });
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
}));

// ── Refresh ──────────────────────────────────────────────────────────────────────
router.post('/refresh', validateLimiter, asyncHandler(async (req, res) => {
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
        // Fix #5: 'cancelled' ist jetzt im ENUM – Prüfung bleibt korrekt
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
            return res.status(403).json({ status: 'domain_mismatch', message: 'Domain stimmt nicht überein.' });
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
        }, '73h');

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
}));

// ── Verify License Token ──────────────────────────────────────────────────────────
router.post('/verify-license-token', validateLimiter, asyncHandler(async (req, res) => {
    const { license_token } = req.body;
    if (!license_token) return res.status(400).json({ valid: false, message: 'No token provided' });
    try {
        const decoded = jwt.verify(license_token, RSA_PUBLIC_KEY, { algorithms: ['RS256'] });
        res.json({ valid: true, payload: decoded });
    } catch (e) {
        res.status(401).json({ valid: false, message: 'Ungültiges oder abgelaufenes Token: ' + e.message });
    }
}));

// ── Offline Token ──────────────────────────────────────────────────────────────────
router.post('/offline-token', offlineTokenLimiter, asyncHandler(async (req, res) => {
    const { license_key, domain, device_id, duration_hours } = req.body;
    if (!license_key) return res.status(400).json({ success: false, message: 'No key provided' });
    try {
        const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
        const l = rows[0];
        if (!l || l.status !== 'active' || new Date(l.expires_at) < new Date())
            return res.status(403).json({ success: false, message: 'License invalid or expired' });

        if (domain && !domainMatches(l.associated_domain, domain))
            return res.status(403).json({ success: false, message: `Offline-Token: Lizenz ist nicht für Domain "${domain}" gültig.` });

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
}));

router.post('/verify-offline-token', asyncHandler(async (req, res) => {
    const { offline_token } = req.body;
    if (!offline_token) return res.status(400).json({ success: false });
    try {
        const decoded = jwt.verify(offline_token, HMAC_SECRET);
        res.json({ success: true, ...decoded });
    } catch (e) {
        res.status(401).json({ success: false, message: 'Invalid or expired offline token' });
    }
}));

// ── Health Check ──────────────────────────────────────────────────────────────
router.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
    } catch (e) {
        res.status(503).json({ status: 'degraded', database: 'disconnected', error: e.message });
    }
});

export default router;
