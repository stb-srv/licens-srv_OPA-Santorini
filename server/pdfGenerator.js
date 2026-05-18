import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';

/**
 * Format currency in EUR format
 * @param {number} val - Amount
 * @returns {string} Formatted string
 */
function formatCurrency(val) {
    return `${(parseFloat(val) || 0).toFixed(2)} €`;
}

/**
 * Format date in German format (DD.MM.YYYY)
 * @param {string|Date} dateVal - Date
 * @returns {string} Formatted string
 */
function formatDate(dateVal) {
    if (!dateVal) return '';
    const date = new Date(dateVal);
    if (isNaN(date.getTime())) return '';
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const y = date.getFullYear();
    return `${d}.${m}.${y}`;
}

/**
 * Builds the PDF invoice layout on the given doc document instance.
 * @param {object} invoiceData - Invoice details joined with settings
 * @param {PDFDocument} doc - PDFKit document instance
 */
function buildPDFLayout(invoiceData, doc) {
    const primaryColor = '#1a2740';
    const textColor = '#1f2937';
    const lightGray = '#9ca3af';
    const borderColor = '#e5e7eb';

    // --- SENDER INFO (Top Left) ---
    doc.fillColor(primaryColor).fontSize(14).font('Helvetica-Bold');
    doc.text(invoiceData.company_name || 'OPA! Santorini', 50, 50);
    
    doc.fillColor(textColor).fontSize(8.5).font('Helvetica');
    const addressLines = (invoiceData.company_address || '').split('\n').filter(Boolean);
    let addressY = 68;
    for (const line of addressLines) {
        doc.text(line.trim(), 50, addressY);
        addressY += 12;
    }

    // --- INVOICE DETAILS (Top Right) ---
    doc.fillColor(primaryColor).fontSize(14).font('Helvetica-Bold');
    const docTypeLabel = invoiceData.type === 'credit_note' ? 'GUTSCHRIFT' : 
                         (invoiceData.type === 'reminder' ? 'MAHNUNG' : 'RECHNUNG');
    doc.text(docTypeLabel, 350, 50, { align: 'right', width: 195 });

    doc.fillColor(textColor).fontSize(9).font('Helvetica');
    let detailsY = 68;
    doc.text('Rechnungsnr.:', 350, detailsY, { align: 'right', width: 95 });
    doc.font('Helvetica-Bold').text(invoiceData.invoice_number || '', 450, detailsY, { align: 'right', width: 95 });
    
    doc.font('Helvetica');
    detailsY += 14;
    doc.text('Datum:', 350, detailsY, { align: 'right', width: 95 });
    doc.text(formatDate(invoiceData.created_at || new Date()), 450, detailsY, { align: 'right', width: 95 });

    if (invoiceData.due_date) {
        detailsY += 14;
        doc.text('Fälligkeitsdatum:', 350, detailsY, { align: 'right', width: 95 });
        doc.font('Helvetica-Bold').text(formatDate(invoiceData.due_date), 450, detailsY, { align: 'right', width: 95 });
    }

    // --- RECIPIENT INFO ---
    doc.moveTo(50, 140).lineTo(545, 140).strokeColor(borderColor).lineWidth(1).stroke();
    
    doc.fillColor(lightGray).fontSize(7.5).font('Helvetica-Bold').text('RECHNUNGSEMPFÄNGER', 50, 152);
    
    doc.fillColor(textColor).fontSize(9.5).font('Helvetica-Bold');
    let recipientY = 166;
    if (invoiceData.customer_company) {
        doc.text(invoiceData.customer_company, 50, recipientY);
        recipientY += 13;
        doc.font('Helvetica').text(invoiceData.customer_name || '', 50, recipientY);
        recipientY += 13;
    } else {
        doc.text(invoiceData.customer_name || '', 50, recipientY);
        recipientY += 13;
    }

    doc.font('Helvetica');
    if (invoiceData.customer_billing_address) {
        const billAddressLines = (invoiceData.customer_billing_address || '').split('\n').filter(Boolean);
        for (const line of billAddressLines) {
            doc.text(line.trim(), 50, recipientY);
            recipientY += 13;
        }
    }
    if (invoiceData.customer_country && recipientY < 225) {
        doc.text(invoiceData.customer_country, 50, recipientY);
        recipientY += 13;
    }

    // --- TABLE HEADERS ---
    let tableY = 245;
    doc.moveTo(50, tableY).lineTo(545, tableY).strokeColor(primaryColor).lineWidth(1.5).stroke();
    tableY += 8;

    doc.fillColor(primaryColor).fontSize(8.5).font('Helvetica-Bold');
    doc.text('Pos.', 50, tableY, { width: 30 });
    doc.text('Beschreibung', 90, tableY, { width: 250 });
    doc.text('Menge', 350, tableY, { width: 50, align: 'center' });
    doc.text('Einzelpreis', 410, tableY, { width: 65, align: 'right' });
    doc.text('Gesamt', 485, tableY, { width: 60, align: 'right' });

    tableY += 14;
    doc.moveTo(50, tableY).lineTo(545, tableY).strokeColor(borderColor).lineWidth(1).stroke();
    tableY += 8;

    // --- TABLE ITEMS ---
    doc.fillColor(textColor).fontSize(8.5).font('Helvetica');
    const items = invoiceData.items || [];
    let index = 1;
    for (const item of items) {
        doc.text(String(index++), 50, tableY, { width: 30 });
        doc.text(item.description || '', 90, tableY, { width: 250 });
        doc.text(parseFloat(item.quantity).toFixed(1), 350, tableY, { width: 50, align: 'center' });
        doc.text(formatCurrency(item.unit_price), 410, tableY, { width: 65, align: 'right' });
        doc.text(formatCurrency(item.total), 485, tableY, { width: 60, align: 'right' });

        tableY += 18;
        doc.moveTo(50, tableY).lineTo(545, tableY).strokeColor(borderColor).lineWidth(0.5).stroke();
        tableY += 8;
    }

    // --- SUMS BLOCK (Right Aligned) ---
    tableY += 5;
    doc.fontSize(8.5).font('Helvetica');
    doc.text('Netto:', 350, tableY, { width: 100, align: 'right' });
    doc.text(formatCurrency(invoiceData.amount_net), 460, tableY, { width: 85, align: 'right' });

    tableY += 14;
    doc.text(`zzgl. ${parseFloat(invoiceData.tax_rate || 19.00).toFixed(1)}% MwSt.:`, 350, tableY, { width: 100, align: 'right' });
    doc.text(formatCurrency(invoiceData.amount_tax), 460, tableY, { width: 85, align: 'right' });

    tableY += 14;
    doc.moveTo(350, tableY).lineTo(545, tableY).strokeColor(borderColor).lineWidth(1).stroke();
    tableY += 6;

    doc.fontSize(9.5).font('Helvetica-Bold').fillColor(primaryColor);
    doc.text('Gesamtbetrag:', 350, tableY, { width: 100, align: 'right' });
    doc.text(formatCurrency(invoiceData.amount_gross), 460, tableY, { width: 85, align: 'right' });

    // --- EXTRA NOTES ---
    if (invoiceData.notes) {
        tableY += 35;
        doc.fillColor(lightGray).fontSize(7.5).font('Helvetica-Bold').text('BEMERKUNGEN / HINWEISE', 50, tableY);
        tableY += 12;
        doc.fillColor(textColor).fontSize(7.5).font('Helvetica').text(invoiceData.notes, 50, tableY, { width: 280 });
    }

    // --- FOOTER BLOCK ---
    const footerY = 730;
    doc.moveTo(50, footerY).lineTo(545, footerY).strokeColor(borderColor).lineWidth(1).stroke();
    
    const colWidth = 155;
    const footerTextSize = 7.5;
    doc.fillColor(textColor).fontSize(footerTextSize).font('Helvetica');

    // Column 1: Company details
    doc.text(invoiceData.company_name || 'OPA! Santorini', 50, footerY + 10, { width: colWidth });
    if (invoiceData.company_tax_id) {
        doc.text(`Steuernummer / USt-IdNr.: ${invoiceData.company_tax_id}`, 50, footerY + 22, { width: colWidth });
    }

    // Column 2: Bank connection
    if (invoiceData.company_iban) {
        doc.text('Bankverbindung:', 220, footerY + 10, { width: colWidth });
        doc.text(`IBAN: ${invoiceData.company_iban}`, 220, footerY + 22, { width: colWidth });
        if (invoiceData.company_bic) {
            doc.text(`BIC: ${invoiceData.company_bic}`, 220, footerY + 32, { width: colWidth });
        }
    }

    // Column 3: Custom footer text or generic message
    const defaultFooterText = 'Vielen Dank für Ihre Bestellung und das Vertrauen in OPA! Santorini Restaurant-Management-System.';
    doc.fillColor(lightGray).fontSize(6.5).text(invoiceData.footer_text || defaultFooterText, 390, footerY + 10, { width: 155, align: 'right' });
}

/**
 * Generates an invoice PDF as a Buffer in-memory.
 * @param {object} invoiceData - Invoice details joined with settings
 * @returns {Promise<Buffer>} PDF Buffer
 */
export async function getInvoicePDFBuffer(invoiceData) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const chunks = [];
            
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', err => reject(err));
            
            buildPDFLayout(invoiceData, doc);
            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

/**
 * Generates an invoice PDF and saves it to the local filesystem.
 * @param {object} invoiceData - Invoice details joined with settings
 * @param {string} outputPath - Output file path
 * @returns {Promise<string>} Saved PDF file path
 */
export async function generateInvoicePDF(invoiceData, outputPath) {
    const dir = path.dirname(outputPath);
    await fs.promises.mkdir(dir, { recursive: true });

    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50, size: 'A4' });
            const writeStream = fs.createWriteStream(outputPath);
            
            doc.pipe(writeStream);
            buildPDFLayout(invoiceData, doc);
            doc.end();
            
            writeStream.on('finish', () => resolve(outputPath));
            writeStream.on('error', err => reject(err));
        } catch (err) {
            reject(err);
        }
    });
}
