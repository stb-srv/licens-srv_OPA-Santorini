import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import db from '../db.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import { buildTransporter, verifySmtp, sendTemplateMail, getActiveSmtpConfig } from '../mailer/index.js';
import { fireWebhook } from '../webhook.js';
import { generateKey, getClientIp, addAuditLog, parseJsonField } from '../helpers.js';
import { requireAuth, requireSuperAdmin, loginLimiter, MIN_PASSWORD_LENGTH } from '../middleware.js';

const router = Router();
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';

// ── Auth ────────────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username and password required' });
  try {
    const [rows] = await db.query('SELECT * FROM admins WHERE username = ?', [username]);
    const admin = rows[0];
    if (!admin) {
      await addAuditLog('admin_login_failed', { username, ip: getClientIp(req) });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      await addAuditLog('admin_login_failed', { username, ip: getClientIp(req) });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const token = jwt.sign({ username: admin.username, role: admin.role }, ADMIN_SECRET, { expiresIn: '8h' });
    await addAuditLog('admin_login', { username, ip: getClientIp(req) }, username);
    res.json({ success: true, token, username: admin.username, role: admin.role });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Admin Users ──────────────────────────────────────────────────────────────
router.get('/users', requireAuth, requireSuperAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT id, username, role, created_at FROM admins');
  res.json({ users: rows });
});

router.post('/users', requireAuth, requireSuperAdmin, async (req, res) => {
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
});

router.delete('/users/:username', requireAuth, requireSuperAdmin, async (req, res) => {
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
});

router.patch('/users/:username/password', requireAuth, async (req, res) => {
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
});

// ── Plans ────────────────────────────────────────────────────────────────────
router.get('/plans', requireAuth, (req, res) => res.json(PLAN_DEFINITIONS));

// ── Licenses ─────────────────────────────────────────────────────────────────
router.get('/licenses', requireAuth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = (page - 1) * limit;
  const search = req.query.search ? `%${req.query.search}%` : null;

  const [[{ total }]] = await db.query(
    search
      ? 'SELECT COUNT(*) as total FROM licenses WHERE license_key LIKE ? OR customer_name LIKE ?'
      : 'SELECT COUNT(*) as total FROM licenses',
    search ? [search, search] : []
  );

  const [licenses] = await db.query(
    search
      ? 'SELECT * FROM licenses WHERE license_key LIKE ? OR customer_name LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      : 'SELECT * FROM licenses ORDER BY created_at DESC LIMIT ? OFFSET ?',
    search ? [search, search, limit, offset] : [limit, offset]
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
});

router.get('/licenses/:key', requireAuth, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, license: rows[0] });
});

