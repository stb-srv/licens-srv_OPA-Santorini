import { Router } from 'express';
import db from '../db.js';
import { parseJsonField, addAuditLog } from '../helpers.js';
import { requireAuth, requireSuperAdmin, asyncHandler } from '../middleware.js';

const router = Router();

const CUSTOMER_SAFE_FIELDS = 'id, name, email, phone, contact_person, company, payment_status, notes, archived, portal_username, must_change_password, created_at, updated_at';

// ── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics', requireAuth, asyncHandler(async (req, res) => {
  const [topLics] = await db.query(
    'SELECT license_key, customer_name, type, usage_count, last_validated FROM licenses ORDER BY usage_count DESC LIMIT 10'
  );

  const [statusStats] = await db.query('SELECT status, COUNT(*) as count FROM licenses GROUP BY status');
  
  const [typeStats] = await db.query('SELECT type, COUNT(*) as count FROM licenses GROUP BY type');

  const [[{ count_30d }]] = await db.query('SELECT COUNT(*) as count_30d FROM licenses WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
  const [[{ count_7d }]] = await db.query('SELECT COUNT(*) as count_7d FROM licenses WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)');

  const [allLics] = await db.query('SELECT analytics_daily, analytics_features FROM licenses');
  const daily = {}, features = {};
  for (const l of allLics) {
    const d = parseJsonField(l.analytics_daily, {});
    for (const [day, count] of Object.entries(d)) daily[day] = (daily[day] || 0) + count;
    const f = parseJsonField(l.analytics_features, {});
    for (const [feat, count] of Object.entries(f)) features[feat] = (features[feat] || 0) + count;
  }

  const [[{ total_devices }]] = await db.query('SELECT COUNT(*) as total_devices FROM devices');
  const [[{ active_devices }]] = await db.query('SELECT COUNT(*) as active_devices FROM devices WHERE active = 1');

  const [[{ revenue_total }]] = await db.query('SELECT SUM(amount) as revenue_total FROM purchase_history');
  const [[{ revenue_month }]] = await db.query(
    'SELECT SUM(amount) as revenue_month FROM purchase_history WHERE created_at >= DATE_FORMAT(NOW(), "%Y-%m-01")'
  );
  const [[{ revenue_30d }]] = await db.query(
    'SELECT SUM(amount) as revenue_30d FROM purchase_history WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'
  );

  const [topCustomers] = await db.query(
    `SELECT c.name, COUNT(l.license_key) as lic_count 
     FROM customers c JOIN licenses l ON c.id = l.customer_id 
     GROUP BY c.id, c.name ORDER BY lic_count DESC LIMIT 10`
  );

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

// ── Stats Dashboard ──────────────────────────────────────────────────────────
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

// ── Audit Log ────────────────────────────────────────────────────────────────
router.get('/audit-log', requireAuth, asyncHandler(async (req, res) => {
  const rawLimit = parseInt(req.query.limit) || 100;
  const limit = Math.min(1000, Math.max(1, rawLimit));
  const { action, license_key } = req.query;

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

// ── Login Log ────────────────────────────────────────────────────────────────
router.get('/login-log', requireAuth, asyncHandler(async (req, res) => {
  try {
    const limit = Math.min(500, parseInt(req.query.limit) || 100);
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

// ── Webhook Logs ─────────────────────────────────────────────────────────────
router.get('/webhook-logs', requireAuth, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = (page - 1) * limit;
  const status = req.query.status;

  let where = '1=1';
  const params = [];
  if (status && ['success', 'failed'].includes(status)) {
    where += ' AND status = ?';
    params.push(status);
  }

  const [[{ total }]] = await db.query(`SELECT COUNT(*) as total FROM webhook_logs WHERE ${where}`, params);
  const [logs] = await db.query(
    `SELECT * FROM webhook_logs WHERE ${where} ORDER BY attempted_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  res.json({
    success: true,
    logs,
    pagination: {
      page,
      limit,
      total: parseInt(total),
      pages: Math.ceil(total / limit)
    }
  });
}));

export default router;
