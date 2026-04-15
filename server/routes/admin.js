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
  MIN_PASSWORD_LENGTH, signAdminToken, asyncHandler, bulkLimiter
} from '../middleware.js';

const router = Router();

/**
 * Generiert ein zufälliges 12-Zeichen-Passwort:
 * mind. 1 Großbuchstabe, 1 Ziffer, 1 Sonderzeichen – Rest alphanumerisch.
 */
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
  // Fisher-Yates shuffle
  for (let i = pw.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pw[i], pw[j]] = [pw[j], pw[i]];
  }
  return pw.join('');
}// ── Auth ───────────────────────────────────────────────────────────────────
router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: 'Username and password required' });

  const [rows] = await db.query(
    'SELECT id, username, password_hash, role FROM admins WHERE username = ?', [username]
  );
  const admin = rows[0];
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    await addAuditLog('admin_login_failed', { username, ip: getClientIp(req) });
    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  }

  // RS256 oder HS256 (je nach Konfiguration in middleware.js)
  const token = signAdminToken({ username: admin.username, role: admin.role });

  // Session in admin_sessions speichern (Grundlage für Token-Blacklist)
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

// ── POST /logout ────────────────────────────────────────────────────────
router.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  await db.query(
    'UPDATE admin_sessions SET revoked = 1 WHERE token_hash = ?',
    [req.adminTokenHash]
  );
  await addAuditLog('admin_logout', { username: req.admin.username, ip: getClientIp(req) }, req.admin.username);
  res.json({ success: true, message: 'Erfolgreich ausgeloggt.' });
}));

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
  // Fix #8: LIKE-Wildcards escapen (%  _ \ führen sonst zu unerwartetem Verhalten)
  const search = req.query.search
    ? `%${req.query.search.replace(/[%_\\]/g, '\\$&')}%`
    : null;

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

      // Lizenz-Mail an Kunden senden (wenn E-Mail vorhanden)
      try {
        const [custRows] = await db.query('SELECT * FROM customers WHERE id = ?', [raw.customer_id]);
        const cust = custRows[0];
        if (cust?.email) {
          await sendTemplateMail('licenseCreated', cust.email, {
            customer_name: cust.name,
            license_key:   key,
            type:          raw.type || 'FREE',
            expires_at:    expiresAt,
            associated_domain: raw.associated_domain || '*'
          });
          console.log(`[licenses] Lizenz-Mail gesendet an ${cust.email}`);
        }
      } catch (mailErr) {
        console.error('[licenses] Lizenz-Mail fehlgeschlagen (nicht kritisch):', mailErr.message);
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
});

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

  // E-Mail bei Sperrung / Suspension
  if (['revoked', 'suspended'].includes(req.body.status) && l.customer_email) {
    try {
      await sendTemplateMail('licenseRevoked', l.customer_email, {
        customer_name: l.customer_name || l.customer_real_name || 'Kunde',
        license_key:   req.params.key,
        status:        req.body.status,
        reason:        req.body.reason || null
      });
    } catch (mailErr) {
      console.error('[licenses] Sperr-Mail fehlgeschlagen (nicht kritisch):', mailErr.message);
    }
  }
  res.json({ success: true });
}));

// PATCH /licenses/:key — vollständige Lizenzbearbeitung
router.patch('/licenses/:key', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden' });

  const { type, associated_domain, expires_at, max_devices, customer_name, customer_id, allowed_modules, limits } = req.body;
  const updates = [];
  const params  = [];

  if (type !== undefined)              { updates.push('type = ?');               params.push(type); }
  if (associated_domain !== undefined) { updates.push('associated_domain = ?');  params.push(associated_domain); }
  if (expires_at !== undefined)        { updates.push('expires_at = ?');         params.push(expires_at); }
  if (max_devices !== undefined)       { updates.push('max_devices = ?');        params.push(parseInt(max_devices) || 0); }
  if (customer_name !== undefined)     { updates.push('customer_name = ?');      params.push(customer_name); }
  if (customer_id !== undefined)       { updates.push('customer_id = ?');        params.push(customer_id || null); }
  if (allowed_modules !== undefined)   { updates.push('allowed_modules = ?');    params.push(JSON.stringify(allowed_modules)); }
  if (limits !== undefined)            { updates.push('limits = ?');             params.push(JSON.stringify(limits)); }

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

  // E-Mail-Bestätigung an Kunden
  if (l.customer_email) {
    try {
      await sendTemplateMail('licenseRenewed', l.customer_email, {
        customer_name: l.customer_name || 'Kunde',
        license_key:   req.params.key,
        type:          l.type,
        new_expires_at: newExpiryStr,
        days
      });
    } catch (mailErr) {
      console.error('[licenses] Verlängerungs-Mail fehlgeschlagen (nicht kritisch):', mailErr.message);
    }
  }

  res.json({ success: true, new_expires_at: newExpiryStr, days_extended: days });
}));


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