router.post('/licenses', requireAuth, async (req, res) => {
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
         expires_at, allowed_modules, limits, max_devices, analytics_daily, analytics_features, validated_domains)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, '{}', '{}', '[]')
      ON DUPLICATE KEY UPDATE
        type=VALUES(type), customer_id=VALUES(customer_id), customer_name=VALUES(customer_name),
        associated_domain=VALUES(associated_domain), expires_at=VALUES(expires_at),
        allowed_modules=VALUES(allowed_modules), limits=VALUES(limits), max_devices=VALUES(max_devices)`,
      [key, raw.type || 'FREE', raw.customer_id || null, raw.customer_name || null,
       raw.associated_domain || '*', expiresAt, JSON.stringify(modules), JSON.stringify(limits),
       raw.max_devices ? parseInt(raw.max_devices) : 0]
    );

    if (raw.customer_id) {
      await db.query(
        `INSERT IGNORE INTO purchase_history (id, customer_id, license_key, plan, action, amount, note, created_by)
         VALUES (?, ?, ?, ?, 'purchase', ?, ?, ?)`,
        [crypto.randomUUID(), raw.customer_id, key, raw.type || 'FREE',
         raw.amount || null, raw.note || `Lizenz ${raw.type || 'FREE'} erstellt`, req.admin.username]
      );
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
});

router.patch('/licenses/:key/status', requireAuth, async (req, res) => {
  const VALID_STATUSES = ['active', 'revoked', 'cancelled', 'expired', 'suspended'];
  if (!req.body.status || !VALID_STATUSES.includes(req.body.status))
    return res.status(400).json({ success: false, message: `Ungültiger Status. Erlaubt: ${VALID_STATUSES.join(', ')}` });
  try {
    const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
    if (!rows[0]) return res.status(404).json({ success: false });
    await db.query('UPDATE licenses SET status = ? WHERE license_key = ?', [req.body.status, req.params.key]);
    await addAuditLog('license_status_changed',
      { license_key: req.params.key, from: rows[0].status, to: req.body.status, by: req.admin.username },
      req.admin.username);
    await fireWebhook('license.status_changed', { license_key: req.params.key, from: rows[0].status, to: req.body.status });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.post('/licenses/:key/renew', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
    const l = rows[0];
    if (!l) return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden' });
    const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
    const days = req.body.days || plan.expires_days;
    const baseDate = new Date(l.expires_at) > new Date() ? new Date(l.expires_at) : new Date();
    const newExpiryStr = new Date(baseDate.getTime() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');

    await db.query("UPDATE licenses SET expires_at = ?, status = 'active' WHERE license_key = ?",
      [newExpiryStr, req.params.key]);

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
    res.json({ success: true, new_expires_at: newExpiryStr, days_extended: days });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.delete('/licenses/:key', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM licenses WHERE license_key = ?', [req.params.key]);
    await addAuditLog('license_deleted', { license_key: req.params.key, by: req.admin.username }, req.admin.username);
    await fireWebhook('license.deleted', { license_key: req.params.key });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.patch('/licenses/:key/customer', requireAuth, async (req, res) => {
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
});

// ── Customers ────────────────────────────────────────────────────────────────
router.get('/customers', requireAuth, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM customers ORDER BY created_at DESC');
  res.json({ customers: rows });
});

router.post('/customers', requireAuth, async (req, res) => {
  const { name, email, phone, contact_person, company, payment_status, notes } = req.body;
  if (!name) return res.status(400).json({ success: false, message: 'Name required' });
  if (!email) return res.status(400).json({ success: false, message: 'E-Mail ist ein Pflichtfeld' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ success: false, message: 'Ungültige E-Mail-Adresse' });
  try {
    const id = crypto.randomUUID();
    await db.query(
      'INSERT INTO customers (id, name, email, phone, contact_person, company, payment_status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, name, email, phone || null, contact_person || null, company || null, payment_status || 'unknown', notes || '']
    );
    await addAuditLog('customer_created', { customer_id: id, name, email, by: req.admin.username }, req.admin.username);
    const [rows] = await db.query('SELECT * FROM customers WHERE id = ?', [id]);
    res.json({ success: true, customer: rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.patch('/customers/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Customer not found' });
    const { name, email, phone, contact_person, company, payment_status, notes } = req.body;
    if (email !== undefined) {
      if (!email) return res.status(400).json({ success: false, message: 'E-Mail ist ein Pflichtfeld' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ success: false, message: 'Ungültige E-Mail-Adresse' });
    }
    await db.query(
      `UPDATE customers SET
        name=COALESCE(?,name), email=COALESCE(?,email), phone=?, contact_person=?,
        company=COALESCE(?,company), payment_status=COALESCE(?,payment_status), notes=COALESCE(?,notes)
       WHERE id=?`,
      [name || null, email || null,
       phone !== undefined ? phone : rows[0].phone,
       contact_person !== undefined ? contact_person : rows[0].contact_person,
       company || null, payment_status || null,
       notes !== undefined ? notes : rows[0].notes,
       req.params.id]
    );
    await addAuditLog('customer_updated', { customer_id: req.params.id, by: req.admin.username }, req.admin.username);
    const [updated] = await db.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    res.json({ success: true, customer: updated[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.delete('/customers/:id', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM customers WHERE id = ?', [req.params.id]);
    await addAuditLog('customer_deleted', { customer_id: req.params.id, by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Portal-Einladung senden ───────────────────────────────────────────────────
// POST /api/admin/customers/:id/send-portal-invite
// Generiert einen Einmal-Token (24h gültig) und schickt dem Kunden eine Einladungsmail.
router.post('/customers/:id/send-portal-invite', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    const customer = rows[0];
    if (!customer) return res.status(404).json({ success: false, message: 'Kunde nicht gefunden.' });
    if (!customer.email) return res.status(400).json({ success: false, message: 'Kunde hat keine E-Mail-Adresse.' });

    // Einmal-Token generieren (gültig 24h)
    const token = crypto.randomBytes(40).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    await db.query(
      'UPDATE customers SET portal_token = ?, portal_token_expires = ? WHERE id = ?',
      [token, expires, customer.id]
    );

    // Invite-URL zusammenbauen
    const baseUrl = (process.env.PORTAL_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
    const inviteUrl = `${baseUrl}/portal.html?token=${token}`;

    // Mail senden
    await sendTemplateMail('portalInvite', customer.email, {
      name: customer.name,
      email: customer.email,
      invite_url: inviteUrl
    });

    await addAuditLog('portal_invite_sent',
      { customer_id: customer.id, email: customer.email, by: req.admin.username },
      req.admin.username);

    res.json({ success: true, message: `Einladungsmail an ${customer.email} gesendet.` });
  } catch (e) {
    console.error('[portal-invite]', e.message);
    res.status(500).json({ success: false, message: `Fehler: ${e.message}` });
  }
});

// ── Purchase History ──────────────────────────────────────────────────────────
router.get('/purchase-history', requireAuth, async (req, res) => {
  try {
    const { customer_id, license_key } = req.query;
    let query = `
      SELECT ph.*, c.name as customer_name, c.email as customer_email
      FROM purchase_history ph
      LEFT JOIN customers c ON ph.customer_id = c.id
      WHERE 1=1`;
    const params = [];
    if (customer_id) { query += ' AND ph.customer_id = ?'; params.push(customer_id); }
    if (license_key) { query += ' AND ph.license_key = ?'; params.push(license_key); }
    query += ' ORDER BY ph.created_at DESC LIMIT 500';
    const [rows] = await db.query(query, params);
    res.json({ success: true, history: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.post('/purchase-history', requireAuth, async (req, res) => {
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
      { customer_id, license_key, action: action || 'purchase', by: req.admin.username },
      req.admin.username);
    const [rows] = await db.query('SELECT * FROM purchase_history WHERE id = ?', [id]);
    res.json({ success: true, entry: rows[0] });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.delete('/purchase-history/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM purchase_history WHERE id = ?', [req.params.id]);
    await addAuditLog('purchase_history_deleted', { id: req.params.id, by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Login-Log ─────────────────────────────────────────────────────────────────
router.get('/login-log', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
    const [rows] = await db.query(
      `SELECT * FROM audit_log WHERE action IN ('admin_login','admin_login_failed') ORDER BY ts DESC LIMIT ?`,
      [limit]
    );
    res.json({ success: true, logs: rows });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Devices ──────────────────────────────────────────────────────────────────
router.get('/devices', requireAuth, async (req, res) => {
  const { license_key } = req.query;
  let query = 'SELECT * FROM devices';
  const params = [];
  if (license_key) { query += ' WHERE license_key = ?'; params.push(license_key); }
  const [devices] = await db.query(query, params);
  res.json({ devices });
});

router.patch('/devices/:id/deactivate', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM devices WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false });
    await db.query('UPDATE devices SET active = 0, deactivated_at = NOW() WHERE id = ?', [req.params.id]);
    await addAuditLog('device_deactivated',
      { device_id: rows[0].device_id, license_key: rows[0].license_key, by: req.admin.username },
      req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

router.delete('/devices/:id', requireAuth, async (req, res) => {
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
});

// ── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics', requireAuth, async (req, res) => {
  const [licenses] = await db.query(
    'SELECT license_key, customer_name, type, usage_count, last_validated, analytics_daily, analytics_features FROM licenses ORDER BY usage_count DESC LIMIT 10'
  );
  const topLicenses = licenses.map(l => ({
    license_key: l.license_key,
    customer_name: l.customer_name,
    type: l.type,
    usage_count: l.usage_count || 0,
    last_validated: l.last_validated
  }));

  const [allLicenses] = await db.query('SELECT analytics_daily, analytics_features FROM licenses');
  const daily = {}, features = {};
  for (const l of allLicenses) {
    const d = parseJsonField(l.analytics_daily, {});
    for (const [day, count] of Object.entries(d)) daily[day] = (daily[day] || 0) + count;
    const f = parseJsonField(l.analytics_features, {});
    for (const [feat, count] of Object.entries(f)) features[feat] = (features[feat] || 0) + count;
  }

  const [[{ total_devices }]] = await db.query('SELECT COUNT(*) as total_devices FROM devices');
  const [[{ active_devices }]] = await db.query('SELECT COUNT(*) as active_devices FROM devices WHERE active = 1');

  res.json({ top_licenses: topLicenses, daily_requests: daily, feature_usage: features, total_devices, active_devices });
});

// ── Audit Log ────────────────────────────────────────────────────────────────
router.get('/audit-log', requireAuth, async (req, res) => {
  const rawLimit = parseInt(req.query.limit) || 100;
  const limit = Math.min(1000, Math.max(1, rawLimit));
  const { action, license_key } = req.query;
  let query = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];
  if (action) { query += ' AND action = ?'; params.push(action); }
  if (license_key) {
    query += ' AND JSON_EXTRACT(details, "$.license_key") = ?';
    params.push(license_key);
  }
  query += ' ORDER BY ts DESC LIMIT ?';
  params.push(limit);
  const [logs] = await db.query(query, params);
  res.json({ logs });
});

// ── SMTP ─────────────────────────────────────────────────────────────────────
router.get('/smtp', requireAuth, requireSuperAdmin, async (req, res) => {
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
});

router.post('/smtp', requireAuth, requireSuperAdmin, async (req, res) => {
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
});

router.post('/smtp/test', requireAuth, requireSuperAdmin, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ success: false, message: 'Empfänger-E-Mail fehlt' });
  try {
    const cfg = await getActiveSmtpConfig();
    if (!cfg) return res.status(500).json({ success: false, message: 'SMTP nicht konfiguriert. Bitte zuerst SMTP-Einstellungen speichern.' });
    console.log('[SMTP/test] Verwende Config:', cfg.source, cfg.host, cfg.port);
    const info = await sendTemplateMail('test', to, { host: cfg.host });
    console.log('[SMTP/test] Gesendet:', info.messageId);
    res.json({ success: true, message: `Test-E-Mail an ${to} gesendet. MessageId: ${info.messageId}` });
  } catch (e) {
    console.error('[SMTP/test] Fehler:', e.message, e.code || '');
    res.status(500).json({ success: false, message: `Fehler beim Senden: ${e.message}` });
  }
});

router.delete('/smtp', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM smtp_config WHERE id = 1');
    await addAuditLog('smtp_config_deleted', { by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Webhooks ─────────────────────────────────────────────────────────────────
router.get('/webhooks', requireAuth, requireSuperAdmin, async (req, res) => {
  const [rows] = await db.query('SELECT id, url, events, active, created_at FROM webhooks');
  res.json({ webhooks: rows });
});

router.post('/webhooks', requireAuth, requireSuperAdmin, async (req, res) => {
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
});

router.delete('/webhooks/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM webhooks WHERE id = ?', [req.params.id]);
    await addAuditLog('webhook_deleted', { webhook_id: req.params.id, by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ── Impersonate ───────────────────────────────────────────────────────────────
router.post('/impersonate', requireAuth, requireSuperAdmin, async (req, res) => {
  const { license_key } = req.body;
  if (!license_key) return res.status(400).json({ success: false });
  try {
    const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
    const l = rows[0];
    if (!l) return res.status(404).json({ success: false });
    const [custRows] = l.customer_id
      ? await db.query('SELECT * FROM customers WHERE id = ?', [l.customer_id])
      : [[]];
    const [devices] = await db.query('SELECT * FROM devices WHERE license_key = ?', [license_key]);
    await addAuditLog('impersonate', { license_key, by: req.admin.username }, req.admin.username);
    res.json({ success: true, license: l, customer: custRows[0] || null, devices });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
