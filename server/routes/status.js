import { Router } from 'express';
import db from '../db.js';

const router = Router();

router.get('/', async (req, res) => {
    const checks = {};
    let overallOk = true;

    // DB-Check
    try {
        await db.query('SELECT 1');
        checks.database = { ok: true, label: 'Datenbank' };
    } catch(e) {
        checks.database = { ok: false, label: 'Datenbank', error: e.message };
        overallOk = false;
    }

    // Lizenz-API-Check
    try {
        const [[row]] = await db.query('SELECT COUNT(*) as c FROM licenses WHERE status = "active"');
        checks.licenses = { ok: true, label: 'Lizenz-API', active_licenses: row.c };
    } catch(e) {
        checks.licenses = { ok: false, label: 'Lizenz-API', error: e.message };
        overallOk = false;
    }

    // Mailer-Check (nur ob Config vorhanden)
    const mailerOk = !!(process.env.SMTP_HOST && process.env.SMTP_USER);
    checks.mailer = { ok: mailerOk, label: 'E-Mail / SMTP', configured: mailerOk };

    const html = `<!DOCTYPE html>
    <html lang="de"><head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="60">
        <title>OPA! Lizenz-Server – Status</title>
        <style>
            body { font-family:sans-serif; max-width:600px; margin:60px auto; padding:0 24px; color:#111; background:#f3f4f6; }
            .card { background:#fff; padding:32px; border-radius:16px; box-shadow:0 4px 6px -1px rgba(0,0,0,0.1); }
            h1 { font-size:1.4rem; margin-bottom:4px; display:flex; align-items:center; gap:8px; }
            .badge { display:inline-block; padding:6px 18px; border-radius:20px; font-weight:700;
                     font-size:.9rem; margin-bottom:28px; }
            .badge.ok   { background:#dcfce7; color:#166534; }
            .badge.fail { background:#fee2e2; color:#991b1b; }
            .check { display:flex; justify-content:space-between; align-items:center;
                     padding:14px 18px; border-radius:10px; margin-bottom:10px;
                     background:#f9fafb; border:1px solid #e5e7eb; }
            .dot { width:12px; height:12px; border-radius:50%; }
            .dot.ok   { background:#16a34a; box-shadow: 0 0 8px rgba(22, 163, 74, 0.4); }
            .dot.fail { background:#dc2626; box-shadow: 0 0 8px rgba(220, 38, 38, 0.4); }
            footer { margin-top:40px; font-size:.75rem; color:#9ca3af; text-align:center; }
        </style>
    </head><body>
        <div class="card">
            <h1>🟢 OPA! Lizenz-Server</h1>
            <span class="badge ${overallOk ? 'ok' : 'fail'}">
                ${overallOk ? '✓ Alle Systeme operational' : '✗ Störung erkannt'}
            </span>
            ${Object.values(checks).map(c => `
                <div class="check">
                    <span>${c.label}</span>
                    <div class="dot ${c.ok ? 'ok' : 'fail'}"></div>
                </div>
            `).join('')}
        </div>
        <footer>Automatisch aktualisiert alle 60s · ${new Date().toLocaleString('de-DE')}</footer>
    </body></html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
});

// JSON-Endpoint für externe Monitoring-Tools
router.get('/json', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({ ok: true, ts: new Date().toISOString() });
    } catch(e) {
        res.status(503).json({ ok: false, error: e.message, ts: new Date().toISOString() });
    }
});

export default router;
