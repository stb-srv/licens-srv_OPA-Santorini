import { Router } from 'express';
import db from '../db.js';
import { parseJsonField, addAuditLog } from '../helpers.js';
import { requireAuth, requireSuperAdmin, asyncHandler } from '../middleware.js';

const router = Router();

const CUSTOMER_SAFE_FIELDS = 'id, name, email, phone, contact_person, company, payment_status, notes, archived, portal_username, must_change_password, created_at, updated_at';

// ── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics', requireAuth, asyncHandler(async (req, res) => {
    const [topLics]     = db.query('SELECT license_key, customer_name, type, usage_count, last_validated FROM licenses ORDER BY usage_count DESC LIMIT 10');
    const [statusStats] = db.query('SELECT status, COUNT(*) as count FROM licenses GROUP BY status');
    const [typeStats]   = db.query('SELECT type, COUNT(*) as count FROM licenses GROUP BY type');

    const [[{ count_30d }]] = db.query(`SELECT COUNT(*) as count_30d FROM licenses WHERE created_at >= datetime('now', '-30 days')`);
    const [[{ count_7d }]]  = db.query(`SELECT COUNT(*) as count_7d FROM licenses WHERE created_at >= datetime('now', '-7 days')`);

    const [allLics] = db.query('SELECT analytics_daily, analytics_features FROM licenses');
    const daily = {}, features = {};
    for (const l of allLics) {
        const d = parseJsonField(l.analytics_daily, {});
        for (const [day, count] of Object.entries(d)) daily[day] = (daily[day] || 0) + count;
        const f = parseJsonField(l.analytics_features, {});
        for (const [feat, count] of Object.entries(f)) features[feat] = (features[feat] || 0) + count;
    }

    const [[{ total_devices }]]  = db.query('SELECT COUNT(*) as total_devices FROM devices');
    const [[{ active_devices }]] = db.query('SELECT COUNT(*) as active_devices FROM devices WHERE active = 1');
    const [[{ revenue_total }]]  = db.query('SELECT SUM(amount) as revenue_total FROM purchase_history');
    const [[{ revenue_month }]]  = db.query(`SELECT SUM(amount) as revenue_month FROM purchase_history WHERE created_at >= strftime('%Y-%m-01', 'now')`);
    const [[{ revenue_30d }]]    = db.query(`SELECT SUM(amount) as revenue_30d FROM purchase_history WHERE created_at >= datetime('now', '-30 days')`);

    const [topCustomers] = db.query(
        `SELECT c.name, COUNT(l.license_key) as lic_count FROM customers c JOIN licenses l ON c.id = l.customer_id GROUP BY c.id, c.name ORDER BY lic_count DESC LIMIT 10`
    );

    const validations_per_day = Object.entries(daily)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(-30);

    res.json({
        success: true,
        top_licenses: topLics, validations_per_day, status_distribution: statusStats,
        type_distribution: typeStats, feature_usage: features,
        growth: { last_7d: count_7d, last_30d: count_30d },
        devices: { total: total_devices, active: active_devices },
        revenue: { total: revenue_total || 0, month: revenue_month || 0, last_30d: revenue_30d || 0 },
        top_customers: topCustomers
    });
}));

