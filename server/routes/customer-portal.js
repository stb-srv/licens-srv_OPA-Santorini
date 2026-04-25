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
        // Fix #2: must_change_password — nur /change-password und /logout darf
        // mit abgelaufenem Passwort aufgerufen werden
        if (custs[0].must_change_password) {
            const allowedPaths = ['/change-password', '/logout'];
            const reqPath = req.path.replace(/\/$/, '') || '/';
            if (!allowedPaths.includes(reqPath)) {
                return res.status(403).json({
                    success: false,
                    must_change_password: true,
                    message: 'Bitte ändere zuerst dein Passwort, bevor du das Portal nutzen kannst.'
                });
            }
        }
        next();
    } catch (e) {
        return res.status(401).json({ success: false, message: 'Token ungültig oder abgelaufen.' });
    }
}

// ── POST /login ───────────────────────────────────────────────────────────────
router.post('/login', portalLoginLimiter, async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ success: false, message: 'Benutzername/E-Mail und Passwort erforderlich.' });
    if (!PORTAL_SECRET)
        return res.status(500).json({ success: false, message: 'Portal nicht konfiguriert (PORTAL_SECRET fehlt).' });
    try {
        // Login per E-Mail ODER Benutzername
        const login = email.toLowerCase().trim();
        const [rows] = await db.query(
            'SELECT * FROM customers WHERE email = ? OR portal_username = ?',
            [login, login]
        );
        const customer = rows[0];
        if (!customer || !customer.password_hash) {
            return res.status(401).json({ success: false, message: 'Benutzername/E-Mail oder Passwort falsch.' });
        }
        const valid = await bcrypt.compare(password, customer.password_hash);
        if (!valid)
            return res.status(401).json({ success: false, message: 'Benutzername/E-Mail oder Passwort falsch.' });

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
                id:       customer.id,
                name:     customer.name,
                email:    customer.email,
                username: customer.portal_username || null,
                company:  customer.company || null
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
            username: c.portal_username || null,
            company: c.company || null,
            phone: c.phone || null,
            payment_status: c.payment_status || 'unknown',
            must_change_password: c.must_change_password ? true : false,
            created_at: c.created_at
        }
    });
});

// ── PATCH /update-profile ─────────────────────────────────────────────────────
// Kunden können ihren eigenen Namen, Telefonnummer und Firma bearbeiten.
// E-Mail ist Admin-only und kann hier nicht geändert werden.
router.patch('/update-profile', requirePortalAuth, async (req, res) => {
    const { name, phone, company } = req.body;

    if (name !== undefined) {
        if (typeof name !== 'string' || name.trim().length < 2)
            return res.status(400).json({ success: false, message: 'Name muss mindestens 2 Zeichen lang sein.' });
    }

    const updates = [];
    const params  = [];

    if (name    !== undefined) { updates.push('name = ?');    params.push(name.trim()); }
    if (phone   !== undefined) { updates.push('phone = ?');   params.push(phone || null); }
    if (company !== undefined) { updates.push('company = ?'); params.push(company || null); }

    if (updates.length === 0)
        return res.status(400).json({ success: false, message: 'Keine änderbaren Felder angegeben. Erlaubt: name, phone, company.' });

    try {
        params.push(req.customer.id);
        await db.query(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`, params);

        const [rows] = await db.query(
            'SELECT id, name, email, phone, company, portal_username FROM customers WHERE id = ?',
            [req.customer.id]
        );
        const c = rows[0];
        res.json({
            success: true,
            message: 'Profil erfolgreich aktualisiert.',
            customer: {
                id:       c.id,
                name:     c.name,
                email:    c.email,
                username: c.portal_username || null,
                phone:    c.phone || null,
                company:  c.company || null
            }
        });
    } catch (e) {
        console.error('[Portal/update-profile]', e.message);
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
    }
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
    
    // Maximale Länge begrenzen (verhindert ReDoS durch lange Strings)
    if (clean.length > 253)
        return res.status(400).json({ success: false, message: 'Domain zu lang.' });

    // Jeden Label einzeln prüfen – kein verschachteltes Backtracking
    const labels = clean.replace(/^\*\./, '').split('.');
    const labelRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    const valid = labels.length >= 2 
        && labels.every(l => labelRegex.test(l))
        && /^[a-z]{2,}$/.test(labels[labels.length - 1]);

    if (!valid)
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

// ── POST /change-password (Fix #2) ────────────────────────────────────────────
// Kunden können ihr Passwort ändern (auch wenn must_change_password gesetzt ist)
router.post('/change-password', requirePortalAuth, async (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password)
        return res.status(400).json({ success: false, message: 'Aktuelles und neues Passwort erforderlich.' });
    if (new_password.length < 10)
        return res.status(400).json({ success: false, message: 'Neues Passwort muss mindestens 10 Zeichen haben.' });
    if (current_password === new_password)
        return res.status(400).json({ success: false, message: 'Neues Passwort muss sich vom aktuellen unterscheiden.' });
    try {
        const valid = await bcrypt.compare(current_password, req.customer.password_hash);
        if (!valid)
            return res.status(401).json({ success: false, message: 'Aktuelles Passwort ist falsch.' });
        const hash = await bcrypt.hash(new_password, 12);
        await db.query(
            'UPDATE customers SET password_hash = ?, must_change_password = 0 WHERE id = ?',
            [hash, req.customer.id]
        );
        res.json({ success: true, message: 'Passwort erfolgreich geändert.' });
    } catch (e) {
        console.error('[Portal/change-password]', e.message);
        res.status(500).json({ success: false, message: 'Interner Fehler.' });
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
            `UPDATE customers SET password_hash = ?, portal_token = NULL, portal_token_expires = NULL,
             must_change_password = 0 WHERE id = ?`,
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

// ── POST /forgot-password ──────────────────────────────────────────────
// Kunden können selbst einen Passwort-Reset anfordern (kein Admin-Eingriff nötig)
router.post('/forgot-password', inviteLimiter, async (req, res) => {
    const { email } = req.body;
    // Immer mit 200 antworten (kein E-Mail-Enumeration)
    const genericResponse = { success: true, message: 'Falls deine E-Mail registriert ist, hast du in Kürze eine E-Mail mit einem Reset-Link erhalten.' };
    if (!email) return res.json(genericResponse);
    try {
        const [rows] = await db.query(
            'SELECT id, name, email FROM customers WHERE email = ? AND (archived = 0 OR archived IS NULL)',
            [email.toLowerCase().trim()]
        );
        if (!rows[0]) return res.json(genericResponse); // Kein Leak ob E-Mail existiert

        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiresAt  = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 Stunden
        await db.query(
            'UPDATE customers SET portal_token = ?, portal_token_expires = ? WHERE id = ?',
            [resetToken, expiresAt, rows[0].id]
        );

        const portalUrl  = (process.env.PORTAL_URL || 'https://licens-prod.stb-srv.de').replace(/\/$/, '');
        const resetUrl   = `${portalUrl}/portal.html?reset=${resetToken}`;

        await sendTemplateMail('passwordReset', rows[0].email, {
            name:      rows[0].name,
            reset_url: resetUrl
        });
    } catch (e) {
        console.error('[Portal/forgot-password]', e.message);
        // Fehler nicht nach außen leaken
    }
    res.json(genericResponse);
});

export default router;
