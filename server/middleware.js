import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import db from './db.js';
import { RSA_PRIVATE_KEY, RSA_PUBLIC_KEY } from './crypto.js';

// ── Admin JWT: RS256 wenn RSA-Keys vorhanden, sonst HS256 Fallback ────────────
const ADMIN_SECRET     = process.env.ADMIN_SECRET || 'change-me-in-production';
const USE_RS256_ADMIN  = !!(RSA_PRIVATE_KEY && RSA_PUBLIC_KEY);

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Erstellt einen Admin-JWT.
 * RS256 (RSA) wird bevorzugt wenn RSA_PRIVATE_KEY gesetzt ist, sonst HS256.
 */
export function signAdminToken(payload, expiresIn = '8h') {
    if (USE_RS256_ADMIN) {
        return jwt.sign(payload, RSA_PRIVATE_KEY, { algorithm: 'RS256', expiresIn });
    }
    return jwt.sign(payload, ADMIN_SECRET, { expiresIn });
}

/**
 * Verifiziert einen Admin-JWT (RS256 oder HS256).
 */
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
        // Session-Blacklist prüfen: Token muss in admin_sessions existieren und aktiv sein
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const [rows] = await db.query(
            'SELECT id FROM admin_sessions WHERE token_hash = ? AND revoked = 0 AND expires_at > NOW()',
            [tokenHash]
        );
        if (!rows[0]) {
            return res.status(401).json({ success: false, message: 'Session ungültig oder abgelaufen. Bitte erneut einloggen.' });
        }
        req.admin      = payload;
        req.adminToken = token;
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

// ── Rate Limiters ─────────────────────────────────────────────────────────────
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

// Dedizierter Limiter für /offline-token (strenger als validateLimiter)
export const offlineTokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 10,
    message: { success: false, message: 'Too many offline token requests. Please wait 15 minutes.' }
});

// ── asyncHandler: eliminiert try/catch-Boilerplate in Route-Handlern ─────────
export const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// ── Exportiert das aktuelle Token-Signing-Schema für Startlog ─────────────────
export const adminTokenAlgorithm = USE_RS256_ADMIN ? 'RS256' : 'HS256';
