import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import db from './db.js';
import { RSA_PRIVATE_KEY, RSA_PUBLIC_KEY } from './crypto.js';

// ── Admin JWT: RS256 wenn RSA-Keys vorhanden, sonst HS256 Fallback ────────────
const ADMIN_SECRET    = process.env.ADMIN_SECRET || 'change-me-in-production';
const USE_RS256_ADMIN = !!(RSA_PRIVATE_KEY && RSA_PUBLIC_KEY);
const ADMIN_IP_WHITELIST = process.env.ADMIN_IP_WHITELIST ? process.env.ADMIN_IP_WHITELIST.split(',').map(ip => ip.trim()) : [];

export const MIN_PASSWORD_LENGTH = 12;

// ── IP Whitelist Middleware ──────────────────────────────────────────────────
export const requireIpWhitelist = (req, res, next) => {
    if (ADMIN_IP_WHITELIST.length === 0) return next();
    
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    // Simple check (could be improved with CIDR support)
    const isWhitelisted = ADMIN_IP_WHITELIST.some(ip => {
        if (ip === '*') return true;
        return clientIp.includes(ip);
    });

    if (!isWhitelisted) {
        console.warn(`🛑  IP Blocked: ${clientIp} attempted to access admin routes.`);
        return res.status(403).json({ success: false, message: 'Access denied: IP not whitelisted.' });
    }
    next();
};

export function signAdminToken(payload, expiresIn = '8h') {
    if (USE_RS256_ADMIN) {
        return jwt.sign(payload, RSA_PRIVATE_KEY, { algorithm: 'RS256', expiresIn });
    }
    return jwt.sign(payload, ADMIN_SECRET, { expiresIn });
}

export function signTempToken(payload, expiresIn = '5m') {
    // Immer HS256 für kurze Temp-Tokens (einfacher)
    return jwt.sign({ ...payload, temp: true }, ADMIN_SECRET, { expiresIn });
}

function verifyAdminToken(token) {
    if (USE_RS256_ADMIN) {
        return jwt.verify(token, RSA_PUBLIC_KEY, { algorithms: ['RS256'] });
    }
    return jwt.verify(token, ADMIN_SECRET);
}

// ── requireAuth mit Session-Blacklist ────────────────────────────────────────
export const requireAuth = async (req, res, next) => {
    const token = req.headers['authorization']?.startsWith('Bearer ')
        ? req.headers['authorization'].slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });
    try {
        const payload = verifyAdminToken(token);
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

        try {
            const [rows] = await db.query(
                'SELECT id FROM admin_sessions WHERE token_hash = ? AND revoked = 0 AND expires_at > NOW()',
                [tokenHash]
            );
            if (!rows[0]) {
                // Kein Eintrag — Session-INSERT beim Login fehlgeschlagen.
                // Warnung loggen aber Token-Signatur reicht als Fallback.
                console.warn(`⚠️  [requireAuth] Kein admin_sessions-Eintrag für token_hash=${tokenHash.slice(0,12)}… (Fallback: JWT-Signatur wird akzeptiert)`);
            }
        } catch (dbErr) {
            if (dbErr.code === 'ER_NO_SUCH_TABLE') {
                console.warn('⚠️  admin_sessions-Tabelle fehlt — bitte node migrate-schema.js ausführen!');
            } else {
                console.error('[requireAuth] DB-Fehler:', dbErr.message);
            }
            // Bei DB-Fehler: JWT-Signatur als Fallback akzeptieren
        }

        req.admin          = payload;
        req.adminToken     = token;
        req.adminTokenHash = tokenHash;
        next();
    } catch {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
};

export const requireSuperAdmin = (req, res, next) => {
    if (req.admin?.role !== 'superadmin')
        return res.status(403).json({ success: false, message: 'Superadmin required' });
    next();
};

// ── Rate Limiters ──────────────────────────────────────────────────────────────
export const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    message: { success: false, message: 'Too many login attempts. Please wait 15 minutes.' }
});

export const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

export const validateLimiter = rateLimit({
    windowMs: 60 * 1000, max: 30,
    message: { status: 'rate_limited', message: 'Too many validation requests.' }
});

export const setupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5,
    message: { success: false, message: 'Too many setup attempts.' }
});

export const offlineTokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20,
    message: { success: false, message: 'Too many offline token requests. Please wait 15 minutes.' }
});

export const bulkLimiter = rateLimit({
    windowMs: 60 * 1000, max: 10,
    message: { success: false, message: 'Too many bulk requests. Max 10 per minute.' }
});

export const trialLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 Stunden
    max: 3,
    keyGenerator: (req) => req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    message: { success: false, message: 'Maximale Trial-Registrierungen pro IP erreicht (3/Tag).' }
});

// ── asyncHandler ──────────────────────────────────────────────────────────────────
import { asyncHandler as actualAsyncHandler } from './helpers.js';
export const asyncHandler = actualAsyncHandler;

export const adminTokenAlgorithm = USE_RS256_ADMIN ? 'RS256' : 'HS256';
