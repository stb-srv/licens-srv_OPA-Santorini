import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db.js';
import { buildTransporter, sendTemplateMail, getActiveSmtpConfig } from '../mailer/index.js';
import { PLAN_DEFINITIONS } from '../plans.js';
import { addAuditLog } from '../helpers.js';
import { requireAuth, requireSuperAdmin, asyncHandler, MIN_PASSWORD_LENGTH } from '../middleware.js';

const router = Router();

// ── Plans ────────────────────────────────────────────────────────────────────
router.get('/plans', requireAuth, (req, res) => res.json(PLAN_DEFINITIONS));

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
    
    await db.query(
      'UPDATE admin_sessions SET revoked = 1 WHERE admin_username = ? AND token_hash != ?',
      [req.params.username, req.adminTokenHash || 'none']
    );

    await addAuditLog('admin_password_changed', { username: req.params.username, by: req.admin.username }, req.admin.username);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
}));

// ── SMTP Config ──────────────────────────────────────────────────────────────
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

// ── Webhooks Config ──────────────────────────────────────────────────────────
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

router.get('/webhooks/signing-info', requireAuth, (req, res) => {
  res.json({
    success: true,
    algorithm: 'HMAC-SHA256', header: 'X-OPA-Signature',
    description: 'Jeder Webhook-Request enthält den Header "X-OPA-Signature" (wenn ein Secret konfiguriert ist).'
  });
});

export default router;
