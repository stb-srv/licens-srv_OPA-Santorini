/**
 * server/routes/customer-portal.js
 * Kunden-Portal API — /api/portal/*
 * Kunden können sich einloggen, ihre Lizenzen sehen,
 * eine Domain binden und die Kaufhistorie einsehen.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../db.js';
import { sendTemplateMail } from '../mailer/index.js';
import rateLimit from 'express-rate-limit';

const router = Router();
const PORTAL_SECRET = process.env.PORTAL_SECRET || '';

// ── Rate Limiter ──────────────────────────────────────────────────────────────
const portalLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { success: false, message: 'Zu viele Login-Versuche. Bitte 15 Minuten warten.' }
});

const inviteLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { success: false, message: 'Zu viele Anfragen. Bitte 1 Stunde warten.' }
});

// ── Auth Middleware ────────────────────────────────────────────────────────────
async function requirePortalAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer '))
        return res.status(401).json({ success: false, message: 'Nicht eingeloggt.' });
    const token = auth.slice(7);
    try {
        if (!PORTAL_SECRET) throw new Error('PORTAL_SECRET nicht konfiguriert.');
        const payload = jwt.verify(token, PORTAL_SECRET);
        if (payload.type !== 'portal') throw new Error('Ungültiger Token-Typ.');
        // Session in DB prüfen
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const [rows] = await db.query(
            `SELECT * FROM customer_sessions WHERE token_hash = ? AND revoked = 0 AND expires_at > NOW()`,
            [tokenHash]
        );
        if (!rows[0]) return res.status(401).json({ success: false, message: 'Session abgelaufen oder ungültig.' });
        // Kundendaten laden
        const [custs] = await db.query('SELECT * FROM customers WHERE id = ?', [payload.customer_id]);
        if (!custs[0]) return res.status(401).json({ success: false, message: 'Kunde nicht gefunden.' });
        req.customer = custs[0];
        req.sessionTokenHash = tokenHash;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, message: 'Token ungültig oder abgelaufen.' });
    }
}

// ── POST /login ───────────────────────────────────────────────────────────────
router.post('/login', portalLoginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ success: false, message: 'E-Mail und Passwort erforderlich.' });
    if (!PORTAL_SECRET)
        return res.status(500).json({ success: false, message: 'Portal nicht konfiguriert (PORTAL_SECRET fehlt).' });
    try {
        const [rows] = await db.query('SELECT * FROM customers WHERE email = ?', [email.toLowerCase().trim()]);
        const customer = rows[0];
        if (!customer || !customer.password_hash) {
            return res.status(401).json({ success: false, message: 'E-Mail oder Passwort falsch.' });
        }
        const valid = await bcrypt.compare(password, customer.password_hash);
        if (!valid)
            return res.status(401).json({ success: false, message: 'E-Mail oder Passwort falsch.' });

        // JWT erstellen (24h)
        const token = jwt.sign(
            { customer_id: customer.id, email: customer.email, type: 'portal' },
            PORTAL_SECRET,
            { expiresIn: '24h' }
        );
        // Session speichern
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        await db.query(
            `INSERT INTO customer_sessions (id, customer_id, token_hash, ip, user_agent, expires_at)
             VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
            [
                crypto.randomUUID(),
                customer.id,
                tokenHash,
                req.ip || null,
                (req.headers['user-agent'] || '').slice(0, 512)
            ]
        );
        res.json({
            success: true,
            token,
            customer: {
                id: customer.id,
                name: customer.name,
                email: customer.email,
                company: customer.company || null
            }
        });
    } catch (e) {
        console.error('[Portal/login]', e.message);
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
    }
});

// ── POST /logout ──────────────────────────────────────────────────────────────
router.post('/logout', requirePortalAuth, async (req, res) => {
    try {
        await db.query('UPDATE customer_sessions SET revoked = 1 WHERE token_hash = ?', [req.sessionTokenHash]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fehler beim Logout.' });
    }
});

// ── GET /me ───────────────────────────────────────────────────────────────────
router.get('/me', requirePortalAuth, async (req, res) => {
    const c = req.customer;
    res.json({
        success: true,
        customer: {
            id: c.id,
            name: c.name,
            email: c.email,
            company: c.company || null,
            phone: c.phone || null,
            payment_status: c.payment_status || 'unknown',
            created_at: c.created_at
        }
    });
});

// ── GET /licenses ─────────────────────────────────────────────────────────────
router.get('/licenses', requirePortalAuth, async (req, res) => {
    try {
        const [licenses] = await db.query(
            `SELECT license_key, type, status, associated_domain, expires_at,
                    usage_count, last_validated, max_devices, created_at
             FROM licenses
             WHERE customer_id = ?
             ORDER BY created_at DESC`,
            [req.customer.id]
        );
        res.json({ success: true, licenses });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fehler beim Laden der Lizenzen.' });
    }
});

// ── PATCH /licenses/:key/domain ───────────────────────────────────────────────
router.patch('/licenses/:key/domain', requirePortalAuth, async (req, res) => {
    const { domain } = req.body;
    if (!domain)
        return res.status(400).json({ success: false, message: 'Domain ist ein Pflichtfeld.' });

    // Domain-Validierung: nur gültige Hostnamen (kein Protokoll, kein Pfad)
    const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(clean))
        return res.status(400).json({ success: false, message: 'Ungültige Domain. Bitte nur Hostnamen eingeben (z.B. meinrestaurant.de).' });

    try {
        // Sicherstellen dass die Lizenz dem Kunden gehört
        const [rows] = await db.query(
            'SELECT license_key, associated_domain FROM licenses WHERE license_key = ? AND customer_id = ?',
            [req.params.key, req.customer.id]
        );
        if (!rows[0])
            return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });

        await db.query(
            'UPDATE licenses SET associated_domain = ? WHERE license_key = ? AND customer_id = ?',
            [clean, req.params.key, req.customer.id]
        );
        res.json({ success: true, domain: clean, message: `Domain erfolgreich auf ${clean} gesetzt.` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fehler beim Setzen der Domain.' });
    }
});

// ── GET /history ──────────────────────────────────────────────────────────────
router.get('/history', requirePortalAuth, async (req, res) => {
    try {
        const [history] = await db.query(
            `SELECT ph.id, ph.license_key, ph.plan, ph.action, ph.amount, ph.note, ph.created_at
             FROM purchase_history ph
             WHERE ph.customer_id = ?
             ORDER BY ph.created_at DESC
             LIMIT 200`,
            [req.customer.id]
        );
        res.json({ success: true, history });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Fehler beim Laden der Kaufhistorie.' });
    }
});

// ── POST /setup-password (Einmal-Token) ────────────────────────────────────────
// Wird aufgerufen wenn der Kunde den Link aus der Einladungsmail öffnet
router.post('/setup-password', inviteLimiter, async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password)
        return res.status(400).json({ success: false, message: 'Token und Passwort erforderlich.' });
    if (password.length < 10)
        return res.status(400).json({ success: false, message: 'Passwort muss mindestens 10 Zeichen haben.' });
    try {
        const [rows] = await db.query(
            `SELECT * FROM customers WHERE portal_token = ? AND portal_token_expires > NOW()`,
            [token]
        );
        if (!rows[0])
            return res.status(400).json({ success: false, message: 'Link ungültig oder abgelaufen. Bitte einen neuen Link anfordern.' });
        const hash = await bcrypt.hash(password, 12);
        await db.query(
            `UPDATE customers SET password_hash = ?, portal_token = NULL, portal_token_expires = NULL WHERE id = ?`,
            [hash, rows[0].id]
        );
        res.json({ success: true, message: 'Passwort erfolgreich gesetzt. Du kannst dich jetzt einloggen.' });
    } catch (e) {
        console.error('[Portal/setup-password]', e.message);
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
    }
});

// ── GET /verify-invite-token ──────────────────────────────────────────────────
// Prüft ob ein Einladungs-Token noch gültig ist (für das Frontend)
router.get('/verify-invite-token', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: 'Token fehlt.' });
    try {
        const [rows] = await db.query(
            `SELECT id, name, email FROM customers WHERE portal_token = ? AND portal_token_expires > NOW()`,
            [token]
        );
        if (!rows[0])
            return res.status(400).json({ success: false, message: 'Token ungültig oder abgelaufen.' });
        res.json({ success: true, name: rows[0].name, email: rows[0].email });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
    }
});

export default router;