// ── Stats Dashboard ──────────────────────────────────────────────────────────
router.get('/stats', requireAuth, asyncHandler(async (req, res) => {
    const [[totals]] = db.query(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
            SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) AS expired,
            SUM(CASE WHEN status='suspended' THEN 1 ELSE 0 END) AS suspended,
            SUM(CASE WHEN type='TRIAL' THEN 1 ELSE 0 END) AS trials,
            SUM(CASE WHEN type='FREE' THEN 1 ELSE 0 END) AS free,
            SUM(CASE WHEN type='STARTER' THEN 1 ELSE 0 END) AS starter,
            SUM(CASE WHEN type='PRO' THEN 1 ELSE 0 END) AS pro,
            SUM(CASE WHEN type='PRO_PLUS' THEN 1 ELSE 0 END) AS pro_plus,
            SUM(CASE WHEN type='ENTERPRISE' THEN 1 ELSE 0 END) AS enterprise
        FROM licenses
    `);

    const [[newTrials]] = db.query(`
        SELECT COUNT(*) AS count FROM licenses WHERE type='TRIAL' AND created_at >= datetime('now', '-7 days')
    `);

    const [expiringSoon] = db.query(`
        SELECT license_key, customer_name, type, expires_at FROM licenses
        WHERE status='active' AND expires_at BETWEEN datetime('now') AND datetime('now', '+14 days')
        ORDER BY expires_at ASC LIMIT 10
    `);

    const [[revenue]] = db.query(`
        SELECT COUNT(*) AS paid_licenses FROM licenses WHERE type NOT IN ('FREE','TRIAL') AND status='active'
    `);

    return res.json({
        success: true, totals, new_trials_last_7_days: newTrials.count,
        expiring_soon: expiringSoon, paid_licenses: revenue.paid_licenses
    });
}));

// ── GET /admin/stats/invoices ────────────────────────────────────────────────
router.get('/stats/invoices', requireAuth, asyncHandler(async (req, res) => {
    const [[kpis]] = db.query(`
        SELECT
            COALESCE(ROUND(SUM(CASE WHEN status!='cancelled' THEN amount_gross ELSE 0 END),2),0) AS total_invoiced,
            COALESCE(ROUND(SUM(CASE WHEN status='paid' THEN amount_gross ELSE 0 END),2),0) AS total_paid,
            COALESCE(ROUND(SUM(CASE WHEN status='sent' THEN amount_gross ELSE 0 END),2),0) AS total_open,
            COALESCE(ROUND(SUM(CASE WHEN status='overdue' THEN amount_gross ELSE 0 END),2),0) AS total_overdue,
            COALESCE(SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END),0) AS count_draft,
            COALESCE(SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END),0) AS count_sent,
            COALESCE(SUM(CASE WHEN status='overdue' THEN 1 ELSE 0 END),0) AS count_overdue,
            COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) AS count_paid
        FROM invoices
    `);

    const [[mrrRow]] = db.query(`
        SELECT COALESCE(ROUND(SUM(amount_gross),2),0) AS mrr FROM invoices
        WHERE status='paid' AND paid_at >= strftime('%Y-%m-01 00:00:00', 'now')
    `);

    const [overdueInvoices] = db.query(`
        SELECT i.invoice_number, c.name AS customer_name, i.amount_gross, i.due_date,
               CAST(julianday('now') - julianday(i.due_date) AS INTEGER) AS days_overdue
        FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id
        WHERE i.status='overdue'
        ORDER BY days_overdue DESC, i.due_date ASC LIMIT 10
    `);

    const [recentPaid] = db.query(`
        SELECT i.invoice_number, c.name AS customer_name, i.amount_gross, i.paid_at
        FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id
        WHERE i.status='paid' ORDER BY i.paid_at DESC, i.updated_at DESC LIMIT 5
    `);

    res.json({
        success: true,
        total_invoiced: Number(kpis.total_invoiced), total_paid: Number(kpis.total_paid),
        total_open: Number(kpis.total_open), total_overdue: Number(kpis.total_overdue),
        count_draft: Number(kpis.count_draft), count_sent: Number(kpis.count_sent),
        count_overdue: Number(kpis.count_overdue), count_paid: Number(kpis.count_paid),
        mrr: Number(mrrRow.mrr),
        overdue_invoices: overdueInvoices.map(inv => ({
            invoice_number: inv.invoice_number, customer_name: inv.customer_name || 'Unbekannt',
            amount_gross: Number(inv.amount_gross), due_date: inv.due_date, days_overdue: Number(inv.days_overdue)
        })),
        recent_paid: recentPaid.map(inv => ({
            invoice_number: inv.invoice_number, customer_name: inv.customer_name || 'Unbekannt',
            amount_gross: Number(inv.amount_gross), paid_at: inv.paid_at
        }))
    });
}));

// ── Audit Log ────────────────────────────────────────────────────────────────
router.get('/audit-log', requireAuth, asyncHandler(async (req, res) => {
    const rawLimit = parseInt(req.query.limit) || 100;
    const limit = Math.min(1000, Math.max(1, rawLimit));
    const { action, license_key } = req.query;

    // Schema is fixed: column is 'ts' and 'details'
    let query = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];
    if (action) { query += ' AND action = ?'; params.push(action); }
    if (license_key) {
        query += ` AND json_extract(details, '$.license_key') = ?`;
        params.push(license_key);
    }
    query += ' ORDER BY ts DESC LIMIT ?';
    params.push(limit);
    const [logs] = db.query(query, params);
    res.json({ logs });
}));

// ── Login Log ────────────────────────────────────────────────────────────────
router.get('/login-log', requireAuth, asyncHandler(async (req, res) => {
    try {
        const limit = Math.min(500, parseInt(req.query.limit) || 100);
        const [rows] = db.query(
            `SELECT * FROM audit_log WHERE action IN ('admin_login','admin_login_failed') ORDER BY ts DESC LIMIT ?`,
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
    const [rows] = db.query('SELECT * FROM licenses WHERE license_key = ?', [license_key]);
    const l = rows[0];
    if (!l) return res.status(404).json({ success: false });
    const [[customer]] = l.customer_id
        ? db.query(`SELECT ${CUSTOMER_SAFE_FIELDS} FROM customers WHERE id = ?`, [l.customer_id])
        : [[undefined]];
    const [devices] = db.query('SELECT * FROM devices WHERE license_key = ?', [license_key]);
    await addAuditLog('impersonate', { license_key, by: req.admin.username }, req.admin.username);
    res.json({ success: true, license: l, customer: customer || null, devices });
}));

// ── Sessions ─────────────────────────────────────────────────────────────────
router.get('/sessions', requireAuth, requireSuperAdmin, asyncHandler(async (req, res) => {
    const [adminSessions] = db.query(
        `SELECT id, admin_username AS username, 'admin' AS type, ip, created_at, expires_at
         FROM admin_sessions WHERE revoked=0 AND expires_at > datetime('now')
         ORDER BY created_at DESC LIMIT 200`
    );
    let customerSessions = [];
    try {
        const [cs] = db.query(
            `SELECT s.id, c.email AS username, 'customer' AS type, s.ip, s.created_at, s.expires_at
             FROM customer_sessions s LEFT JOIN customers c ON s.customer_id = c.id
             WHERE s.revoked=0 AND s.expires_at > datetime('now')
             ORDER BY s.created_at DESC LIMIT 200`
        );
        customerSessions = cs;
    } catch {}
    res.json({
        success: true, total: adminSessions.length + customerSessions.length,
        admin_sessions: adminSessions, customer_sessions: customerSessions
    });
}));

// ── Webhook Logs ─────────────────────────────────────────────────────────────
router.get('/webhook-logs', requireAuth, asyncHandler(async (req, res) => {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let where = '1=1';
    const params = [];
    if (status && ['success', 'failed'].includes(status)) { where += ' AND status = ?'; params.push(status); }

    const [[{ total }]] = db.query(`SELECT COUNT(*) as total FROM webhook_logs WHERE ${where}`, params);
    const [logs]        = db.query(
        `SELECT * FROM webhook_logs WHERE ${where} ORDER BY attempted_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    res.json({ success: true, logs, pagination: { page, limit, total: parseInt(total), pages: Math.ceil(total / limit) } });
}));

export default router;
