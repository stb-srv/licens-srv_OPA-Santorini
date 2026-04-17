import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import path from 'path';
import { testConnection } from './server/db.js';
import db from './server/db.js';
import { RSA_PRIVATE_KEY, RSA_PUBLIC_KEY, isHmacActive } from './server/crypto.js';
import { startCron } from './server/cron.js';
import { PLAN_DEFINITIONS } from './server/plans.js';
import publicRoutes from './server/routes/public.js';
import adminRoutes from './server/routes/admin.js';
import portalRoutes from './server/routes/customer-portal.js';
import { envSmtp } from './server/smtp.js';
import { adminTokenAlgorithm, requireIpWhitelist } from './server/middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
export { app };
const PORT = process.env.PORT || 4000;
const ADMIN_SECRET  = process.env.ADMIN_SECRET  || 'change-me-in-production';
const HMAC_SECRET   = process.env.HMAC_SECRET   || 'hmac-change-me-in-production';
const PORTAL_SECRET = process.env.PORTAL_SECRET || '';
const SETUP_TOKEN   = process.env.SETUP_TOKEN   || '';

// ── Environment-Validierung ───────────────────────────────────────────────────
const FATAL_ERRORS = [];

if (!process.env.DB_HOST) FATAL_ERRORS.push('DB_HOST fehlt in .env');
if (!process.env.DB_USER) FATAL_ERRORS.push('DB_USER fehlt in .env');
if (!process.env.DB_PASS) FATAL_ERRORS.push('DB_PASS fehlt in .env');
if (!process.env.DB_NAME) FATAL_ERRORS.push('DB_NAME fehlt in .env');

if (ADMIN_SECRET === 'change-me-in-production')
    FATAL_ERRORS.push('ADMIN_SECRET ist der unsichere Default-Wert oder fehlt!');
if (!PORTAL_SECRET)
    FATAL_ERRORS.push('PORTAL_SECRET fehlt in .env – Kunden-Portal läuft ohne Authentifizierung!');

if (!HMAC_SECRET || HMAC_SECRET === 'hmac-change-me-in-production')
    FATAL_ERRORS.push('HMAC_SECRET fehlt oder ist unsicher! (HS256 Offline-Token Sicherheit)');
if (HMAC_SECRET.length < 32)
    console.warn(`⚠️  HMAC_SECRET ist kurz (${HMAC_SECRET.length} Zeichen). Empfehlung: min. 32 Zeichen.`);

if (FATAL_ERRORS.length > 0) {
    console.error('❌ FATAL: Server-Start abgebrochen wegen Konfigurationsfehlern:');
    FATAL_ERRORS.forEach(e => console.error(`   • ${e}`));
    process.exit(1);
}

if (!RSA_PRIVATE_KEY)  console.warn('⚠️  RSA_PRIVATE_KEY nicht gesetzt – License-JWT Signing deaktiviert!');
if (!SETUP_TOKEN)      console.warn('⚠️  SETUP_TOKEN nicht gesetzt – POST /api/v1/setup ist deaktiviert!');

console.log(`🔐  Admin-JWT Algorithmus: ${adminTokenAlgorithm}${adminTokenAlgorithm === 'HS256' ? ' (RS256 wird empfohlen – RSA_PRIVATE_KEY setzen)' : ' ✅'}`);

// ── DB ───────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
    try { await testConnection(); }
    catch (e) { console.error('❌  MySQL Verbindungsfehler:', e.message); process.exit(1); }
}

// ── Security Headers (Helmet) ─────────────────────────────────────────────────
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
        directives: {
            defaultSrc:     ["'self'"],
            scriptSrc:      ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            scriptSrcAttr:  ["'self'", "'unsafe-inline'"],
            styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            styleSrcElem:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            imgSrc:         ["'self'", "data:", "https:"],
            connectSrc:     ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            fontSrc:        ["'self'", "https:", "data:", "https://fonts.gstatic.com"],
            objectSrc:      ["'none'"],
            upgradeInsecureRequests: [],
        },
    },
}));

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
        if (staticAllowedOrigins.length === 0) {
            const dynamic = await getDynamicAllowedOrigins();
            if (dynamic.includes(origin)) return callback(null, true);
            console.error(`❌ CORS: Origin '${origin}' nicht erlaubt (kein CORS_ORIGINS konfiguriert).`);
            return callback(new Error(`CORS: Origin '${origin}' nicht erlaubt.`), false);
        }
        if (staticAllowedOrigins.includes(origin)) return callback(null, true);
        const dynamic = await getDynamicAllowedOrigins();
        if (dynamic.includes(origin)) return callback(null, true);
        console.error(`❌ CORS: Origin '${origin}' nicht erlaubt.`);
        callback(new Error(`CORS: Origin '${origin}' nicht erlaubt.`), false);
    },
    credentials: true
}));

app.use(express.json());

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/v1', publicRoutes);
app.use('/api/admin', requireIpWhitelist, adminRoutes);
app.use('/api/portal', portalRoutes);

// ── Static Files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Favicon Fallback ─────────────────────────────────────────────────────────
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── API 404-Handler ───────────────────────────────────────────────────────────
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, message: `Route ${req.method} /api${req.path} nicht gefunden.` });
});

// ── Globaler Fehler-Handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error('❌ Unbehandelter Fehler:', err.message || err);
    if (res.headersSent) return;
    if (err.message && err.message.startsWith('CORS:')) {
        return res.status(403).json({ success: false, message: err.message });
    }
    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Interner Serverfehler'
    });
});

// ── Cron ─────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
    startCron();
}

// ── Start ────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
        console.log(`\n🏛️  OPA! Santorini License Server v2.1 läuft auf http://localhost:${PORT}`);
        console.log(`📋  Pläne: ${Object.keys(PLAN_DEFINITIONS).join(' | ')}`);
        console.log(`🌐  CORS: ${staticAllowedOrigins.length > 0 ? staticAllowedOrigins.join(', ') + ' + dynamisch aus DB' : 'nur dynamisch aus DB (CORS_ORIGINS nicht gesetzt)'}`);
        console.log(`🔐  HMAC Signing: ${isHmacActive() ? 'AKTIV' : 'INAKTIV'}`);
        console.log(`🔑  RSA JWT Signing: ${RSA_PRIVATE_KEY ? 'AKTIV (RS256)' : 'INAKTIV'}`);
        console.log(`📧  SMTP: ${(envSmtp.host && envSmtp.user) ? `${envSmtp.host}:${envSmtp.port}` : 'nicht konfiguriert'}`);
        console.log(`🔒  Setup-Endpoint: ${SETUP_TOKEN ? 'AKTIV' : 'DEAKTIVIERT'}`);
        console.log(`🧑‍💼  Kunden-Portal: ${PORTAL_SECRET ? 'AKTIV (/portal.html)' : 'DEAKTIVIERT (PORTAL_SECRET fehlt)'}\n`);
    });
}
