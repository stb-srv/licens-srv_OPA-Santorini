import express from 'express';
import cors from 'cors';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.json');

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';
const HMAC_SECRET = process.env.HMAC_SECRET || 'hmac-change-me-in-production';

if (ADMIN_SECRET === 'change-me-in-production') {
    console.warn('⚠️  WARNING: ADMIN_SECRET is not set in .env! Using insecure default.');
}
if (HMAC_SECRET === 'hmac-change-me-in-production') {
    console.warn('⚠️  WARNING: HMAC_SECRET is not set in .env! Using insecure default.');
}

app.set('trust proxy', 1);

const rawCorsOrigins = process.env.CORS_ORIGINS || '';
const allowedOrigins = rawCorsOrigins
    ? rawCorsOrigins.split(',').map(o => o.trim()).filter(Boolean)
    : null;

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (!allowedOrigins) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        callback(null, true);
    },
    credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Rate Limiters ---
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    message: { success: false, message: 'Too many login attempts. Please wait 15 minutes.' }
});
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const validateLimiter = rateLimit({ windowMs: 60 * 1000, max: 30,
    message: { status: 'rate_limited', message: 'Too many validation requests.' }
});

// --- Auth Middleware ---
const requireAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
    try { req.admin = jwt.verify(token, ADMIN_SECRET); next(); }
    catch (e) { return res.status(401).json({ success: false, message: 'Invalid or expired token' }); }
};

const requireSuperAdmin = (req, res, next) => {
    if (req.admin.role !== 'superadmin')
        return res.status(403).json({ success: false, message: 'Superadmin required' });
    next();
};

// --- Plan Definitions ---
export const PLAN_DEFINITIONS = {
    FREE: {
        label: 'Free', menu_items: 10, max_tables: 5, expires_days: 36500,
        modules: { menu_edit: true, orders_kitchen: false, reservations: false, custom_design: false, analytics: false, qr_pay: false }
    },
    STARTER: {
        label: 'Starter', menu_items: 40, max_tables: 10, expires_days: 365,
        modules: { menu_edit: true, orders_kitchen: true, reservations: true, custom_design: false, analytics: false, qr_pay: false }
    },
    PRO: {
        label: 'Pro', menu_items: 100, max_tables: 25, expires_days: 365,
        modules: { menu_edit: true, orders_kitchen: true, reservations: true, custom_design: true, analytics: false, qr_pay: false }
    },
    PRO_PLUS: {
        label: 'Pro+', menu_items: 200, max_tables: 50, expires_days: 365,
        modules: { menu_edit: true, orders_kitchen: true, reservations: true, custom_design: true, analytics: true, qr_pay: false }
    },
    ENTERPRISE: {
        label: 'Enterprise', menu_items: 500, max_tables: 999, expires_days: 365,
        modules: { menu_edit: true, orders_kitchen: true, reservations: true, custom_design: true, analytics: true, qr_pay: true }
    }
};

// --- DB Utility ---
const getDB = async () => {
    const data = JSON.parse(await readFile(DB_PATH, 'utf-8'));
    if (!data.customers) data.customers = [];
    if (!data.devices) data.devices = [];
    if (!data.audit_log) data.audit_log = [];
    if (!data.used_nonces) data.used_nonces = [];
    return data;
};
const saveDB = async (data) => await writeFile(DB_PATH, JSON.stringify(data, null, 2));

