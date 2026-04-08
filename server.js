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

if (ADMIN_SECRET === 'change-me-in-production') {
    console.warn('⚠️  WARNING: ADMIN_SECRET is not set in .env! Using insecure default.');
}

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate Limiters ────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Too many login attempts. Please wait 15 minutes.' }
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
    try {
        req.admin = jwt.verify(token, ADMIN_SECRET);
        next();
    } catch (e) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
};

// Nur "superadmin" darf User verwalten
const requireSuperAdmin = (req, res, next) => {
    if (req.admin.role !== 'superadmin')
        return res.status(403).json({ success: false, message: 'Superadmin required' });
    next();
};

// ─── Plan Definitions ─────────────────────────────────────────────────────
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

// ─── DB Utility ──────────────────────────────────────────────────────────────
const getDB = async () => JSON.parse(await readFile(DB_PATH, 'utf-8'));
const saveDB = async (data) => await writeFile(DB_PATH, JSON.stringify(data, null, 2));

// ─── Key Generator ───────────────────────────────────────────────────────────
const generateKey = (type) => {
    const prefix = { FREE:'OPA-FREE', STARTER:'OPA-START', PRO:'OPA-PRO', PRO_PLUS:'OPA-PROPLUS', ENTERPRISE:'OPA-ENT' }[type] || 'OPA-UNKNOWN';
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${rand}-${new Date().getFullYear()}`;
};

// ─── Admin Login ──────────────────────────────────────────────────────────────
app.post('/api/admin/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ success: false, message: 'Username and password required' });
    try {
        const db = await getDB();
        const admin = (db.admins || []).find(a => a.username === username);
        if (!admin) return res.status(401).json({ success: false, message: 'Invalid credentials' });
        const valid = await bcrypt.compare(password, admin.password_hash);
        if (!valid) return res.status(401).json({ success: false, message: 'Invalid credentials' });
        const token = jwt.sign(
            { username: admin.username, role: admin.role || 'admin' },
            ADMIN_SECRET,
            { expiresIn: '8h' }
        );
        res.json({ success: true, token, username: admin.username, role: admin.role || 'admin' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// ─── User Management (superadmin only) ─────────────────────────────
// GET alle Admins (ohne password_hash)
app.get('/api/admin/users', requireAuth, requireSuperAdmin, async (req, res) => {
    const db = await getDB();
    const users = (db.admins || []).map(({ password_hash, ...u }) => u);
    res.json({ users });
});

// POST neuen Admin erstellen
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
        await saveDB(db);
        res.json({ success: true, user: { username, role: assignedRole, created_at: newUser.created_at } });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// DELETE Admin löschen (darf nicht sich selbst löschen)
app.delete('/api/admin/users/:username', requireAuth, requireSuperAdmin, async (req, res) => {
    if (req.params.username === req.admin.username)
        return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
    try {
        const db = await getDB();
        const before = (db.admins || []).length;
        db.admins = db.admins.filter(a => a.username !== req.params.username);
        if (db.admins.length === before)
            return res.status(404).json({ success: false, message: 'User not found' });
        await saveDB(db);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// PATCH Passwort ändern (superadmin für alle, admin nur eigenes)
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
        await saveDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// ─── Public Validation API ───────────────────────────────────────────────────
app.post('/api/v1/validate', apiLimiter, async (req, res) => {
    const { license_key, domain } = req.body;
    if (!license_key) return res.status(400).json({ status: 'invalid', message: 'No key provided' });
    try {
        const data = await getDB();
        const l = data.licenses.find(lic => lic.license_key === license_key);
        if (!l) return res.status(404).json({ status: 'invalid', message: 'Key not found' });
        const isExpired = new Date(l.expires_at) < new Date();
        if (isExpired) return res.status(403).json({ status: 'expired', message: 'License expired' });
        if (l.status !== 'active') return res.status(403).json({ status: l.status, message: 'License not active' });
        l.last_validated = new Date().toISOString();
        l.validated_domain = domain;
        l.usage_count = (l.usage_count || 0) + 1;
        await saveDB(data);
        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        return res.json({
            status: 'active',
            customer_name: l.customer_name,
            type: l.type,
            plan_label: plan.label,
            expires_at: l.expires_at,
            allowed_modules: l.allowed_modules || plan.modules,
            limits: l.limits || { max_dishes: plan.menu_items, max_tables: plan.max_tables }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
    }
});

// ─── Protected License API ─────────────────────────────────────────────────
app.get('/api/admin/plans', requireAuth, (req, res) => res.json(PLAN_DEFINITIONS));

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
        license_key: key, type: raw.type || 'FREE', customer_name: raw.customer_name,
        status: 'active', associated_domain: raw.associated_domain || '*', expires_at: expiresAt,
        allowed_modules: plan.modules, limits: { max_dishes: plan.menu_items, max_tables: plan.max_tables },
        usage_count: 0, last_validated: null, validated_domain: null, created_at: new Date().toISOString()
    };
    const idx = db.licenses.findIndex(l => l.license_key === key);
    if (idx > -1) db.licenses[idx] = { ...db.licenses[idx], ...newLic };
    else db.licenses.unshift(newLic);
    await saveDB(db);
    res.json({ success: true, license: newLic });
});

app.patch('/api/admin/licenses/:key/status', requireAuth, async (req, res) => {
    const db = await getDB();
    const l = db.licenses.find(x => x.license_key === req.params.key);
    if (!l) return res.status(404).json({ success: false });
    l.status = req.body.status;
    await saveDB(db);
    res.json({ success: true });
});

app.delete('/api/admin/licenses/:key', requireAuth, async (req, res) => {
    const db = await getDB();
    db.licenses = db.licenses.filter(l => l.license_key !== req.params.key);
    await saveDB(db);
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`🏛️  OPA License Server running on http://localhost:${PORT}`);
    console.log(`📋  Plans: ${Object.keys(PLAN_DEFINITIONS).join(' | ')}`);
});
