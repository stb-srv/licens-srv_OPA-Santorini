import { Router } from 'express';
import crypto from 'crypto';
import db from '../db.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import { sendTemplateMail } from '../mailer/index.js';
import { fireWebhook } from '../webhook.js';
import { generateKey, addAuditLog, normalizeDomain, parseJsonField } from '../helpers.js';
import { requireAuth, asyncHandler, bulkLimiter } from '../middleware.js';

const router = Router();

function normalizeLicense(l) {
  if (!l) return l;
  return {
    ...l,
    tags:              parseJsonField(l.tags, []),
    allowed_modules:   parseJsonField(l.allowed_modules, []),
    limits:            parseJsonField(l.limits, {}),
    analytics_daily:   parseJsonField(l.analytics_daily, {}),
    analytics_features:parseJsonField(l.analytics_features, {}),
    validated_domains: parseJsonField(l.validated_domains, []),
  };
}

// ── Licenses CRUD ────────────────────────────────────────────────────────────
router.get('/licenses', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = (page - 1) * limit;
  const search = req.query.search
    ? `%${req.query.search.replace(/[%_\\]/g, '\\$&')}%`
    : null;

  const customer_id = req.query.customer_id;
  const expiring = req.query.expiring === '1';
  const tag = req.query.tag;

  let where = '1=1';
  const params = [];
  if (customer_id) {
    where += ' AND customer_id = ?';
    params.push(customer_id);
  }
  if (search) {
    where += ' AND (license_key LIKE ? OR customer_name LIKE ? OR associated_domain LIKE ?)';
    params.push(search, search, search);
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
    licenses: licenses.map(normalizeLicense),
    stats: {
      total: statsRow.total_all,
      active: statsRow.active || 0,
      expiring: statsRow.expiring || 0,
      total_usage: statsRow.total_usage || 0
    },
    pagination: { page, limit, total: parseInt(total), pages: Math.ceil(total / limit) }
  });
}));

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

router.get('/licenses/:key', requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [req.params.key]);
  if (!rows[0]) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, license: normalizeLicense(rows[0]) });
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
       raw.associated_domain ? normalizeDomain(raw.associated_domain) || '*' : '*', expiresAt, JSON.stringify(modules), JSON.stringify(limits),
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
    res.json({ success: true, license: normalizeLicense(newRows[0]) });
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

  if (['revoked', 'cancelled', 'suspended'].includes(req.body.status) && l.customer_id) {
    await db.query('DELETE FROM customer_sessions WHERE customer_id = ?', [l.customer_id]);
    await addAuditLog('portal_sessions_revoked', { license_key: req.params.key, customer_id: l.customer_id }, req.admin.username);
  }

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

  const { type, associated_domain, expires_at, max_devices, customer_name, customer_id, allowed_modules, limits, tags } = req.body;
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
  res.json({ success: true, license: normalizeLicense(updated[0]) });
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
    const [[lic]] = await db.query('SELECT customer_id FROM licenses WHERE license_key = ?', [req.params.key]);
    await db.query('DELETE FROM licenses WHERE license_key = ?', [req.params.key]);
    
    if (lic?.customer_id) {
      await db.query('DELETE FROM customer_sessions WHERE customer_id = ?', [lic.customer_id]);
      await addAuditLog('portal_sessions_revoked', { license_key: req.params.key, customer_id: lic.customer_id, action: 'license_deleted' }, req.admin.username);
    }
    
    await addAuditLog('license_deleted', { license_key: req.params.key, by: req.admin.username }, req.admin.username);
    await fireWebhook('license.deleted', { license_key: req.params.key });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

router.post('/licenses/:key/upgrade', requireAuth, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { new_type, extend_days } = req.body;

    const validTypes = ['FREE', 'STARTER', 'PRO', 'PRO_PLUS', 'ENTERPRISE'];
    if (!new_type || !validTypes.includes(new_type)) {
        return res.status(400).json({ success: false, message: `Ungültiger Plan. Erlaubt: ${validTypes.join(', ')}` });
    }

    const [rows] = await db.query(`
        SELECT l.*, c.email AS customer_email 
        FROM licenses l 
        LEFT JOIN customers c ON l.customer_id = c.id 
        WHERE l.license_key = ?`, [key]);
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

    if (new_type !== 'FREE' && new_type !== 'TRIAL') {
        try {
            const { generateInvoicePdf } = await import('../mailer/templates/invoicePdf.js');
            const { sendMail } = await import('../mailer/index.js');
            const invoiceNo = `INV-${Date.now()}`;
            const priceMap  = { STARTER: 29, PRO: 59, PRO_PLUS: 89, ENTERPRISE: 199 };
            const pdfBuffer = await generateInvoicePdf({
                invoice_number: invoiceNo,
                customer_name:  rows[0].customer_name,
                domain:         rows[0].associated_domain,
                plan_label:     new_type,
                price_eur:      priceMap[new_type] || 0,
                date:           new Date()
            });

            const email = rows[0].customer_email || JSON.parse(rows[0].notes || '{}').contact_email;
            if (email) {
                await sendMail({
                    to:      email,
                    subject: `Ihre OPA! Rechnung – ${invoiceNo}`,
                    text:    `Vielen Dank für Ihr Upgrade auf ${new_type}. Ihre Rechnung im Anhang.`,
                    attachments: [{ filename: `${invoiceNo}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
                });
                console.log(`🧾 Rechnung ${invoiceNo} an ${email} gesendet.`);
            }
        } catch(pdfErr) {
            console.warn('Rechnungs-PDF fehlgeschlagen:', pdfErr.message);
        }
    }

    return res.json({
        success: true,
        message: `Lizenz auf ${new_type} upgraded. Läuft ab: ${newExpiry.toISOString()}`,
        license_key: key,
        new_type,
        expires_at: newExpiry
    });
}));

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

router.post('/licenses/:key/transfer', requireAuth, asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { new_domain } = req.body;
    if (!new_domain) return res.status(400).json({ success: false, message: 'new_domain fehlt.' });

    const [rows] = await db.query('SELECT * FROM licenses WHERE license_key = ?', [key]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Lizenz nicht gefunden.' });

    const old_domain = rows[0].associated_domain;

    await db.query(
        'UPDATE licenses SET associated_domain = ? WHERE license_key = ?',
        [normalizeDomain(new_domain) || new_domain, key]
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

// ── Bulk Actions ─────────────────────────────────────────────────────────────
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
        
        if (l.customer_id) {
          await db.query('DELETE FROM customer_sessions WHERE customer_id = ?', [l.customer_id]);
          await addAuditLog('portal_sessions_revoked', { license_key: key, customer_id: l.customer_id, bulk: true }, req.admin.username);
        }

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

// ── Export Licenses ──────────────────────────────────────────────────────────
router.get('/export/licenses', requireAuth, asyncHandler(async (req, res) => {
  const format = req.query.format === 'json' ? 'json' : 'csv';
  const [rows] = await db.query('SELECT * FROM licenses ORDER BY created_at DESC');

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=licenses_export.json');
    return res.send(JSON.stringify(rows.map(normalizeLicense), null, 2));
  }

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
  res.send('\ufeff' + csv);
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

// ── Reseller ─────────────────────────────────────────────────────────────────
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
