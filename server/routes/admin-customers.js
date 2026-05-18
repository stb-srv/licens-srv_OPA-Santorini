import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import db from '../db.js';
import { sendTemplateMail } from '../mailer/index.js';
import { addAuditLog } from '../helpers.js';
import { requireAuth, requireSuperAdmin, asyncHandler } from '../middleware.js';

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

// ── Customers CRUD ────────────────────────────────────────────────────────────
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

// ── Export Purchase History ──────────────────────────────────────────────────
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
  res.send('\ufeff' + csv);
}));

export default router;
