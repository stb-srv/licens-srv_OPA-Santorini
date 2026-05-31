import express from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware.js';
import { asyncHandler, addAuditLog } from '../helpers.js';
import { generateInvoiceNumber, calculateInvoiceTotals, getInvoiceWithItems } from '../invoiceHelper.js';
import { generateInvoicePDF, getInvoicePDFBuffer } from '../pdfGenerator.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const router = express.Router();

function toDbDate(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

// ── GET /invoices ────────────────────────────────────────────────────────────
router.get('/invoices', requireAuth, asyncHandler(async (req, res) => {
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit) || 25));
    const offset = (page - 1) * limit;

    let where = '1=1';
    const params = [];

    if (req.query.status)      { where += ' AND i.status = ?'; params.push(req.query.status); }
    if (req.query.customer_id) { where += ' AND i.customer_id = ?'; params.push(req.query.customer_id); }
    if (req.query.search) {
        const search = `%${req.query.search.replace(/[%_\\]/g, '\\$&')}%`;
        where += ` AND (i.invoice_number LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\')`;
        params.push(search, search, search);
    }

    const [[{ total }]] = db.query(
        `SELECT COUNT(*) AS total FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id WHERE ${where}`,
        params
    );
    const [rows] = db.query(
        `SELECT i.*, c.name AS customer_name, c.company AS customer_company
         FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id
         WHERE ${where} ORDER BY i.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );

    res.json({ invoices: rows, total: parseInt(total), page, pages: Math.ceil(total / limit) });
}));

// ── GET /invoices/:id ────────────────────────────────────────────────────────
router.get('/invoices/:id', requireAuth, asyncHandler(async (req, res) => {
    const invoice = getInvoiceWithItems(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
    res.json(invoice);
}));

// ── POST /invoices ───────────────────────────────────────────────────────────
router.post('/invoices', requireAuth, asyncHandler(async (req, res) => {
    const { customer_id, license_key, items, tax_rate, due_date, notes, type } = req.body;
    if (!customer_id)
        return res.status(400).json({ success: false, message: 'customer_id ist erforderlich.' });
    if (!items || !Array.isArray(items) || items.length === 0)
        return res.status(400).json({ success: false, message: 'Mindestens eine Position (item) ist erforderlich.' });

    const tax = tax_rate !== undefined ? parseFloat(tax_rate) : 19.00;
    const { amount_net, amount_tax, amount_gross } = calculateInvoiceTotals(items, tax);
    const invType = type || 'invoice';

    try {
        let invoiceId;
        db.runTransaction(() => {
            const invoiceNumber = generateInvoiceNumber();
            invoiceId = crypto.randomUUID();

            const [[customer]] = db.query('SELECT currency FROM customers WHERE id = ?', [customer_id]);
            if (!customer) throw new Error(`Customer with ID ${customer_id} not found.`);

            const currency = customer.currency || 'EUR';

            db.query(
                `INSERT INTO invoices (
                    id, invoice_number, customer_id, license_key, status, type,
                    amount_net, amount_tax, amount_gross, tax_rate, currency,
                    due_date, notes, created_by
                ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [invoiceId, invoiceNumber, customer_id, license_key || null, invType,
                 amount_net, amount_tax, amount_gross, tax, currency,
                 due_date || null, notes || null, req.admin.username]
            );

            let sortOrder = 0;
            for (const item of items) {
                const qty   = parseFloat(item.quantity) || 1.00;
                const price = parseFloat(item.unit_price) || 0.00;
                const itemTotal = parseFloat((qty * price).toFixed(2));
                db.query(
                    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [invoiceId, item.description, qty, price, itemTotal, sortOrder++]
                );
            }
        });

        await addAuditLog('invoice_created', { invoice_id: invoiceId, customer_id }, req.admin.username);
        const newInvoice = getInvoiceWithItems(invoiceId);
        res.status(201).json(newInvoice);
    } catch (err) {
        console.error('[admin/invoices/create] Error:', err);
        res.status(500).json({ success: false, message: `Fehler beim Erstellen der Rechnung: ${err.message}` });
    }
}));

