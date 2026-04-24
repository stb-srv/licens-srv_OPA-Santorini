import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../db.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import { buildTransporter, sendTemplateMail, getActiveSmtpConfig } from '../mailer/index.js';
import { fireWebhook } from '../webhook.js';
import { generateKey, getClientIp, addAuditLog, parseJsonField } from '../helpers.js';
import {
  requireAuth, requireSuperAdmin, loginLimiter,
  MIN_PASSWORD_LENGTH, signAdminToken, asyncHandler, bulkLimiter,
  signTempToken
} from '../middleware.js';
import * as otplibPkg from 'otplib';
const { authenticator } = otplibPkg;
import QRCode from 'qrcode';

const router = Router();

const CUSTOMER_SAFE_FIELDS = 'id, name, email, phone, contact_person, company, payment_status, notes, archived, portal_username, must_change_password, created_at, updated_at';

function generateTempPassword() {
  const upper  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower  = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%&*';
  const all = upper + lower + digits + special;
  let pw = [
    upper [crypto.randomInt(upper.length)],
    digits[crypto.randomInt(digits.length)],
    special[crypto.randomInt(special.length)]
  ];
  for (let i = pw.length; i < 12; i++)
    pw.push(all[crypto.randomInt(all.length)]);
  for (let i = pw.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pw[i], pw[j]] = [pw[j], pw[i]];
  }
  return pw.join('');
}

// ── Auth ───────────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username and password required' });

  const [rows] = await db.query(
    'SELECT id, username, password_hash, role, two_factor_enabled, two_factor_secret FROM admins WHERE username = ?', [username]
  );
  const admin = rows[0];
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    await addAuditLog('admin_login_failed', { username, ip: getClientIp(req) });
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  // Check 2FA
  if (admin.two_factor_enabled) {
    const tempToken = signTempToken({ username: admin.username, id: admin.id });
    return res.json({ success: true, two_factor_required: true, temp_token: tempToken });
  }

  const token = signAdminToken({ username: admin.username, role: admin.role });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.query(
    `INSERT INTO admin_sessions (id, admin_username, token_hash, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 8 HOUR))`,
    [
      crypto.randomUUID(), admin.username, tokenHash,
      getClientIp(req), (req.headers['user-agent'] || '').slice(0, 512)
    ]
  );

  await addAuditLog('admin_login', { username, ip: getClientIp(req) }, username);
  res.json({ success: true, token, username: admin.username, role: admin.role });
}));

router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await db.query(
    'UPDATE admin_sessions SET revoked = 1 WHERE token_hash = ?',
    [req.adminTokenHash]
  );
  await addAuditLog('admin_logout', { username: req.admin.username, ip: getClientIp(req) }, req.admin.username);
  res.json({ success: true, message: 'Erfolgreich ausgeloggt.' });
}));

router.post('/login/2fa', loginLimiter, asyncHandler(async (req, res) => {
  const { code, temp_token } = req.body;
  if (!code || !temp_token)
    return res.status(400).json({ success: false, message: 'Code and temp_token required' });

  try {
    const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';
    const payload = (await import('jsonwebtoken')).default.verify(temp_token, ADMIN_SECRET);
    if (!payload.temp) throw new Error('Invalid token');

    const [rows] = await db.query('SELECT username, role, two_factor_secret FROM admins WHERE id = ?', [payload.id]);
    const admin = rows[0];
    if (!admin) return res.status(401).json({ success: false, message: 'Admin not found' });

    const isValid = authenticator.verify({ token: code, secret: admin.two_factor_secret });
    if (!isValid) return res.status(401).json({ success: false, message: 'Invalid 2FA code' });

    const token = signAdminToken({ username: admin.username, role: admin.role });
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.query(
      `INSERT INTO admin_sessions (id, admin_username, token_hash, ip, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 8 HOUR))`,
      [crypto.randomUUID(), admin.username, tokenHash, getClientIp(req), (req.headers['user-agent'] || '').slice(0, 512)]
    );

    res.json({ success: true, token, username: admin.username, role: admin.role });
  } catch (e) {
    res.status(401).json({ success: false, message: 'Invalid or expired temporary token' });
  }
}));

// ── 2FA Setup ────────────────────────────────────────────────────────────────
router.post('/2fa/setup', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await db.query('SELECT two_factor_enabled, two_factor_secret FROM admins WHERE username = ?', [req.admin.username]);
  const admin = rows[0];

  let secret = admin.two_factor_secret;
  if (!secret) {
    secret = authenticator.generateSecret();
    await db.query('UPDATE admins SET two_factor_secret = ? WHERE username = ?', [secret, req.admin.username]);
  }

  const otpauth = authenticator.keyuri(req.admin.username, 'OPA Santorini License', secret);
  const qrCodeUrl = await QRCode.toDataURL(otpauth);

  res.json({ success: true, secret, qr_code: qrCodeUrl, enabled: !!admin.two_factor_enabled });
}));

router.post('/2fa/verify', requireAuth, asyncHandler(async (req, res) => {
  const { code } = req.body;
  const [rows] = await db.query('SELECT two_factor_secret FROM admins WHERE username = ?', [req.admin.username]);
  const secret = rows[0]?.two_factor_secret;

  if (!secret) return res.status(400).json({ success: false, message: '2FA not set up' });

  const isValid = authenticator.verify({ token: code, secret });
  if (!isValid) return res.status(400).json({ success: false, message: 'Ungültiger Code' });

  await db.query('UPDATE admins SET two_factor_enabled = 1 WHERE username = ?', [req.admin.username]);
  await addAuditLog('2fa_enabled', { username: req.admin.username }, req.admin.username);

  res.json({ success: true, message: '2FA erfolgreich aktiviert' });
}));

router.post('/2fa/disable', requireAuth, asyncHandler(async (req, res) => {
  await db.query('UPDATE admins SET two_factor_enabled = 0, two_factor_secret = NULL WHERE username = ?', [req.admin.username]);
  await addAuditLog('2fa_disabled', { username: req.admin.username }, req.admin.username);
  res.json({ success: true, message: '2FA deaktiviert' });
}));

// ── Admin Users ──────────────────────────────────────────────────────────────
router.get('/users', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  const [rows] = await db.query('SELECT id, username, role, active, created_at, two_factor_enabled FROM admins');
  res.json({ users: rows });
}));

