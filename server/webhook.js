import crypto from 'crypto';
import db from './db.js';

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

async function logWebhookCall(url, event, status, errorMessage = null) {
    try {
        await db.query(
            'INSERT INTO webhook_logs (id, webhook_url, event, status, error_message, attempted_at) VALUES (?, ?, ?, ?, ?, NOW())',
            [crypto.randomUUID(), url, event, status, errorMessage]
        );
    } catch (e) {
        console.error('❌ Fehler beim Schreiben des Webhook-Logs:', e.message);
    }
}

export async function fireWebhook(event, payload) {
    const urls = [];
    if (process.env.WEBHOOK_URL) urls.push({ url: process.env.WEBHOOK_URL, secret: WEBHOOK_SECRET });
    try {
        const [rows] = await db.query('SELECT url, secret FROM webhooks WHERE active = 1');
        for (const r of rows) urls.push({ url: r.url, secret: r.secret });
    } catch {}

    const body = JSON.stringify({ event, ts: new Date().toISOString(), ...payload });
    for (const { url, secret } of urls) {
        try {
            const sig = secret ? crypto.createHmac('sha256', secret).update(body).digest('hex') : null;
            const headers = { 'Content-Type': 'application/json' };
            if (sig) headers['X-OPA-Signature'] = sig;
            
            const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }
            
            await logWebhookCall(url, event, 'success');
        } catch (e) {
            console.warn(`⚠️  Webhook ${url} fehlgeschlagen:`, e.message);
            await logWebhookCall(url, event, 'failed', e.message);
        }
    }
}