// ── PUT /invoices/:id ────────────────────────────────────────────────────────
router.put('/invoices/:id', requireAuth, asyncHandler(async (req, res) => {
    const invoiceId = req.params.id;
    const { items, tax_rate, due_date, notes, type } = req.body;

    const [[invoice]] = db.query('SELECT status, invoice_number, customer_id FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
    if (invoice.status !== 'draft')
        return res.status(400).json({ success: false, message: 'Nur Entwurfs-Rechnungen (draft) können bearbeitet werden.' });
    if (!items || !Array.isArray(items) || items.length === 0)
        return res.status(400).json({ success: false, message: 'Mindestens eine Position (item) ist erforderlich.' });

    const tax = tax_rate !== undefined ? parseFloat(tax_rate) : 19.00;
    const { amount_net, amount_tax, amount_gross } = calculateInvoiceTotals(items, tax);
    const invType = type || 'invoice';

    try {
        db.runTransaction(() => {
            db.query('DELETE FROM invoice_items WHERE invoice_id = ?', [invoiceId]);

            let sortOrder = 0;
            for (const item of items) {
                const qty   = parseFloat(item.quantity) || 1.00;
                const price = parseFloat(item.unit_price) || 0.00;
                const itemTotal = parseFloat((qty * price).toFixed(2));
                db.query(
                    `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    [invoiceId, item.description, qty, price, itemTotal, sortOrder++]
                );
            }

            db.query(
                `UPDATE invoices SET type=?, amount_net=?, amount_tax=?, amount_gross=?, tax_rate=?,
                  due_date=?, notes=?, updated_at=datetime('now') WHERE id=?`,
                [invType, amount_net, amount_tax, amount_gross, tax, due_date || null, notes || null, invoiceId]
            );
        });

        await addAuditLog('invoice_updated', { invoice_id: invoiceId, invoice_number: invoice.invoice_number }, req.admin.username);
        res.json(getInvoiceWithItems(invoiceId));
    } catch (err) {
        console.error('[admin/invoices/update] Error:', err);
        res.status(500).json({ success: false, message: `Fehler beim Aktualisieren: ${err.message}` });
    }
}));

// ── POST /invoices/:id/send ──────────────────────────────────────────────────
router.post('/invoices/:id/send', requireAuth, asyncHandler(async (req, res) => {
    const invoiceId = req.params.id;
    const invoice = getInvoiceWithItems(invoiceId);
    if (!invoice) return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });

    const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
    if (!settings) return res.status(500).json({ success: false, message: 'Rechnungs-Einstellungen fehlen.' });

    const filename   = `Rechnung-${invoice.invoice_number}.pdf`;
    const storageDir = path.join(process.env.STORAGE_PATH || './storage', 'invoices');
    const pdfPath    = path.join(storageDir, filename);
    await generateInvoicePDF({ ...settings, ...invoice }, pdfPath);

    if (invoice.customer_email) {
        try {
            const portalUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
            const { renderTemplate } = await import('../mailer/templates.js');
            const { sendMail }       = await import('../mailer/index.js');
            const { subject, html, text } = renderTemplate('invoiceSent', {
                customer_name: invoice.customer_name, invoice_number: invoice.invoice_number,
                amount_gross: invoice.amount_gross, due_date: invoice.due_date,
                invoice_url: `${portalUrl}/portal.html?tab=invoices`
            });
            await sendMail({ to: invoice.customer_email, subject, html, text,
                attachments: [{ filename, path: pdfPath, contentType: 'application/pdf' }] });
        } catch (mailErr) {
            console.error('[admin/invoices/send] Email failed:', mailErr.message);
        }
    }

    db.query(
        `UPDATE invoices SET status='sent', sent_at=datetime('now'), pdf_path=? WHERE id=?`,
        [pdfPath, invoiceId]
    );
    await addAuditLog('invoice_sent', { invoice_id: invoiceId, invoice_number: invoice.invoice_number, customer_id: invoice.customer_id }, req.admin.username);
    res.json({ success: true, message: 'Rechnung als gesendet markiert und E-Mail verschickt.', pdf_path: pdfPath });
}));

// ── POST /invoices/:id/resend ────────────────────────────────────────────────
router.post('/invoices/:id/resend', requireAuth, asyncHandler(async (req, res) => {
    const invoiceId = req.params.id;
    const invoice = getInvoiceWithItems(invoiceId);
    if (!invoice) return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
    if (!['sent', 'overdue', 'paid'].includes(invoice.status))
        return res.status(400).json({ success: false, message: 'Rechnung kann in diesem Status nicht erneut gesendet werden.' });

    let pdfPath  = invoice.pdf_path;
    const filename   = `Rechnung-${invoice.invoice_number}.pdf`;
    const storageDir = path.join(process.env.STORAGE_PATH || './storage', 'invoices');
    if (!pdfPath || !fs.existsSync(pdfPath)) {
        pdfPath = path.join(storageDir, filename);
        const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
        if (!settings) return res.status(500).json({ success: false, message: 'Rechnungs-Einstellungen fehlen.' });
        await generateInvoicePDF({ ...settings, ...invoice }, pdfPath);
    }

    if (invoice.customer_email) {
        try {
            const portalUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
            const { renderTemplate } = await import('../mailer/templates.js');
            const { sendMail }       = await import('../mailer/index.js');
            const { subject, html, text } = renderTemplate('invoiceSent', {
                customer_name: invoice.customer_name, invoice_number: invoice.invoice_number,
                amount_gross: invoice.amount_gross, due_date: invoice.due_date,
                invoice_url: `${portalUrl}/portal.html?tab=invoices`,
                pdf_download_link: `${portalUrl}/portal.html?tab=invoices`
            });
            await sendMail({ to: invoice.customer_email, subject, html, text,
                attachments: [{ filename, path: pdfPath, contentType: 'application/pdf' }] });
        } catch (mailErr) {
            console.error('[admin/invoices/resend] Email failed:', mailErr.message);
        }
    }

    db.query(
        `UPDATE invoices SET resent_at=datetime('now'), resent_count=COALESCE(resent_count,0)+1, pdf_path=? WHERE id=?`,
        [pdfPath, invoiceId]
    );
    const newResentCount = (invoice.resent_count || 0) + 1;
    await addAuditLog('invoice_resent', { invoice_id: invoiceId, invoice_number: invoice.invoice_number, customer_id: invoice.customer_id, resent_count: newResentCount }, req.admin.username);
    res.json({ success: true, message: 'Rechnung erfolgreich erneut gesendet.', resent_count: newResentCount });
}));

// ── POST /invoices/:id/mark-paid ─────────────────────────────────────────────
router.post('/invoices/:id/mark-paid', requireAuth, asyncHandler(async (req, res) => {
    const invoiceId = req.params.id;
    const paidDate  = toDbDate(req.body.paid_at ? new Date(req.body.paid_at) : new Date());

    const [[invoice]] = db.query('SELECT invoice_number, customer_id FROM invoices WHERE id = ?', [invoiceId]);
    if (!invoice) return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });

    try {
        db.runTransaction(() => {
            db.query("UPDATE invoices SET status='paid', paid_at=? WHERE id=?", [paidDate, invoiceId]);
            db.query("UPDATE customers SET payment_status='paid' WHERE id=?", [invoice.customer_id]);
        });
        await addAuditLog('invoice_paid', { invoice_id: invoiceId, invoice_number: invoice.invoice_number, customer_id: invoice.customer_id }, req.admin.username);
        res.json({ success: true, message: 'Rechnung erfolgreich als bezahlt markiert.' });
    } catch (err) {
        console.error('[admin/invoices/mark-paid] Error:', err);
        res.status(500).json({ success: false, message: `Fehler beim Markieren als bezahlt: ${err.message}` });
    }
}));

// ── GET /invoices/:id/pdf ────────────────────────────────────────────────────
router.get('/invoices/:id/pdf', requireAuth, asyncHandler(async (req, res) => {
    const invoice = getInvoiceWithItems(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });

    const filename = `Rechnung-${invoice.invoice_number}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
        fs.createReadStream(invoice.pdf_path).pipe(res);
    } else {
        const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
        res.send(await getInvoicePDFBuffer({ ...settings, ...invoice }));
    }
}));

// ── DELETE /invoices/:id ─────────────────────────────────────────────────────
router.delete('/invoices/:id', requireAuth, asyncHandler(async (req, res) => {
    const [[invoice]] = db.query('SELECT status, invoice_number, pdf_path FROM invoices WHERE id = ?', [req.params.id]);
    if (!invoice) return res.status(404).json({ success: false, message: 'Rechnung nicht gefunden.' });
    if (invoice.status !== 'draft' && invoice.status !== 'cancelled')
        return res.status(400).json({ success: false, message: 'Nur Rechnungen im Entwurfs- (draft) oder abgebrochenen (cancelled) Status können gelöscht werden.' });

    db.query('DELETE FROM invoices WHERE id = ?', [req.params.id]);
    if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) {
        try { fs.unlinkSync(invoice.pdf_path); } catch (err) { console.warn('[admin/invoices/delete] Could not delete PDF file:', err.message); }
    }
    await addAuditLog('invoice_deleted', { invoice_id: req.params.id, invoice_number: invoice.invoice_number }, req.admin.username);
    res.json({ success: true, message: 'Rechnung erfolgreich gelöscht.' });
}));

// ── GET /invoice-settings ────────────────────────────────────────────────────
router.get('/invoice-settings', requireAuth, asyncHandler(async (req, res) => {
    const [[settings]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
    if (!settings) return res.status(404).json({ success: false, message: 'Rechnungs-Einstellungen nicht gefunden.' });
    res.json(settings);
}));

// ── PUT /invoice-settings ────────────────────────────────────────────────────
router.put('/invoice-settings', requireAuth, asyncHandler(async (req, res) => {
    const { company_name, company_address, company_tax_id, company_iban, company_bic, invoice_prefix, logo_path, footer_text } = req.body;
    if (!company_name || !company_address)
        return res.status(400).json({ success: false, message: 'company_name und company_address sind Pflichtfelder.' });

    db.query(
        `UPDATE invoice_settings SET company_name=?, company_address=?, company_tax_id=?,
          company_iban=?, company_bic=?, invoice_prefix=?, logo_path=?, footer_text=?, updated_at=datetime('now')
         WHERE id=1`,
        [company_name, company_address, company_tax_id || null,
         company_iban || null, company_bic || null, invoice_prefix || 'INV',
         logo_path || null, footer_text || null]
    );

    await addAuditLog('invoice_settings_updated', { by: req.admin.username }, req.admin.username);
    const [[updated]] = db.query('SELECT * FROM invoice_settings WHERE id = 1');
    res.json(updated);
}));

export default router;
