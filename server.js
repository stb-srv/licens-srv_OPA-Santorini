import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import { testConnection } from './server/db.js';
import db from './server/db.js';
import { RSA_PRIVATE_KEY, RSA_PUBLIC_KEY, isHmacActive } from './server/crypto.js';
import { startCron } from './server/cron.js';
import { PLAN_DEFINITIONS } from './server/plans.js';
import publicRoutes from './server/routes/public.js';
import adminRoutes from './server/routes/admin.js';
import { envSmtp } from './server/smtp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';
const HMAC_SECRET = process.env.HMAC_SECRET || 'hmac-change-me-in-production';
const SETUP_TOKEN = process.env.SETUP_TOKEN || '';

// ── Startup Warnings ─────────────────────────────────────────────────────────
if (!RSA_PRIVATE_KEY)   console.warn('⚠️  RSA_PRIVATE_KEY nicht gesetzt – JWT Signing deaktiviert!');
if (ADMIN_SECRET === 'change-me-in-production') console.warn('⚠️  ADMIN_SECRET ist unsicher!');
if (HMAC_SECRET === 'hmac-change-me-in-production') console.warn('⚠️  HMAC_SECRET ist unsicher!');
if (!SETUP_TOKEN)       console.warn('⚠️  SETUP_TOKEN nicht gesetzt – POST /api/v1/setup ist deaktiviert!');

// ── DB ───────────────────────────────────────────────────────────────────────
try { await testConnection(); }
catch (e) { console.error('❌  MySQL Verbindungsfehler:', e.message); process.exit(1); }

// ── CORS (dynamisch aus DB + .env) ───────────────────────────────────────────
const rawCorsOrigins = process.env.CORS_ORIGINS || '';
const staticAllowedOrigins = rawCorsOrigins ? rawCorsOrigins.split(',').map(o => o.trim()).filter(Boolean) : [];

async function getDynamicAllowedOrigins() {
    try {
        const [rows] = await db.query(
            "SELECT DISTINCT associated_domain FROM licenses WHERE status = 'active' AND associated_domain IS NOT NULL AND associated_domain != '*'"
        );
        const dynamic = [];
        for (const { associated_domain } of rows) {
            const clean = associated_domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '');
            if (clean) { dynamic.push(`https://${clean}`); dynamic.push(`http://${clean}`); }
        }
        return dynamic;
    } catch { return []; }
}

app.set('trust proxy', 1);
app.use(cors({
    origin: async (origin, callback) => {
        if (!origin) return callback(null, true);
        if (staticAllowedOrigins.length === 0) return callback(null, true);
        if (staticAllowedOrigins.includes(origin)) return callback(null, true);
        const dynamic = await getDynamicAllowedOrigins();
        if (dynamic.includes(origin)) return callback(null, true);
        console.error(`❌ CORS: Origin '${origin}' nicht erlaubt.`);
        callback(new Error(`CORS: Origin '${origin}' nicht erlaubt.`), false);
    },
    credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/v1', publicRoutes);
app.use('/api/admin', adminRoutes);

// ── Cron ─────────────────────────────────────────────────────────────────────
startCron();

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🏛️  OPA! Santorini License Server v2.1 läuft auf http://localhost:${PORT}`);
    console.log(`📋  Pläne: ${Object.keys(PLAN_DEFINITIONS).join(' | ')}`);
    console.log(`🌐  CORS: ${staticAllowedOrigins.length > 0 ? staticAllowedOrigins.join(', ') + ' + dynamisch aus DB' : 'alle Origins erlaubt'}`);
    console.log(`🔐  HMAC Signing: ${isHmacActive() ? 'AKTIV' : 'INAKTIV'}`);
    console.log(`🔑  RSA JWT Signing: ${RSA_PRIVATE_KEY ? 'AKTIV (RS256)' : 'INAKTIV'}`);
    console.log(`📧  SMTP: ${(envSmtp.host && envSmtp.user) ? `${envSmtp.host}:${envSmtp.port}` : 'nicht konfiguriert'}`);
    console.log(`🔒  Setup-Endpoint: ${SETUP_TOKEN ? 'AKTIV' : 'DEAKTIVIERT'}\n`);
});
