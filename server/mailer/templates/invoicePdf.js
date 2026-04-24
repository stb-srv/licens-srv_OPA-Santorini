import PDFDocument from 'pdfkit';

export function generateInvoicePdf({ invoice_number, customer_name, domain, plan_label, price_eur, date }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', c => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Header
        doc.fontSize(20).font('Helvetica-Bold').text('OPA! Santorini', 50, 50);
        doc.fontSize(10).font('Helvetica').fillColor('#6b7280')
           .text('Lizenz-Rechnung', 50, 75);

        // Rechnungsnr + Datum
        doc.fillColor('#111').fontSize(11)
           .text(`Rechnungsnummer: ${invoice_number}`, 350, 50, { align: 'right' })
           .text(`Datum: ${new Date(date).toLocaleDateString('de-DE')}`, 350, 66, { align: 'right' });

        // Linie
        doc.moveTo(50, 100).lineTo(545, 100).strokeColor('#e5e7eb').stroke();

        // Empfänger
        doc.fillColor('#111').fontSize(12).font('Helvetica-Bold')
           .text('Rechnungsempfänger', 50, 120);
        doc.font('Helvetica').fontSize(11)
           .text(customer_name || 'Kunde', 50, 140)
           .text(domain || '', 50, 155);

        // Tabelle
        doc.font('Helvetica-Bold').fontSize(11)
           .text('Beschreibung', 50, 210)
           .text('Betrag', 450, 210, { align: 'right' });
        doc.moveTo(50, 225).lineTo(545, 225).strokeColor('#111').stroke();

        doc.font('Helvetica').fontSize(11)
           .text(`OPA! Santorini – ${plan_label} Lizenz`, 50, 235)
           .text(`${price_eur.toFixed(2)} €`, 450, 235, { align: 'right' });

        const netto  = price_eur / 1.19;
        const mwst   = price_eur - netto;
        doc.text(`zzgl. 19% MwSt.`, 350, 265)
           .text(`${mwst.toFixed(2)} €`, 450, 265, { align: 'right' });
        doc.font('Helvetica-Bold')
           .text('Gesamt (brutto)', 350, 285)
           .text(`${price_eur.toFixed(2)} €`, 450, 285, { align: 'right' });

        // Footer
        doc.fontSize(9).font('Helvetica').fillColor('#9ca3af')
           .text('Vielen Dank für Ihr Vertrauen in OPA! Santorini.', 50, 720, { align: 'center' });

        doc.end();
    });
}