router.post('/users', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username and password required' });
  if (password.length < MIN_PASSWORD_LENGTH)
    return res.status(400).json({ success: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  const assignedRole = ['admin', 'superadmin'].includes(role) ? role : 'admin';
  try {
    const hash = await bcrypt.hash(password, 12);
    await db.query('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, assignedRole]);
    await addAuditLog('admin_user_created', { username, role: assignedRole, by: req.admin.username }, req.admin.username);
    res.json({ success: true, user: { username, role: assignedRole } });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, message: 'Username already exists' });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

router.delete('/users/:username', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  if (req.params.username === req.admin.username)
    return res.status(400).json({ success: false, message: 'Cannot delete your own account' });
  try {
    const [result] = await db.query('DELETE FROM admins WHERE username = ?', [req.params.username]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'User not found' });
    await addAuditLog('admin_user_deleted', { username: req.params.username, by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

router.patch('/users/:username', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  const { role, active } = req.body;
  const updates = [];
  const params = [];

  if (role !== undefined) {
    const assignedRole = ['admin', 'superadmin'].includes(role) ? role : 'admin';
    updates.push('role = ?');
    params.push(assignedRole);
  }
  if (active !== undefined) {
    updates.push('active = ?');
    params.push(active ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ success: false, message: 'No fields to update' });
  }

  params.push(req.params.username);
  await db.query(`UPDATE admins SET ${updates.join(', ')} WHERE username = ?`, params);
  await addAuditLog('admin_user_updated', { username: req.params.username, changes: Object.keys(req.body), by: req.admin.username }, req.admin.username);
  res.json({ success: true });
}));

router.patch('/users/:username/password', requireAuth, asyncHandler(async (req, res) => {
  const isSelf = req.params.username === req.admin.username;
  const isSuperAdmin = req.admin.role === 'superadmin';
  if (!isSelf && !isSuperAdmin)
    return res.status(403).json({ success: false, message: 'Forbidden' });
  const { password } = req.body;
  if (!password || password.length < MIN_PASSWORD_LENGTH)
    return res.status(400).json({ success: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  try {
    const hash = await bcrypt.hash(password, 12);
    await db.query('UPDATE admins SET password_hash = ? WHERE username = ?', [hash, req.params.username]);
    await addAuditLog('admin_password_changed', { username: req.params.username, by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

// ── Plans ────────────────────────────────────────────────────────────────────
router.get('/plans', requireAuth, (req, res) => res.json(PLAN_DEFINITIONS));

// ── Licenses ─────────────────────────────────────────────────────────────────
router.get('/licenses', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = (page - 1) * limit;
  const search = req.query.search
    ? `%${req.query.search.replace(/[%_\\]/g, '\\$&')}%`
    : null;

  const expiring = req.query.expiring === '1';
  const tag = req.query.tag;

  let where = '1=1';
  const params = [];
  if (search) {
    where += ' AND (license_key LIKE ? OR customer_name LIKE ?)';
    params.push(search, search);
  }
  if (expiring) {
    where += ' AND expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY) AND status = "active"';
  }
  if (tag) {
    where += ' AND JSON_CONTAINS(tags, JSON_QUOTE(?))';
    params.push(tag);
  }

  const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM licenses WHERE ${where}`, params);
  const [licenses] = await db.query(
    `SELECT * FROM licenses WHERE ${where} ORDER BY expires_at ASC, created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const [[statsRow]] = await db.query(`
    SELECT
      COUNT(*) as total_all,
      SUM(status = 'active' AND expires_at > NOW()) as active,
      SUM(status = 'active' AND expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 30 DAY)) as expiring,
      SUM(usage_count) as total_usage
    FROM licenses
  `);

  res.json({
    licenses,
    stats: {
      total: statsRow.total_all,
      active: statsRow.active || 0,
      expiring: statsRow.expiring || 0,
      total_usage: statsRow.total_usage || 0
    },
    pagination: { page, limit, total: parseInt(total), pages: Math.ceil(total / limit) }
  });
}));

router.get('/licenses/:key', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, license: rows[0] });
}));

router.post('/licenses', requireAuth, asyncHandler(async (req, res) => {
  const raw = req.body;
  const plan = PLAN_DEFINITIONS[raw.type] || PLAN_DEFINITIONS['FREE'];
  const key = raw.license_key?.trim() || generateKey(raw.type);
  const expiresAt = raw.expires_at ||
    new Date(Date.now() + plan.expires_days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const modules = plan.modules;
  const limits = { max_dishes: plan.menu_items, max_tables: plan.max_tables };

  try {
    await db.query(`
      INSERT INTO licenses
        (license_key, type, customer_id, customer_name, status, associated_domain,
         expires_at, allowed_modules, limits, max_devices, analytics_daily, analytics_features, validated_domains, tags)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, '{}', '{}', '[]', ?)
      ON DUPLICATE KEY UPDATE
        type=VALUES(type), customer_id=VALUES(customer_id), customer_name=VALUES(customer_name),
        associated_domain=VALUES(associated_domain), expires_at=VALUES(expires_at),
        allowed_modules=VALUES(allowed_modules), limits=VALUES(limits), max_devices=VALUES(max_devices)`,
      [key, raw.type || 'FREE', raw.customer_id || null, raw.customer_name || null,
       raw.associated_domain || '*', expiresAt, JSON.stringify(modules), JSON.stringify(limits),
       raw.max_devices ? parseInt(raw.max_devices) : 0, JSON.stringify(raw.tags || [])]
    );

    if (raw.customer_id) {
      await db.query(
        `INSERT IGNORE INTO purchase_history (id, customer_id, license_key, plan, action, amount, note, created_by)
         VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?)`,
        [crypto.randomUUID(), raw.customer_id, key, raw.type || 'FREE',
         raw.amount || null, raw.note || `Lizenz ${raw.type || 'FREE'} erstellt`, req.admin.username]
      );
      try {
        const [custRows] = await db.query('SELECT id, name, email FROM customers WHERE id = ?', [raw.customer_id]);
        const cust = custRows[0];
        if (cust?.email) {
          await sendTemplateMail('licenseCreated', cust.email, {
            customer_name: cust.name, license_key: key, type: raw.type || 'FREE',
            expires_at: expiresAt, associated_domain: raw.associated_domain || '*'
          });
        }
      } catch (mailErr) {
        console.error('[licenses] Lizenz-Mail fehlgeschlagen:', mailErr.message);
      }
    }

    await addAuditLog('license_created',
      { license_key: key, type: raw.type, customer_name: raw.customer_name, by: req.admin.username },
      req.admin.username);
    const [newRows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [key]);
    res.json({ success: true, license: newRows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

router.patch('/licenses/:key/status', requireAuth, asyncHandler(async (req, res) => {
  const VALID_STATUSES = ['active', 'revoked', 'cancelled', 'expired', 'suspended'];
  if (!req.body.status || !VALID_STATUSES.includes(req.body.status))
    return res.status(400).json({ success: false, message: `Ungültiger Status. Erlaubt: ${VALID_STATUSES.join(', ')}` });

  const [rows] = await db.query(
    'SELECT l.*, c.email AS customer_email, c.name AS customer_real_name FROM licenses l LEFT JOIN customers c ON l.customer_id = c.id WHERE l.license_key = ?',
    [req.params.key]
  );
  if (!rows[0]) return res.status(404).json({ success: false });
  const l = rows[0];
  await db.query('UPDATE licenses SET status = ? WHERE license_key = ?', [req.body.status, req.params.key]);
  await addAuditLog('license_status_changed',
    { license_key: req.params.key, from: l.status, to: req.body.status, by: req.admin.username },
    req.admin.username);
  await fireWebhook('license.status_changed', { license_key: req.params.key, from: l.status, to: req.body.status });

  if (['revoked', 'suspended'].includes(req.body.status) && l.customer_email) {
    try {
      await sendTemplateMail('licenseRevoked', l.customer_email, {
        customer_name: l.customer_name || l.customer_real_name || 'Kunde',
        license_key: req.params.key, status: req.body.status, reason: req.body.reason || null
      });
    } catch (mailErr) {
      console.error('[licenses] Sperr-Mail fehlgeschlagen:', mailErr.message);
    }
  }
  res.json({ success: true });
}));

router.patch('/licenses/:key', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden' });

  const { type, associated_domain, expires_at, max_devices, customer_name, customer_id, allowed_modules, limits } = req.body;
  const updates = [], params = [];

  if (type !== undefined)              { updates.push('type = ?');               params.push(type); }
  if (associated_domain !== undefined) { updates.push('associated_domain = ?');  params.push(associated_domain); }
  if (expires_at !== undefined)        { updates.push('expires_at = ?');         params.push(expires_at); }
  if (max_devices !== undefined)       { updates.push('max_devices = ?');        params.push(parseInt(max_devices) || 0); }
  if (customer_name !== undefined)     { updates.push('customer_name = ?');      params.push(customer_name); }
  if (customer_id !== undefined)       { updates.push('customer_id = ?');        params.push(customer_id || null); }
  if (allowed_modules !== undefined)   { updates.push('allowed_modules = ?');    params.push(JSON.stringify(allowed_modules)); }
  if (limits !== undefined)            { updates.push('limits = ?');             params.push(JSON.stringify(limits)); }
  if (tags !== undefined)              { updates.push('tags = ?');               params.push(JSON.stringify(tags || [])); }

  if (updates.length === 0)
    return res.status(400).json({ success: false, message: 'Keine änderbaren Felder angegeben.' });

  params.push(req.params.key);
  await db.query(`UPDATE licenses SET ${updates.join(', ')} WHERE license_key = ?`, params);
  await addAuditLog('license_updated',
    { license_key: req.params.key, changes: Object.keys(req.body), by: req.admin.username },
    req.admin.username);
  const [updated] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
  res.json({ success: true, license: updated[0] });
}));

router.post('/licenses/:key/renew', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await db.query(
    'SELECT l.*, c.email AS customer_email FROM licenses l LEFT JOIN customers c ON l.customer_id = c.id WHERE l.license_key = ?',
    [req.params.key]
  );
  const l = rows[0];
  if (!l) return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden' });
  const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
  const days = req.body.days || plan.expires_days;
  const baseDate = new Date(l.expires_at) > new Date() ? new Date(l.expires_at) : new Date();
  const newExpiryStr = new Date(baseDate.getTime() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');

  await db.query(
    "UPDATE licenses SET expires_at = ?, status = 'active', expiry_notified_at = NULL WHERE license_key = ?",
    [newExpiryStr, req.params.key]
  );

  if (l.customer_id) {
    await db.query(
      `INSERT INTO purchase_history (id, customer_id, license_key, plan, action, amount, note, created_by)
       VALUES (?, ?, ?, ?, 'renewal', ?, ?, ?)`,
      [crypto.randomUUID(), l.customer_id, req.params.key, l.type,
       req.body.amount || null,
       `Verlängerung um ${days} Tage – neues Ablaufdatum: ${newExpiryStr}`,
       req.admin.username]
    );
  }

  await addAuditLog('license_renewed',
    { license_key: req.params.key, days, new_expiry: newExpiryStr, by: req.admin.username },
    req.admin.username);
  await fireWebhook('license.renewed', { license_key: req.params.key, new_expiry: newExpiryStr });

  if (l.customer_email) {
    try {
      await sendTemplateMail('licenseRenewed', l.customer_email, {
        customer_name: l.customer_name || 'Kunde', license_key: req.params.key,
        type: l.type, new_expires_at: newExpiryStr, days
      });
    } catch (mailErr) {
      console.error('[licenses] Verlängerungs-Mail fehlgeschlagen:', mailErr.message);
    }
  }

  res.json({ success: true, new_expires_at: newExpiryStr, days_extended: days });
}));

router.delete('/licenses/:key', requireAuth, asyncHandler(async (req, res) => {
  try {
    await db.query('DELETE FROM licenses WHERE license_key = ?', [req.params.key]);
    await addAuditLog('license_deleted', { license_key: req.params.key, by: req.admin.username }, req.admin.username);
    await fireWebhook('license.deleted', { license_key: req.params.key });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

// ── Lizenz upgraden ────────────────────────────────────────────────────────────
router.post('/licenses/:key/upgrade', requireAuth, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { new_type, extend_days } = req.body;

    const validTypes = ['FREE', 'STARTER', 'PRO', 'PRO_PLUS', 'ENTERPRISE'];
    if (!new_type || !validTypes.includes(new_type)) {
        return res.status(400).json({ success: false, message: `Ungültiger Plan. Erlaubt: ${validTypes.join(', ')}` });
    }

    const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [key]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });

    const plan = PLAN_DEFINITIONS[new_type];
    const days = extend_days || plan.expires_days;
    const newExpiry = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    await db.query(
        `UPDATE licenses SET type = ?, status = 'active', expires_at = ?,
         expiry_notified_at = NULL WHERE license_key = ?`,
        [new_type, newExpiry, key]
    );

    await addAuditLog('license_upgraded', {
        license_key: key,
        old_type: rows[0].type,
        new_type,
        new_expiry: newExpiry,
        actor: req.admin?.username || 'admin'
    });

    await fireWebhook('license.upgraded', {
        license_key: key,
        old_type: rows[0].type,
        new_type,
        expires_at: newExpiry
    });

    return res.json({
        success: true,
        message: `Lizenz auf ${new_type} upgraded. Läuft ab: ${newExpiry.toISOString()}`,
        license_key: key,
        new_type,
        expires_at: newExpiry
    });
}));

// ── Lizenz verlängern ──────────────────────────────────────────────────────────
router.post('/licenses/:key/extend', requireAuth, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { days } = req.body;
    if (!days || isNaN(days) || days < 1) {
        return res.status(400).json({ success: false, message: 'days muss eine positive Zahl sein.' });
    }

    const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [key]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });

    const base = new Date(rows[0].expires_at) > new Date()
        ? new Date(rows[0].expires_at)
        : new Date();
    const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

    await db.query(
        `UPDATE licenses SET expires_at = ?, status = 'active', expiry_notified_at = NULL
         WHERE license_key = ?`,
        [newExpiry, key]
    );

    await addAuditLog('license_extended', {
        license_key: key,
        extended_by_days: days,
        new_expiry: newExpiry,
        actor: req.admin?.username || 'admin'
    });

    return res.json({
        success: true,
        message: `Lizenz um ${days} Tage verlängert.`,
        license_key: key,
        expires_at: newExpiry
    });
}));

// ── Lizenz-Domain-Transfer ─────────────────────────────────────────────────────
router.post('/licenses/:key/transfer', requireAuth, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { new_domain } = req.body;
    if (!new_domain) return res.status(400).json({ success: false, message: 'new_domain fehlt.' });

    const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [key]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });

    const old_domain = rows[0].associated_domain;

    await db.query(
        'UPDATE licenses SET associated_domain = ? WHERE license_key = ?',
        [new_domain, key]
    );

    await addAuditLog('license_transferred', {
        license_key: key,
        old_domain,
        new_domain,
        actor: req.admin?.username || 'admin'
    });

    await fireWebhook('license.transferred', { license_key: key, old_domain, new_domain });

    return res.json({
        success: true,
        message: `Lizenz von ${old_domain} → ${new_domain} transferiert.`,
        license_key: key,
        new_domain
    });
}));

// ── Inaktive Instanzen (kein Heartbeat > 14 Tage) ─────────────────────────────
router.get('/licenses/inactive', requireAuth, asyncHandler(async (req, res) => {
    const [rows] = await db.query(`
        SELECT l.license_key, l.customer_name, l.type, l.associated_domain AS domain, l.status,
               h.ts AS last_heartbeat,
               DATEDIFF(NOW(), COALESCE(h.ts, l.created_at)) AS days_inactive
        FROM licenses l
        LEFT JOIN license_heartbeats h ON h.license_key = l.license_key
        WHERE l.status = 'active'
          AND (h.ts IS NULL OR h.ts < DATE_SUB(NOW(), INTERVAL 14 DAY))
        ORDER BY days_inactive DESC
        LIMIT 50
    `);
    return res.json({ success: true, inactive: rows });
}));

router.patch('/licenses/:key/customer', requireAuth, asyncHandler(async (req, res) => {
  try {
    await db.query('UPDATE licenses SET customer_id = ? WHERE license_key = ?',
      [req.body.customer_id || null, req.params.key]);
    await addAuditLog('license_customer_linked',
      { license_key: req.params.key, customer_id: req.body.customer_id, by: req.admin.username },
      req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

// ── Customers ─────────────────────────────────────────────────────────────────
function normalizeSlug(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/gi, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function buildPortalUsername(name, company = null) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  let slug;
  if (parts.length >= 2) {
    slug = `${normalizeSlug(parts[0])}.${normalizeSlug(parts[parts.length - 1])}`;
  } else if (parts.length === 1) {
    slug = normalizeSlug(parts[0]);
  } else {
    slug = 'kunde';
  }
  if (company) {
    const firmSlug = normalizeSlug(company)
      .replace(/gmbhcokg|gmbhco|gmbh|gbr|ohg|ug|ag|kg|ev|inc|ltd/g, '')
      .replace(/^\d+/, '')
      .slice(0, 12);
    if (firmSlug) slug = `${slug}.${firmSlug}`;
  }
  return slug || 'kunde';
}

async function uniquePortalUsername(name, company = null) {
  const base = buildPortalUsername(name, company);
  try {
    for (let i = 0; i < 100; i++) {
      const attempt = i === 0 ? base : `${base}${i}`;
      const [[{ n }]] = await db.query(
        'SELECT COUNT(*) AS n FROM customers WHERE portal_username = ?', [attempt]
      );
      if (n === 0) return attempt;
    }
    return `${base}${Date.now()}`;
  } catch {
    return base;
  }
}

router.get('/customers', requireAuth, asyncHandler(async (req, res) => {
  const includeArchived = req.query.include_archived === '1';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search.replace(/[%_\\]/g, '\\$&')}%` : null;

  let where = includeArchived ? '1=1' : '(archived = 0 OR archived IS NULL)';
  const params = [];
  if (search) {
    where += ' AND (name LIKE ? OR email LIKE ? OR company LIKE ? OR portal_username LIKE ?)';
    params.push(search, search, search, search);
  }

  const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM customers WHERE ${where}`, params);
  const [rows] = await db.query(
    `SELECT ${CUSTOMER_SAFE_FIELDS} FROM customers WHERE ${where} ORDER BY archived ASC, created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  res.json({
    customers: rows,
    pagination: { page, limit, total: parseInt(total), pages: Math.ceil(total / limit) }
  });
}));

router.post('/customers', requireAuth, asyncHandler(async (req, res) => {
  const { name, email, phone, contact_person, company, payment_status, notes } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Name required' });
  if (!email) return res.status(400).json({ success: false, message: 'E-Mail ist ein Pflichtfeld' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ success: false, message: 'Ungültige E-Mail-Adresse' });

  const id = crypto.randomUUID();
  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  const portalUsername = await uniquePortalUsername(name, company || null);

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO customers
         (id, name, email, phone, contact_person, company, payment_status, notes,
          password_hash, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, name, email, phone || null, contact_person || null,
       company || null, payment_status || 'unknown', notes || '', passwordHash]
    );
    try {
      await conn.query('UPDATE customers SET portal_username = ? WHERE id = ?', [portalUsername, id]);
    } catch (colErr) {
      console.warn('[customers] portal_username konnte nicht gesetzt werden:', colErr.message);
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    console.error('[customers/create]', e);
    return res.status(500).json({ success: false, message: `Fehler beim Anlegen: ${e.message}` });
  } finally {
    conn.release();
  }

  await addAuditLog('customer_created',
    { customer_id: id, name, email, portal_username: portalUsername, by: req.admin.username },
    req.admin.username);

  const portalUrl = (process.env.PORTAL_URL || 'https://licens-prod.stb-srv.de').replace(/\/$/, '');
  try {
    await sendTemplateMail('accountCreated', email, {
      name, email, username: portalUsername, password: tempPassword,
      login_url: `${portalUrl}/portal.html`
    });
  } catch (mailErr) {
    console.error('[customers] Willkommens-Mail fehlgeschlagen:', mailErr.message);
  }

  const [[customer]] = await db.query(`SELECT ${CUSTOMER_SAFE_FIELDS} FROM customers WHERE id = ?`, [id]);
  res.json({ success: true, customer });
}));

router.patch('/customers/:id', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await db.query(`SELECT ${CUSTOMER_SAFE_FIELDS} FROM customers WHERE id = ?`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Customer not found' });
  const { name, email, phone, contact_person, company, payment_status, notes, archived } = req.body;
  if (email !== undefined) {
    if (!email) return res.status(400).json({ success: false, message: 'E-Mail ist ein Pflichtfeld' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success: false, message: 'Ungültige E-Mail-Adresse' });
  }
  const archivedVal = archived !== undefined ? (archived ? 1 : 0) : null;
  await db.query(
    `UPDATE customers SET
      name=COALESCE(?,name), email=COALESCE(?,email), phone=?, contact_person=?,
      company=COALESCE(?,company), payment_status=COALESCE(?,payment_status), notes=COALESCE(?,notes),
      archived=COALESCE(?,archived)
     WHERE id=?`,
    [name || null, email || null,
     phone !== undefined ? phone : rows[0].phone,
     contact_person !== undefined ? contact_person : rows[0].contact_person,
     company || null, payment_status || null,
     notes !== undefined ? notes : rows[0].notes,
     archivedVal, req.params.id]
  );
  if (archived !== undefined) {
    await addAuditLog(
      archived ? 'customer_archived' : 'customer_unarchived',
      { customer_id: req.params.id, name: rows[0].name, by: req.admin.username },
      req.admin.username
    );
  } else {
    await addAuditLog('customer_updated', { customer_id: req.params.id, by: req.admin.username }, req.admin.username);
  }
  const [[updated]] = await db.query(`SELECT ${CUSTOMER_SAFE_FIELDS} FROM customers WHERE id = ?`, [req.params.id]);
  res.json({ success: true, customer: updated });
}));

router.delete('/customers/:id', requireAuth, asyncHandler(async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('UPDATE licenses SET customer_id = NULL WHERE customer_id = ?', [req.params.id]);
    await conn.query('DELETE FROM customers WHERE id = ?', [req.params.id]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  await addAuditLog('customer_deleted', { customer_id: req.params.id, by: req.admin.username }, req.admin.username);
  res.json({ success: true });
}));

router.post('/customers/:id/send-portal-invite', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, name, email FROM customers WHERE id = ?', [req.params.id]);
    const customer = rows[0];
    if (!customer) return res.status(404).json({ success: false, message: 'Kunde nicht gefunden.' });
    if (!customer.email) return res.status(400).json({ success: false, message: 'Kunde hat keine E-Mail-Adresse.' });

    const token = crypto.randomBytes(40).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await db.query('UPDATE customers SET portal_token = ?, portal_token_expires = ? WHERE id = ?',
      [token, expires, customer.id]);

    const baseUrl = (process.env.PORTAL_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
    await sendTemplateMail('portalInvite', customer.email, {
      name: customer.name, email: customer.email,
      invite_url: `${baseUrl}/portal.html?token=${token}`
    });
    await addAuditLog('portal_invite_sent',
      { customer_id: customer.id, email: customer.email, by: req.admin.username }, req.admin.username);
    res.json({ success: true, message: `Einladungsmail an ${customer.email} gesendet.` });
  } catch (e) {
    console.error('[portal-invite]', e.message);
    res.status(500).json({ success: false, message: `Fehler: ${e.message}` });
  }
}));

// ── Purchase History ──────────────────────────────────────────────────────────
router.get('/purchase-history', requireAuth, asyncHandler(async (req, res) => {
  try {
    const { customer_id, license_key } = req.query;
    let query = `SELECT ph.*, c.name as customer_name, c.email as customer_email
      FROM purchase_history ph LEFT JOIN customers c ON ph.customer_id = c.id WHERE 1=1`;
    const params = [];
    if (customer_id) { query += ' AND ph.customer_id = ?'; params.push(customer_id); }
    if (license_key) { query += ' AND ph.license_key = ?'; params.push(license_key); }
    query += ' ORDER BY ph.created_at DESC LIMIT 500';
    const [rows] = await db.query(query, params);
    res.json({ success: true, history: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

router.post('/purchase-history', requireAuth, asyncHandler(async (req, res) => {
  const { customer_id, license_key, plan, action, amount, note } = req.body;
  if (!customer_id || !license_key || !plan)
    return res.status(400).json({ success: false, message: 'customer_id, license_key und plan sind Pflichtfelder' });
  const validActions = ['purchase', 'renewal', 'upgrade', 'downgrade', 'cancellation'];
  if (action && !validActions.includes(action))
    return res.status(400).json({ success: false, message: `Ungültige Aktion. Erlaubt: ${validActions.join(', ')}` });
  try {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO purchase_history (id, customer_id, license_key, plan, action, amount, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, customer_id, license_key, plan, action || 'purchase', amount || null, note || null, req.admin.username]
    );
    await addAuditLog('purchase_history_added',
      { customer_id, license_key, action: action || 'purchase', by: req.admin.username }, req.admin.username);
    const [rows] = await db.query('SELECT * FROM purchase_history WHERE id = ?', [id]);
    res.json({ success: true, entry: rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

router.delete('/purchase-history/:id', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    await db.query('DELETE FROM purchase_history WHERE id = ?', [req.params.id]);
    await addAuditLog('purchase_history_deleted', { id: req.params.id, by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

// ── Login-Log ─────────────────────────────────────────────────────────────────
router.get('/login-log', requireAuth, asyncHandler(async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    // Unterstützt sowohl 'ts' (alte Tabelle) als auch 'created_at' (neue Tabelle)
    const [cols] = await db.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME IN ('ts','created_at')`
    );
    const tsCol = cols.find(c => c.COLUMN_NAME === 'ts') ? 'ts' : 'created_at';
    const [rows] = await db.query(
      `SELECT * FROM audit_log WHERE action IN ('admin_login','admin_login_failed') ORDER BY ${tsCol} DESC LIMIT ?`,
      [limit]
    );
    res.json({ success: true, logs: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

// ── Devices ──────────────────────────────────────────────────────────────────
router.get('/devices', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = (page - 1) * limit;
  const { license_key, search } = req.query;

  let where = '1=1';
  const params = [];
  if (license_key) {
    where += ' AND license_key = ?';
    params.push(license_key);
  }
  if (search) {
    const s = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
    where += ' AND (device_id LIKE ? OR ip LIKE ? OR device_type LIKE ? OR license_key LIKE ?)';
    params.push(s, s, s, s);
  }

  const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM devices WHERE ${where}`, params);
  const [devices] = await db.query(
    `SELECT * FROM devices WHERE ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  res.json({
    devices,
    pagination: { page, limit, total: parseInt(total), pages: Math.ceil(total / limit) }
  });
}));

router.patch('/devices/:id/deactivate', requireAuth, asyncHandler(async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false });
    // deactivated_at nur setzen wenn Spalte existiert
    try {
      await db.query('UPDATE devices SET active = 0, deactivated_at = NOW() WHERE id = ?', [req.params.id]);
    } catch {
      await db.query('UPDATE devices SET active = 0 WHERE id = ?', [req.params.id]);
    }
    await addAuditLog('device_deactivated',
      { device_id: rows[0].device_id, license_key: rows[0].license_key, by: req.admin.username },
      req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

router.delete('/devices/:id', requireAuth, asyncHandler(async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false });
    await db.query('DELETE FROM devices WHERE id = ?', [req.params.id]);
    await addAuditLog('device_removed',
      { device_id: rows[0].device_id, license_key: rows[0].license_key, by: req.admin.username },
      req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

// ── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics', requireAuth, asyncHandler(async (req, res) => {
  // 1. Top Licenses by usage
  const [topLics] = await db.query(
    'SELECT license_key, customer_name, type, usage_count, last_validated FROM licenses ORDER BY usage_count DESC LIMIT 10'
  );

  // 2. Status Distribution
  const [statusStats] = await db.query('SELECT status, COUNT(*) as count FROM licenses GROUP BY status');
  
  // 3. Type Distribution
  const [typeStats] = await db.query('SELECT type, COUNT(*) as count FROM licenses GROUP BY type');

  // 4. Growth Metrics (last 30 days)
  const [[{ count_30d }]] = await db.query('SELECT COUNT(*) as count_30d FROM licenses WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
  const [[{ count_7d }]] = await db.query('SELECT COUNT(*) as count_7d FROM licenses WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)');

  // 5. Aggregate Daily validations & Feature usage
  const [allLics] = await db.query('SELECT analytics_daily, analytics_features FROM licenses');
  const daily = {}, features = {};
  for (const l of allLics) {
    const d = parseJsonField(l.analytics_daily, {});
    for (const [day, count] of Object.entries(d)) daily[day] = (daily[day] || 0) + count;
    const f = parseJsonField(l.analytics_features, {});
    for (const [feat, count] of Object.entries(f)) features[feat] = (features[feat] || 0) + count;
  }

  // 6. Device Metrics
  const [[{ total_devices }]] = await db.query('SELECT COUNT(*) as total_devices FROM devices');
  const [[{ active_devices }]] = await db.query('SELECT COUNT(*) as active_devices FROM devices WHERE active = 1');

  // 7. Revenue Metrics
  const [[{ revenue_total }]] = await db.query('SELECT SUM(amount) as revenue_total FROM purchase_history');
  const [[{ revenue_month }]] = await db.query(
    'SELECT SUM(amount) as revenue_month FROM purchase_history WHERE created_at >= DATE_FORMAT(NOW(), "%Y-%m-01")'
  );
  const [[{ revenue_30d }]] = await db.query(
    'SELECT SUM(amount) as revenue_30d FROM purchase_history WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'
  );

  // 8. Top Customers (by license count)
  const [topCustomers] = await db.query(
    `SELECT c.name, COUNT(l.license_key) as lic_count 
     FROM customers c JOIN licenses l ON c.id = l.customer_id 
     GROUP BY c.id, c.name ORDER BY lic_count DESC LIMIT 10`
  );

  // Format Daily Stats for Chart (last 30 days)
  const validations_per_day = Object.entries(daily)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-30);

  res.json({
    success: true,
    top_licenses: topLics,
    validations_per_day,
    status_distribution: statusStats,
    type_distribution: typeStats,
    feature_usage: features,
    growth: { last_7d: count_7d, last_30d: count_30d },
    devices: { total: total_devices, active: active_devices },
    revenue: { total: revenue_total || 0, month: revenue_month || 0, last_30d: revenue_30d || 0 },
    top_customers: topCustomers
  });
}));

// ── Audit Log ────────────────────────────────────────────────────────────────
router.get('/audit-log', requireAuth, asyncHandler(async (req, res) => {
  const rawLimit = parseInt(req.query.limit) || 100;
  const limit = Math.min(1000, Math.max(1, rawLimit));
  const { action, license_key } = req.query;

  // Unterstützt sowohl 'ts' als auch 'created_at'
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME IN ('ts','created_at')`
  );
  const tsCol = cols.find(c => c.COLUMN_NAME === 'ts') ? 'ts' : 'created_at';
  const dataCol = (await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_log' AND COLUMN_NAME IN ('details','data')`
  ))[0].find(c => c.COLUMN_NAME === 'details') ? 'details' : 'data';

  let query = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];
  if (action) { query += ' AND action = ?'; params.push(action); }
  if (license_key) {
    query += ` AND JSON_EXTRACT(\`${dataCol}\`, '$.license_key') = ?`;
    params.push(license_key);
  }
  query += ` ORDER BY ${tsCol} DESC LIMIT ?`;
  params.push(limit);
  const [logs] = await db.query(query, params);
  res.json({ logs });
}));

// ── SMTP ─────────────────────────────────────────────────────────────────────
router.get('/smtp', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    const [rows] = await db.query('SELECT host, port, secure, smtp_user, smtp_from FROM smtp_config WHERE id = 1');
    const cfg = rows[0] || {};
    res.json({
      success: true,
      smtp: {
        host: cfg.host || '', port: cfg.port || '587', secure: cfg.secure || 'false',
        user: cfg.smtp_user || '', from: cfg.smtp_from || '',
        configured: !!(cfg.host && cfg.smtp_user)
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

router.post('/smtp', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  const { host, port, secure, user, pass, from, test_to } = req.body;
  if (!host || !user || !pass)
    return res.status(400).json({ success: false, message: 'Host, Benutzer und Passwort sind Pflichtfelder' });
  try {
    const transporter = buildTransporter({ host, port: port || '587', secure: secure || 'false', user, pass });
    await transporter.verify();
    await db.query(
      `INSERT INTO smtp_config (id, host, port, secure, smtp_user, smtp_pass, smtp_from)
       VALUES (1,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         host=VALUES(host),port=VALUES(port),secure=VALUES(secure),
         smtp_user=VALUES(smtp_user),smtp_pass=VALUES(smtp_pass),smtp_from=VALUES(smtp_from)`,
      [host, port || '587', secure || 'false', user, pass, from || user]
    );
    await addAuditLog('smtp_config_updated', { host, user, by: req.admin.username }, req.admin.username);
    if (test_to) {
      const { subject, html, text } = (await import('../mailer/templates.js')).renderTemplate('test', { host });
      await transporter.sendMail({ from: from || user, to: test_to, subject, html, text });
      return res.json({ success: true, message: `SMTP gespeichert und Test-Mail an ${test_to} gesendet.` });
    }
    res.json({ success: true, message: 'SMTP-Konfiguration gespeichert und Verbindung erfolgreich verifiziert.' });
  } catch (e) {
    console.error('[SMTP save]', e);
    res.status(400).json({ success: false, message: `SMTP-Fehler: ${e.message}` });
  }
}));

router.post('/smtp/test', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ success: false, message: 'Empfänger-E-Mail fehlt' });
  try {
    const cfg = await getActiveSmtpConfig();
    if (!cfg) return res.status(500).json({ success: false, message: 'SMTP nicht konfiguriert.' });
    const info = await sendTemplateMail('test', to, { host: cfg.host });
    res.json({ success: true, message: `Test-E-Mail an ${to} gesendet. MessageId: ${info.messageId}` });
  } catch (e) {
    res.status(500).json({ success: false, message: `Fehler beim Senden: ${e.message}` });
  }
}));

router.delete('/smtp', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    await db.query('DELETE FROM smtp_config WHERE id = 1');
    await addAuditLog('smtp_config_deleted', { by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

// ── Webhooks ─────────────────────────────────────────────────────────────────
router.get('/webhooks', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  const [rows] = await db.query('SELECT id, url, events, active, created_at FROM webhooks');
  res.json({ webhooks: rows });
}));

router.post('/webhooks', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  const { url, secret, events } = req.body;
  if (!url) return res.status(400).json({ success: false, message: 'URL erforderlich' });
  try {
    const [result] = await db.query(
      'INSERT INTO webhooks (url, secret, events) VALUES (?, ?, ?)',
      [url, secret || null, JSON.stringify(events || ['*'])]
    );
    await addAuditLog('webhook_created', { url, by: req.admin.username }, req.admin.username);
    res.json({ success: true, id: result.insertId });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

router.delete('/webhooks/:id', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  try {
    await db.query('DELETE FROM webhooks WHERE id = ?', [req.params.id]);
    await addAuditLog('webhook_deleted', { webhook_id: req.params.id, by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

// ── Impersonate ───────────────────────────────────────────────────────────────
router.post('/impersonate', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  const { license_key } = req.body;
  if (!license_key) return res.status(400).json({ success: false });
  const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
  const l = rows[0];
  if (!l) return res.status(404).json({ success: false });
  const [[customer]] = l.customer_id
    ? await db.query(`SELECT ${CUSTOMER_SAFE_FIELDS} FROM customers WHERE id = ?`, [l.customer_id])
    : [[undefined]];
  const [devices] = await db.query('SELECT * FROM devices WHERE license_key = ?', [license_key]);
  await addAuditLog('impersonate', { license_key, by: req.admin.username }, req.admin.username);
  res.json({ success: true, license: l, customer: customer || null, devices });
}));

// ── Sessions ─────────────────────────────────────────────────────────────────
router.get('/sessions', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
  const [adminSessions] = await db.query(
    `SELECT id, admin_username AS username, 'admin' AS type, ip, created_at, expires_at
     FROM admin_sessions WHERE revoked = 0 AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 200`
  );
  let customerSessions = [];
  try {
    const [cs] = await db.query(
      `SELECT s.id, c.email AS username, 'customer' AS type, s.ip, s.created_at, s.expires_at
       FROM customer_sessions s LEFT JOIN customers c ON s.customer_id = c.id
       WHERE s.revoked = 0 AND s.expires_at > NOW()
       ORDER BY s.created_at DESC LIMIT 200`
    );
    customerSessions = cs;
  } catch { /* customer_sessions noch nicht migriert */ }
  res.json({
    success: true,
    total: adminSessions.length + customerSessions.length,
    admin_sessions: adminSessions,
    customer_sessions: customerSessions
  });
}));

// ── Bulk ─────────────────────────────────────────────────────────────────────
router.post('/licenses/bulk', requireAuth, bulkLimiter, asyncHandler(async (req, res) => {
  const { action, keys, days, customer_id, reason, confirm } = req.body;
  const ALLOWED_ACTIONS = ['renew', 'revoke', 'suspend', 'assign_customer', 'activate'];
  if (!action || !ALLOWED_ACTIONS.includes(action))
    return res.status(400).json({ success: false, message: `Ungültige Aktion. Erlaubt: ${ALLOWED_ACTIONS.join(', ')}` });
  if (!Array.isArray(keys) || keys.length === 0)
    return res.status(400).json({ success: false, message: 'keys[] muss eine nicht-leere Liste sein.' });
  if (keys.length > 100)
    return res.status(400).json({ success: false, message: 'Maximal 100 Lizenzen pro Bulk-Operation.' });
  if (confirm !== true)
    return res.status(400).json({ success: false, message: 'Sicherheitscheck: { "confirm": true } muss im Body enthalten sein.' });

  const results = { ok: [], failed: [] };
  for (const key of keys) {
    try {
      const [rows] = await db.query(
        'SELECT l.*, c.email AS customer_email FROM licenses l LEFT JOIN customers c ON l.customer_id = c.id WHERE l.license_key = ?', [key]
      );
      const l = rows[0];
      if (!l) { results.failed.push({ key, reason: 'not_found' }); continue; }

      if (action === 'renew') {
        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const d = days || plan.expires_days;
        const base = new Date(l.expires_at) > new Date() ? new Date(l.expires_at) : new Date();
        const newExpiry = new Date(base.getTime() + d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        await db.query("UPDATE licenses SET expires_at = ?, status = 'active', expiry_notified_at = NULL WHERE license_key = ?", [newExpiry, key]);
        await addAuditLog('license_renewed', { license_key: key, days: d, bulk: true, by: req.admin.username }, req.admin.username);
      } else if (action === 'revoke' || action === 'suspend') {
        await db.query('UPDATE licenses SET status = ? WHERE license_key = ?', [action === 'revoke' ? 'revoked' : 'suspended', key]);
        await addAuditLog('license_status_changed', { license_key: key, to: action, bulk: true, by: req.admin.username }, req.admin.username);
        if (l.customer_email) {
          sendTemplateMail('licenseRevoked', l.customer_email, {
            customer_name: l.customer_name || 'Kunde', license_key: key, status: action, reason: reason || null
          }).catch(() => {});
        }
      } else if (action === 'activate') {
        await db.query('UPDATE licenses SET status = ? WHERE license_key = ?', ['active', key]);
        await addAuditLog('license_status_changed', { license_key: key, to: 'active', bulk: true, by: req.admin.username }, req.admin.username);
      } else if (action === 'assign_customer') {
        if (!customer_id) { results.failed.push({ key, reason: 'customer_id_required' }); continue; }
        await db.query('UPDATE licenses SET customer_id = ? WHERE license_key = ?', [customer_id, key]);
        await addAuditLog('license_customer_linked', { license_key: key, customer_id, bulk: true, by: req.admin.username }, req.admin.username);
      }
      results.ok.push(key);
    } catch (e) {
      console.error(`[bulk] ${key}:`, e.message);
      results.failed.push({ key, reason: e.message });
    }
  }
  res.json({ success: true, processed: results.ok.length, failed: results.failed.length, ...results });
}));

router.get('/webhooks/signing-info', requireAuth, (req, res) => {
  res.json({
    success: true,
    algorithm: 'HMAC-SHA256', header: 'X-OPA-Signature',
    description: 'Jeder Webhook-Request enthält den Header "X-OPA-Signature" (wenn ein Secret konfiguriert ist).'
  });
});

// ── Export ───────────────────────────────────────────────────────────────────
router.get('/export/licenses', requireAuth, asyncHandler(async (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'csv';
  const [rows] = await db.query('SELECT * FROM licenses ORDER BY created_at DESC');

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=licenses_export.json');
    return res.send(JSON.stringify(rows, null, 2));
  }

  // CSV Export
  const headers = ['license_key', 'type', 'customer_name', 'status', 'associated_domain', 'expires_at', 'usage_count', 'created_at'];
  let csv = headers.join(';') + '\n';
  for (const row of rows) {
    const line = headers.map(h => {
      let val = row[h];
      if (val instanceof Date) val = val.toISOString();
      if (val === null || val === undefined) val = '';
      return `"${String(val).replace(/"/g, '""')}"`;
    });
    csv += line.join(';') + '\n';
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=licenses_export.csv');
  res.send('\ufeff' + csv); // BOM for Excel
}));

router.get('/export/history', requireAuth, asyncHandler(async (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'csv';
  const [rows] = await db.query(`
    SELECT ph.*, c.name as customer_name, c.email as customer_email
    FROM purchase_history ph LEFT JOIN customers c ON ph.customer_id = c.id
    ORDER BY ph.created_at DESC
  `);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=purchase_history_export.json');
    return res.send(JSON.stringify(rows, null, 2));
  }

  // CSV Export
  const headers = ['id', 'customer_id', 'customer_name', 'license_key', 'plan', 'action', 'amount', 'created_at'];
  let csv = headers.join(';') + '\n';
  for (const row of rows) {
    const line = headers.map(h => {
      let val = row[h];
      if (val instanceof Date) val = val.toISOString();
      if (val === null || val === undefined) val = '';
      return `"${String(val).replace(/"/g, '""')}"`;
    });
    csv += line.join(';') + '\n';
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=purchase_history_export.csv');
  res.send('\ufeff' + csv); // BOM for Excel
}));


// ── Dashboard-Statistiken ──────────────────────────────────────────────────────
router.get('/stats', requireAuth, asyncHandler(async (req, res) => {
    const [[totals]] = await db.query(`
        SELECT
            COUNT(*) AS total,
            SUM(status = 'active') AS active,
            SUM(status = 'expired') AS expired,
            SUM(status = 'suspended') AS suspended,
            SUM(type = 'TRIAL') AS trials,
            SUM(type = 'FREE') AS free,
            SUM(type = 'STARTER') AS starter,
            SUM(type = 'PRO') AS pro,
            SUM(type = 'PRO_PLUS') AS pro_plus,
            SUM(type = 'ENTERPRISE') AS enterprise
        FROM licenses
    `);

    const [[newTrials]] = await db.query(`
        SELECT COUNT(*) AS count FROM licenses
        WHERE type = 'TRIAL' AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
    `);

    const [expiringSoon] = await db.query(`
        SELECT license_key, customer_name, type, expires_at
        FROM licenses
        WHERE status = 'active'
          AND expires_at BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 14 DAY)
        ORDER BY expires_at ASC
        LIMIT 10
    `);

    const [[revenue]] = await db.query(`
        SELECT COUNT(*) AS paid_licenses
        FROM licenses
        WHERE type NOT IN ('FREE', 'TRIAL') AND status = 'active'
    `);

    return res.json({
        success: true,
        totals,
        new_trials_last_7_days: newTrials.count,
        expiring_soon: expiringSoon,
        paid_licenses: revenue.paid_licenses
    });
}));

// ── Admin: Reseller verwalten ──────────────────────────────────────────────────
router.get('/resellers', requireAuth, asyncHandler(async (req, res) => {
    const [rows] = await db.query('SELECT * FROM reseller_keys ORDER BY created_at DESC');
    return res.json({ success: true, resellers: rows });
}));

router.post('/resellers', requireAuth, asyncHandler(async (req, res) => {
    const { name, email, max_trials = 10, notes } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'name fehlt.' });
    const apiKey = 'RSL-' + crypto.randomBytes(16).toString('hex').toUpperCase();
    await db.query(
        'INSERT INTO reseller_keys (api_key, name, email, max_trials, notes) VALUES (?,?,?,?,?)',
        [apiKey, name, email, max_trials, notes]
    );
    await addAuditLog('reseller_created', { name, email, max_trials }, req.admin.username);
    return res.status(201).json({ success: true, api_key: apiKey, name, max_trials });
}));

router.patch('/resellers/:id', requireAuth, asyncHandler(async (req, res) => {
    const { max_trials, active, notes } = req.body;
    await db.query(
        'UPDATE reseller_keys SET max_trials = COALESCE(?,max_trials), active = COALESCE(?,active), notes = COALESCE(?,notes) WHERE id = ?',
        [max_trials, active, notes, req.params.id]
    );
    await addAuditLog('reseller_updated', { reseller_id: req.params.id, max_trials, active }, req.admin.username);
    return res.json({ success: true });
}));

export default router;
