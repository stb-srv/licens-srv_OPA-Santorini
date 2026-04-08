import express from 'express';
import cors from 'cors';
import { readFile, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.json');

const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Plan Definitions (Single Source of Truth) ───────────────────────────────
export const PLAN_DEFINITIONS = {
    FREE: {
        label: 'Free',
        menu_items: 10,
        max_tables: 5,
        expires_days: 36500, // never (100 years)
        modules: {
            menu_edit: true,
            orders_kitchen: false,
            reservations: false,
            custom_design: false,
            analytics: false,
            qr_pay: false
        }
    },
    STARTER: {
        label: 'Starter',
        menu_items: 40,
        max_tables: 10,
        expires_days: 365,
        modules: {
            menu_edit: true,
            orders_kitchen: true,
            reservations: true,
            custom_design: false,
            analytics: false,
            qr_pay: false
        }
    },
    PRO: {
        label: 'Pro',
        menu_items: 100,
        max_tables: 25,
        expires_days: 365,
        modules: {
            menu_edit: true,
            orders_kitchen: true,
            reservations: true,
            custom_design: true,
            analytics: false,
            qr_pay: false
        }
    },
    PRO_PLUS: {
        label: 'Pro+',
        menu_items: 200,
        max_tables: 50,
        expires_days: 365,
        modules: {
            menu_edit: true,
            orders_kitchen: true,
            reservations: true,
            custom_design: true,
            analytics: true,
            qr_pay: false
        }
    },
    ENTERPRISE: {
        label: 'Enterprise',
        menu_items: 500,
        max_tables: 999,
        expires_days: 365,
        modules: {
            menu_edit: true,
            orders_kitchen: true,
            reservations: true,
            custom_design: true,
            analytics: true,
            qr_pay: true
        }
    }
};

// ─── DB Utility ──────────────────────────────────────────────────────────────
const getDB = async () => JSON.parse(await readFile(DB_PATH, 'utf-8'));
const saveDB = async (data) => await writeFile(DB_PATH, JSON.stringify(data, null, 2));

// ─── Key Generator ───────────────────────────────────────────────────────────
const generateKey = (type) => {
    const prefix = {
        FREE:       'OPA-FREE',
        STARTER:    'OPA-START',
        PRO:        'OPA-PRO',
        PRO_PLUS:   'OPA-PROPLUS',
        ENTERPRISE: 'OPA-ENT'
    }[type] || 'OPA-UNKNOWN';
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
    const year = new Date().getFullYear();
    return `${prefix}-${rand}-${year}`;
};

// ─── Public Validation API ───────────────────────────────────────────────────
app.post('/api/v1/validate', async (req, res) => {
    const { license_key, domain } = req.body;
    if (!license_key) return res.status(400).json({ status: 'invalid', message: 'No key provided' });
    try {
        const data = await getDB();
        const l = data.licenses.find(lic => lic.license_key === license_key);
        if (!l) return res.status(404).json({ status: 'invalid', message: 'Key not found' });

        const isExpired = new Date(l.expires_at) < new Date();
        if (isExpired) return res.status(403).json({ status: 'expired', message: 'License expired' });

        if (l.status !== 'active') return res.status(403).json({ status: l.status, message: 'License not active' });

        // Track usage
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

// ─── Management API ───────────────────────────────────────────────────────────
app.get('/api/admin/plans', (req, res) => {
    res.json(PLAN_DEFINITIONS);
});

app.get('/api/admin/licenses', async (req, res) => {
    const db = await getDB();
    const now = new Date();
    const stats = {
        total: db.licenses.length,
        active: db.licenses.filter(l => l.status === 'active' && new Date(l.expires_at) > now).length,
        expiring: db.licenses.filter(l => {
            const exp = new Date(l.expires_at);
            const diff = (exp - now) / (1000 * 60 * 60 * 24);
            return diff > 0 && diff < 30;
        }).length,
        total_usage: db.licenses.reduce((s, l) => s + (l.usage_count || 0), 0)
    };
    res.json({ licenses: db.licenses, stats });
});

app.post('/api/admin/licenses', async (req, res) => {
    const db = await getDB();
    const raw = req.body;
    const plan = PLAN_DEFINITIONS[raw.type] || PLAN_DEFINITIONS['FREE'];

    // Auto-generate key if not provided
    const key = raw.license_key && raw.license_key.trim()
        ? raw.license_key.trim()
        : generateKey(raw.type);

    // Auto-set expiry based on plan
    const expiresAt = raw.expires_at
        ? raw.expires_at
        : new Date(Date.now() + plan.expires_days * 24 * 60 * 60 * 1000).toISOString();

    const newLic = {
        license_key: key,
        type: raw.type || 'FREE',
        customer_name: raw.customer_name,
        status: 'active',
        associated_domain: raw.associated_domain || '*',
        expires_at: expiresAt,
        allowed_modules: plan.modules,
        limits: {
            max_dishes: plan.menu_items,
            max_tables: plan.max_tables
        },
        usage_count: 0,
        last_validated: null,
        validated_domain: null,
        created_at: new Date().toISOString()
    };

    const idx = db.licenses.findIndex(l => l.license_key === key);
    if (idx > -1) {
        db.licenses[idx] = { ...db.licenses[idx], ...newLic };
    } else {
        db.licenses.unshift(newLic);
    }

    await saveDB(db);
    res.json({ success: true, license: newLic });
});

app.patch('/api/admin/licenses/:key/status', async (req, res) => {
    const db = await getDB();
    const l = db.licenses.find(x => x.license_key === req.params.key);
    if (!l) return res.status(404).json({ success: false });
    l.status = req.body.status;
    await saveDB(db);
    res.json({ success: true });
});

app.delete('/api/admin/licenses/:key', async (req, res) => {
    const db = await getDB();
    db.licenses = db.licenses.filter(l => l.license_key !== req.params.key);
    await saveDB(db);
    res.json({ success: true });
});

app.listen(PORT, () => {
    console.log(`🏛️  OPA License Server running on http://localhost:${PORT}`);
    console.log(`📋  Plans: ${Object.keys(PLAN_DEFINITIONS).join(' | ')}`);
});