/**
 * Normalisiert einen String für die Verwendung im Benutzernamen:
 * Umlaute → ASCII, Kleinbuchstaben, nur Buchstaben/Ziffern.
 */
function normalizeSlug(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // Diakritika entfernen (ä→a, ö→o, ü→u)
    .replace(/ß/gi, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');       // nur Buchstaben und Ziffern
}

/**
 * Generiert einen Portal-Benutzernamen aus Name + optionalem Firmennamen.
 *
 * Schema:  vorname.nachname[.firma]
 * Beispiele:
 *   "Max Müller", "Muster GmbH"  → "max.mueller.mustergmbh"
 *   "Max Müller",  null           → "max.mueller"
 *   "Max",         "Muster GmbH"  → "max.mustergmbh"
 */
function buildPortalUsername(name, company = null) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  let slug;
  if (parts.length >= 2) {
    // Vorname + letztes Wort als Nachname
    slug = `${normalizeSlug(parts[0])}.${normalizeSlug(parts[parts.length - 1])}`;
  } else if (parts.length === 1) {
    slug = normalizeSlug(parts[0]);
  } else {
    slug = 'kunde';
  }

  if (company) {
    // Firma normalisieren: Rechtsformen kürzen (GmbH, AG, KG, …) und auf 12 Zeichen kappen
    const firmSlug = normalizeSlug(company)
      .replace(/gmbhcokg|gmbhco|gmbh|gbr|ohg|ug|ag|kg|ev|inc|ltd/g, '')
      .replace(/^\d+/, '')  // führende Ziffern entfernen
      .slice(0, 12);
    if (firmSlug) slug = `${slug}.${firmSlug}`;
  }

  return slug || 'kunde';
}

/**
 * Gibt einen einzigartigen portal_username zurück.
 * Hängt bei Kollisionen eine Nummer an (max.mueller2, max.mueller3, …).
 * Fällt still zurück falls die DB-Spalte noch nicht existiert.
 */
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
    // Spalte existiert noch nicht (Migration ausstehend)
    return base;
  }
}


// ── Customers ─────────────────────────────────────────────────────────────────

router.get('/customers', requireAuth, asyncHandler(async (req, res) => {
  const includeArchived = req.query.include_archived === '1';
  const query = includeArchived
    ? `SELECT ${CUSTOMER_SAFE_FIELDS} FROM customers ORDER BY archived ASC, created_at DESC`
    : `SELECT ${CUSTOMER_SAFE_FIELDS} FROM customers WHERE archived = 0 OR archived IS NULL ORDER BY created_at DESC`;
  const [rows] = await db.query(query);
  res.json({ customers: rows });
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

  // DB-Transaktion: INSERT + UPDATE portal_username atomar
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
    conn.release();
    console.error('[customers/create]', e);
    return res.status(500).json({ success: false, message: `Fehler beim Anlegen: ${e.message}` });
  }
  conn.release();

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
    conn.release();
    throw e;
  }
  conn.release();
  await addAuditLog('customer_deleted', { customer_id: req.params.id, by: req.admin.username }, req.admin.username);
  res.json({ success: true });
}));