// --- Key Generator ---
const generateKey = (type) => {
    const prefix = { FREE:'OPA-FREE', STARTER:'OPA-START', PRO:'OPA-PRO', PRO_PLUS:'OPA-PROPLUS', ENTERPRISE:'OPA-ENT' }[type] || 'OPA-UNKNOWN';
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${rand}-${new Date().getFullYear()}`;
};

// --- Domain Matching Helper ---
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

// --- HMAC Signing Helper ---
const signResponse = (payload) => {
    const data = JSON.stringify(payload);
    const sig = crypto.createHmac('sha256', HMAC_SECRET).update(data).digest('hex');
    return { ...payload, _sig: sig, _ts: Date.now() };
};

// --- Audit Log Helper ---
const addAuditLog = async (db, action, details, actor = 'system') => {
    if (!db.audit_log) db.audit_log = [];
    db.audit_log.unshift({
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        actor,
        action,
        details
    });
    // keep last 2000 entries
    if (db.audit_log.length > 2000) db.audit_log = db.audit_log.slice(0, 2000);
};

// --- Get client IP ---
const getClientIp = (req) => {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.headers['x-real-ip']
        || req.socket?.remoteAddress
        || 'unknown';
};

// ════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════

// --- Public Validation API (BACKWARD COMPATIBLE) ---
app.post('/api/v1/validate', validateLimiter, async (req, res) => {
    const { license_key, domain, device_id, device_type, nonce, features_used } = req.body;
    if (!license_key) return res.status(400).json({ status: 'invalid', message: 'No key provided' });

    const clientIp = getClientIp(req);

    try {
        const data = await getDB();
        const l = data.licenses.find(lic => lic.license_key === license_key);

        if (!l) {
            await addAuditLog(data, 'validate_failed', { license_key, reason: 'not_found', ip: clientIp });
            await saveDB(data);
            return res.status(404).json({ status: 'invalid', message: 'Lizenz-Key nicht gefunden.' });
        }

        const isExpired = new Date(l.expires_at) < new Date();
        if (isExpired) {
            await addAuditLog(data, 'validate_failed', { license_key, reason: 'expired', ip: clientIp });
            await saveDB(data);
            return res.status(403).json({ status: 'expired', message: 'Lizenz ist abgelaufen.' });
        }

        if (l.status !== 'active') {
            await addAuditLog(data, 'validate_failed', { license_key, reason: `status_${l.status}`, ip: clientIp });
            await saveDB(data);
            return res.status(403).json({ status: l.status, message: 'Lizenz ist nicht aktiv.' });
        }

        if (!domainMatches(l.associated_domain, domain)) {
            await addAuditLog(data, 'validate_failed', { license_key, reason: 'domain_mismatch', domain, ip: clientIp });
            await saveDB(data);
            return res.status(403).json({ status: 'domain_mismatch', message: `Lizenz ist nicht für Domain "${domain}" gültig.` });
        }

        // --- Replay Protection (optional nonce) ---
        if (nonce) {
            if (!data.used_nonces) data.used_nonces = [];
            const nonceAge = 5 * 60 * 1000; // 5 min window
            data.used_nonces = data.used_nonces.filter(n => Date.now() - n.ts < nonceAge);
            if (data.used_nonces.find(n => n.val === nonce)) {
                await addAuditLog(data, 'replay_attack', { license_key, nonce, ip: clientIp });
                await saveDB(data);
                return res.status(400).json({ status: 'replay', message: 'Nonce already used.' });
            }
            data.used_nonces.push({ val: nonce, ts: Date.now() });
        }

        // --- Device Management ---
        if (device_id) {
            if (!data.devices) data.devices = [];
            const maxDevices = l.max_devices || 0; // 0 = unlimited
            const licDevices = data.devices.filter(d => d.license_key === license_key && d.active);
            const existing = licDevices.find(d => d.device_id === device_id);

            if (!existing) {
                if (maxDevices > 0 && licDevices.length >= maxDevices) {
                    await addAuditLog(data, 'validate_failed', { license_key, reason: 'device_limit', device_id, ip: clientIp });
                    await saveDB(data);
                    return res.status(403).json({ status: 'device_limit', message: `Maximale Geräteanzahl (${maxDevices}) erreicht.` });
                }
                data.devices.push({
                    id: crypto.randomUUID(),
                    license_key,
                    device_id,
                    device_type: device_type || 'unknown',
                    ip: clientIp,
                    first_seen: new Date().toISOString(),
                    last_seen: new Date().toISOString(),
                    active: true
                });
                await addAuditLog(data, 'device_registered', { license_key, device_id, device_type, ip: clientIp });
            } else {
                existing.last_seen = new Date().toISOString();
                existing.ip = clientIp;
                if (device_type) existing.device_type = device_type;
            }
        }

        // --- Analytics tracking ---
        l.last_validated = new Date().toISOString();
        l.usage_count = (l.usage_count || 0) + 1;
        if (!l.analytics) l.analytics = { daily: {}, features: {} };
        const today = new Date().toISOString().slice(0, 10);
        l.analytics.daily[today] = (l.analytics.daily[today] || 0) + 1;
        if (features_used && Array.isArray(features_used)) {
            for (const f of features_used) {
                l.analytics.features[f] = (l.analytics.features[f] || 0) + 1;
            }
        }
        // keep only last 90 days in daily stats
        const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        for (const d of Object.keys(l.analytics.daily)) {
            if (d < cutoff) delete l.analytics.daily[d];
        }

        if (domain && (!l.validated_domains || !l.validated_domains.includes(domain))) {
            if (!l.validated_domains) l.validated_domains = [];
            l.validated_domains.push(domain);
        }
        l.validated_domain = domain;

        await addAuditLog(data, 'validate_success', { license_key, domain, device_id: device_id || null, ip: clientIp });
        await saveDB(data);

        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];

        // Find linked customer
        const customer = l.customer_id ? (data.customers || []).find(c => c.id === l.customer_id) : null;

        const responsePayload = {
            status: 'active',
            customer_name: l.customer_name,
            type: l.type,
            plan_label: plan.label,
            expires_at: l.expires_at,
            allowed_modules: l.allowed_modules || plan.modules,
            limits: l.limits || { max_dishes: plan.menu_items, max_tables: plan.max_tables },
            // Extended info (only if customer linked)
            ...(customer ? { account_email: customer.email, company: customer.company } : {})
        };

        // Sign response if HMAC_SECRET is properly set
        if (HMAC_SECRET !== 'hmac-change-me-in-production') {
            return res.json(signResponse(responsePayload));
        }
        return res.json(responsePayload);

    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

// --- Offline Token Generation ---
app.post('/api/v1/offline-token', validateLimiter, async (req, res) => {
    const { license_key, domain, device_id, duration_hours } = req.body;
    if (!license_key) return res.status(400).json({ success: false, message: 'No key provided' });

    try {
        const data = await getDB();
        const l = data.licenses.find(lic => lic.license_key === license_key);
        if (!l || l.status !== 'active' || new Date(l.expires_at) < new Date()) {
            return res.status(403).json({ success: false, message: 'License invalid or expired' });
        }
        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const hours = Math.min(duration_hours || 24, 168); // max 7 days
        const token = jwt.sign({
            license_key,
            domain,
            device_id,
            type: l.type,
            plan_label: plan.label,
            allowed_modules: l.allowed_modules || plan.modules,
            limits: l.limits || { max_dishes: plan.menu_items, max_tables: plan.max_tables },
            offline: true
        }, HMAC_SECRET, { expiresIn: `${hours}h` });

        await addAuditLog(data, 'offline_token_issued', { license_key, domain, device_id: device_id || null, duration_hours: hours, ip: getClientIp(req) });
        await saveDB(data);

        res.json({ success: true, offline_token: token, valid_hours: hours });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// --- Offline Token Verify (client-side helper endpoint) ---
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

// ════════════════════════════════════════════
// ADMIN API
// ════════════════════════════════════════════

// --- Admin Login ---
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ success: false, message: 'Username and password required' });
    try {
        const db = await getDB();
        const admin = (db.admins || []).find(a => a.username === username);
        if (!admin) {
            await addAuditLog(db, 'admin_login_failed', { username, ip: getClientIp(req) });
            await saveDB(db);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        const valid = await bcrypt.compare(password, admin.password_hash);
        if (!valid) {
            await addAuditLog(db, 'admin_login_failed', { username, ip: getClientIp(req) });
            await saveDB(db);
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        const token = jwt.sign(
            { username: admin.username, role: admin.role || 'admin' },
            ADMIN_SECRET, { expiresIn: '8h' }
        );
        await addAuditLog(db, 'admin_login', { username, ip: getClientIp(req) });
        await saveDB(db);
        res.json({ success: true, token, username: admin.username, role: admin.role || 'admin' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// --- User Management (superadmin only) ---
app.get('/api/admin/users', requireAuth, requireSuperAdmin, async (req, res) => {
    const db = await getDB();
    const users = (db.admins || []).map(({ password_hash, ...u }) => u);
    res.json({ users });
});

app.post('/api/admin/users', requireAuth, requireSuperAdmin, async (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password)
        return res.status(400).json({ success: false, message: 'Username and password required' });
    if (password.length < 8)
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    const allowedRoles = ['admin', 'superadmin'];
    const assignedRole = allowedRoles.includes(role) ? role : 'admin';
    try {
        const db = await getDB();
        if (!db.admins) db.admins = [];
        if (db.admins.find(a => a.username === username))
            return res.status(409).json({ success: false, message: 'Username already exists' });
        const hash = await bcrypt.hash(password, 12);
        const newUser = { username, password_hash: hash, role: assignedRole, created_at: new Date().toISOString() };
        db.admins.push(newUser);
        await addAuditLog(db, 'admin_user_created', { username, role: assignedRole, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true, user: { username, role: assignedRole, created_at: newUser.created_at } });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.delete('/api/admin/users/:username', requireAuth, requireSuperAdmin, async (req, res) => {
    if (req.params.username === req.admin.username)
        return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    try {
        const db = await getDB();
        const before = (db.admins || []).length;
        db.admins = db.admins.filter(a => a.username !== req.params.username);
        if (db.admins.length === before)
            return res.status(404).json({ success: false, message: 'User not found' });
        await addAuditLog(db, 'admin_user_deleted', { username: req.params.username, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.patch('/api/admin/users/:username/password', requireAuth, async (req, res) => {
    const isSelf = req.params.username === req.admin.username;
    const isSuperAdmin = req.admin.role === 'superadmin';
    if (!isSelf && !isSuperAdmin)
        return res.status(403).json({ success: false, message: 'Forbidden' });
    const { password } = req.body;
    if (!password || password.length < 8)
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    try {
        const db = await getDB();
        const user = (db.admins || []).find(a => a.username === req.params.username);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        user.password_hash = await bcrypt.hash(password, 12);
        await addAuditLog(db, 'admin_password_changed', { username: req.params.username, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// --- Plans ---
app.get('/api/admin/plans', requireAuth, (req, res) => res.json(PLAN_DEFINITIONS));

// --- Licenses ---
app.get('/api/admin/licenses', requireAuth, async (req, res) => {
    const db = await getDB();
    const now = new Date();
    const stats = {
        total: db.licenses.length,
        active: db.licenses.filter(l => l.status === 'active' && new Date(l.expires_at) > now).length,
        expiring: db.licenses.filter(l => { const d = (new Date(l.expires_at) - now) / 86400000; return d > 0 && d < 30; }).length,
        total_usage: db.licenses.reduce((s, l) => s + (l.usage_count || 0), 0)
    };
    res.json({ licenses: db.licenses, stats });
});

app.post('/api/admin/licenses', requireAuth, async (req, res) => {
    const db = await getDB();
    const raw = req.body;
    const plan = PLAN_DEFINITIONS[raw.type] || PLAN_DEFINITIONS['FREE'];
    const key = raw.license_key?.trim() || generateKey(raw.type);
    const expiresAt = raw.expires_at || new Date(Date.now() + plan.expires_days * 86400000).toISOString();
    const newLic = {
        license_key: key,
        type: raw.type || 'FREE',
        customer_name: raw.customer_name,
        customer_id: raw.customer_id || null,
        status: 'active',
        associated_domain: raw.associated_domain || '*',
        expires_at: expiresAt,
        allowed_modules: plan.modules,
        limits: { max_dishes: plan.menu_items, max_tables: plan.max_tables },
        max_devices: raw.max_devices ? parseInt(raw.max_devices) : 0,
        usage_count: 0,
        last_validated: null,
        validated_domain: null,
        validated_domains: [],
        analytics: { daily: {}, features: {} },
        created_at: new Date().toISOString()
    };
    const idx = db.licenses.findIndex(l => l.license_key === key);
    if (idx > -1) db.licenses[idx] = { ...db.licenses[idx], ...newLic };
    else db.licenses.unshift(newLic);
    await addAuditLog(db, 'license_created', { license_key: key, type: raw.type, customer_name: raw.customer_name, by: req.admin.username });
    await saveDB(db);
    res.json({ success: true, license: newLic });
});

app.patch('/api/admin/licenses/:key/status', requireAuth, async (req, res) => {
    const db = await getDB();
    const l = db.licenses.find(x => x.license_key === req.params.key);
    if (!l) return res.status(404).json({ success: false });
    const oldStatus = l.status;
    l.status = req.body.status;
    await addAuditLog(db, 'license_status_changed', { license_key: req.params.key, from: oldStatus, to: req.body.status, by: req.admin.username });
    await saveDB(db);
    res.json({ success: true });
});

app.delete('/api/admin/licenses/:key', requireAuth, async (req, res) => {
    const db = await getDB();
    db.licenses = db.licenses.filter(l => l.license_key !== req.params.key);
    await addAuditLog(db, 'license_deleted', { license_key: req.params.key, by: req.admin.username });
    await saveDB(db);
    res.json({ success: true });
});

// --- Customer API ---
app.get('/api/admin/customers', requireAuth, async (req, res) => {
    const db = await getDB();
    res.json({ customers: db.customers || [] });
});

app.post('/api/admin/customers', requireAuth, async (req, res) => {
    const { name, email, company, payment_status, notes } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Name required' });
    try {
        const db = await getDB();
        if (!db.customers) db.customers = [];
        const newCustomer = {
            id: crypto.randomUUID(),
            name,
            email: email || null,
            company: company || null,
            payment_status: payment_status || 'unknown',
            notes: notes || '',
            created_at: new Date().toISOString()
        };
        db.customers.push(newCustomer);
        await addAuditLog(db, 'customer_created', { customer_id: newCustomer.id, name, email, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true, customer: newCustomer });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.patch('/api/admin/customers/:id', requireAuth, async (req, res) => {
    try {
        const db = await getDB();
        const customer = (db.customers || []).find(c => c.id === req.params.id);
        if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });
        const { name, email, company, payment_status, notes } = req.body;
        if (name) customer.name = name;
        if (email !== undefined) customer.email = email;
        if (company !== undefined) customer.company = company;
        if (payment_status) customer.payment_status = payment_status;
        if (notes !== undefined) customer.notes = notes;
        customer.updated_at = new Date().toISOString();
        await addAuditLog(db, 'customer_updated', { customer_id: req.params.id, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true, customer });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.delete('/api/admin/customers/:id', requireAuth, async (req, res) => {
    try {
        const db = await getDB();
        db.customers = (db.customers || []).filter(c => c.id !== req.params.id);
        await addAuditLog(db, 'customer_deleted', { customer_id: req.params.id, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Link license to customer
app.patch('/api/admin/licenses/:key/customer', requireAuth, async (req, res) => {
    try {
        const db = await getDB();
        const l = db.licenses.find(x => x.license_key === req.params.key);
        if (!l) return res.status(404).json({ success: false });
        l.customer_id = req.body.customer_id || null;
        await addAuditLog(db, 'license_customer_linked', { license_key: req.params.key, customer_id: l.customer_id, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// --- Device Management API ---
app.get('/api/admin/devices', requireAuth, async (req, res) => {
    const db = await getDB();
    const { license_key } = req.query;
    let devices = db.devices || [];
    if (license_key) devices = devices.filter(d => d.license_key === license_key);
    res.json({ devices });
});

app.patch('/api/admin/devices/:id/deactivate', requireAuth, async (req, res) => {
    try {
        const db = await getDB();
        const device = (db.devices || []).find(d => d.id === req.params.id);
        if (!device) return res.status(404).json({ success: false });
        device.active = false;
        device.deactivated_at = new Date().toISOString();
        await addAuditLog(db, 'device_deactivated', { device_id: device.device_id, license_key: device.license_key, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.delete('/api/admin/devices/:id', requireAuth, async (req, res) => {
    try {
        const db = await getDB();
        const device = (db.devices || []).find(d => d.id === req.params.id);
        if (!device) return res.status(404).json({ success: false });
        db.devices = db.devices.filter(d => d.id !== req.params.id);
        await addAuditLog(db, 'device_removed', { device_id: device.device_id, license_key: device.license_key, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// --- Analytics API ---
app.get('/api/admin/analytics', requireAuth, async (req, res) => {
    const db = await getDB();
    const licenses = db.licenses || [];
    const now = new Date();

    const topLicenses = [...licenses]
        .sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0))
        .slice(0, 10)
        .map(l => ({ license_key: l.license_key, customer_name: l.customer_name, type: l.type, usage_count: l.usage_count || 0, last_validated: l.last_validated }));

    // aggregate daily across all licenses (last 30 days)
    const daily = {};
    for (const l of licenses) {
        if (l.analytics?.daily) {
            for (const [day, count] of Object.entries(l.analytics.daily)) {
                daily[day] = (daily[day] || 0) + count;
            }
        }
    }

    // aggregate feature usage
    const features = {};
    for (const l of licenses) {
        if (l.analytics?.features) {
            for (const [f, count] of Object.entries(l.analytics.features)) {
                features[f] = (features[f] || 0) + count;
            }
        }
    }

    res.json({
        top_licenses: topLicenses,
        daily_requests: daily,
        feature_usage: features,
        total_devices: (db.devices || []).length,
        active_devices: (db.devices || []).filter(d => d.active).length
    });
});

// --- Audit Log API ---
app.get('/api/admin/audit-log', requireAuth, async (req, res) => {
    const db = await getDB();
    const { limit = 100, action, license_key } = req.query;
    let logs = db.audit_log || [];
    if (action) logs = logs.filter(l => l.action === action);
    if (license_key) logs = logs.filter(l => l.details?.license_key === license_key);
    res.json({ logs: logs.slice(0, parseInt(limit)) });
});

// --- Impersonate (generate read-only token context) ---
app.post('/api/admin/impersonate', requireAuth, requireSuperAdmin, async (req, res) => {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ success: false });
    try {
        const db = await getDB();
        const l = db.licenses.find(x => x.license_key === license_key);
        if (!l) return res.status(404).json({ success: false });
        const customer = l.customer_id ? (db.customers || []).find(c => c.id === l.customer_id) : null;
        const devices = (db.devices || []).filter(d => d.license_key === license_key);
        await addAuditLog(db, 'impersonate', { license_key, by: req.admin.username });
        await saveDB(db);
        res.json({ success: true, license: l, customer: customer || null, devices });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

app.listen(PORT, () => {
    console.log(`\n🏘️  OPA License Server running on http://localhost:${PORT}`);
    console.log(`📋  Plans: ${Object.keys(PLAN_DEFINITIONS).join(' | ')}`);
    console.log(`🌐  CORS: ${allowedOrigins ? allowedOrigins.join(', ') : 'alle Origins erlaubt'}`);
    console.log(`🔐  HMAC Signing: ${HMAC_SECRET !== 'hmac-change-me-in-production' ? 'AKTIV' : 'INAKTIV (HMAC_SECRET nicht gesetzt)'}\n`);
});