// ── Portal-Einladung senden ───────────────────────────────────────────────────
router.post('/customers/:id/send-portal-invite', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    const customer = rows[0];
    if (!customer) return res.status(404).json({ success: false, message: 'Kunde nicht gefunden.' });
    if (!customer.email) return res.status(400).json({ success: false, message: 'Kunde hat keine E-Mail-Adresse.' });

    const token = crypto.randomBytes(40).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');
    await db.query(
      'UPDATE customers SET portal_token = ?, portal_token_expires = ? WHERE id = ?',
      [token, expires, customer.id]
    );

    const baseUrl = (process.env.PORTAL_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
    const inviteUrl = `${baseUrl}/portal.html?token=${token}`;

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
    const info = await sendTemplateMail('test', to, { host: cfg.host });
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

// ── GET /sessions (SuperAdmin) ───────────────────────────────────────────────
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
       FROM customer_sessions s
       LEFT JOIN customers c ON s.customer_id = c.id
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

// ── Bulk-Aktionen für Lizenzen ────────────────────────────────────────────────
// POST /api/admin/licenses/bulk
// Body: { action: 'renew'|'revoke'|'suspend'|'assign_customer', keys: [...], days?, customer_id? }
router.post('/licenses/bulk', requireAuth, bulkLimiter, asyncHandler(async (req, res) => {
  const { action, keys, days, customer_id, reason, confirm } = req.body;
  const ALLOWED_ACTIONS = ['renew', 'revoke', 'suspend', 'assign_customer', 'activate'];
  if (!action || !ALLOWED_ACTIONS.includes(action))
    return res.status(400).json({ success: false, message: `Ungültige Aktion. Erlaubt: ${ALLOWED_ACTIONS.join(', ')}` });
  if (!Array.isArray(keys) || keys.length === 0)
    return res.status(400).json({ success: false, message: 'keys[] muss eine nicht-leere Liste von Lizenzschlüsseln sein.' });
  if (keys.length > 100)
    return res.status(400).json({ success: false, message: 'Maximal 100 Lizenzen pro Bulk-Operation.' });

  // Sicherheits-Bestaetigung
  if (confirm !== true)
    return res.status(400).json({ success: false, message: 'Sicherheitscheck: { "confirm": true } muss im Body enthalten sein.' });

  const results = { ok: [], failed: [] };

  for (const key of keys) {
    try {
      const [rows] = await db.query(
        'SELECT l.*, c.email AS customer_email FROM licenses l LEFT JOIN customers c ON l.customer_id = c.id WHERE l.license_key = ?',
        [key]
      );
      const l = rows[0];
      if (!l) { results.failed.push({ key, reason: 'not_found' }); continue; }

      if (action === 'renew') {
        const plan = PLAN_DEFINITIONS[l.type] || PLAN_DEFINITIONS['FREE'];
        const d = days || plan.expires_days;
        const base = new Date(l.expires_at) > new Date() ? new Date(l.expires_at) : new Date();
        const newExpiry = new Date(base.getTime() + d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        await db.query(
          "UPDATE licenses SET expires_at = ?, status = 'active', expiry_notified_at = NULL WHERE license_key = ?",
          [newExpiry, key]
        );
        await addAuditLog('license_renewed', { license_key: key, days: d, bulk: true, by: req.admin.username }, req.admin.username);

      } else if (action === 'revoke' || action === 'suspend') {
        await db.query('UPDATE licenses SET status = ? WHERE license_key = ?', [action === 'revoke' ? 'revoked' : 'suspended', key]);
        await addAuditLog('license_status_changed', { license_key: key, to: action, bulk: true, by: req.admin.username }, req.admin.username);
        if (l.customer_email) {
          sendTemplateMail('licenseRevoked', l.customer_email, {
            customer_name: l.customer_name || 'Kunde', license_key: key,
            status: action, reason: reason || null
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

  res.json({
    success: true,
    processed: results.ok.length,
    failed: results.failed.length,
    ...results
  });
}));

// ── Webhook-Signatur-Doku ─────────────────────────────────────────────────────
// GET /api/admin/webhooks/signing-info
// Erklärt wie Empfänger die HMAC-Signatur prüfen.
router.get('/webhooks/signing-info', requireAuth, (req, res) => {
  res.json({
    success: true,
    description: 'Jeder Webhook-Request enthält den Header "X-OPA-Signature" (wenn ein Secret konfiguriert ist).',
    algorithm: 'HMAC-SHA256',
    header: 'X-OPA-Signature',
    how_to_verify: [
      '1. Lies den rohen Request-Body als String.',
      '2. Berechne: HMAC-SHA256(body, webhook_secret).',
      '3. Vergleiche das Ergebnis mit dem Header-Wert (hex-kodiert).',
      '4. Verwende einen timing-safe Vergleich (z.B. crypto.timingSafeEqual in Node.js).'
    ],
    example_nodejs: `
const crypto = require('crypto');
function verifyWebhook(rawBody, secret, signature) {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}`.trim(),
    example_php: `
<?php
function verifyWebhook(string $rawBody, string $secret, string $signature): bool {
  $expected = hash_hmac('sha256', $rawBody, $secret);
  return hash_equals($expected, $signature);
}`.trim()
  });
});

export default router;
