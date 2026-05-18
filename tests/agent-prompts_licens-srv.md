# KI-Agent Prompt-Plan: licens-srv_OPA-Santorini

**Projekt:** `stb-srv/licens-srv_OPA-Santorini`
**Ziel:** Vollständiges Rechnungswesen + Code-Verbesserungen
**Prinzip:** Jeder Prompt baut auf dem vorherigen auf. Nicht überspringen!

---

## Phase 1 — Datenbank-Fundament

### Prompt 1.1 — Migration: Kunden-Erweiterung

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

AUFGABE:
Erstelle eine neue Migration-Datei unter `server/migrations/` für die Erweiterung der `customers`-Tabelle.

ANFORDERUNGEN:
- Dateiname: `003_customers_billing.js` (schau vorher welche Migrations-Nummern bereits existieren und passe die Nummer an)
- Füge folgende Spalten zur `customers`-Tabelle hinzu (ALTER TABLE, nur wenn nicht vorhanden):
  - `billing_address` TEXT DEFAULT NULL — Rechnungsadresse (Straße, PLZ, Stadt, Land, mehrzeilig)
  - `tax_id` VARCHAR(64) DEFAULT NULL — Steuernummer / USt-IdNr.
  - `country` VARCHAR(64) DEFAULT NULL — Pflichtfeld für EU-Steuerlogik
  - `currency` VARCHAR(8) DEFAULT 'EUR' — Standardwährung des Kunden
- Nutze das bestehende Migrations-Pattern aus `server/migrate.js`
- Füge `up()` und `down()` Funktionen hinzu
- Exportiere die Migration als ES-Module (import/export)

KONTEXT:
- Das Projekt nutzt MySQL mit `mysql2/promise`
- Migrations laufen über `server/migrate.js`
- Bestehende Migration-Dateien findest du unter `server/migrations/`

Gib den vollständigen Code der Migration-Datei aus.
```

---

### Prompt 1.2 — Migration: Rechnungstabellen

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

VORAUSSETZUNG: Prompt 1.1 (Migration 003_customers_billing.js) wurde bereits ausgeführt.

AUFGABE:
Erstelle eine neue Migration-Datei `004_invoices.js` unter `server/migrations/`.

ANFORDERUNGEN — Tabelle `invoices`:
```sql
invoice_number  VARCHAR(32) UNIQUE NOT NULL  -- z.B. "2025-0001"
customer_id     CHAR(36) NOT NULL            -- FK auf customers.id
license_key     VARCHAR(64) DEFAULT NULL     -- optional FK auf licenses.license_key
status          ENUM('draft','sent','paid','overdue','cancelled') DEFAULT 'draft'
type            ENUM('invoice','credit_note','reminder') DEFAULT 'invoice'
amount_net      DECIMAL(10,2) NOT NULL
amount_tax      DECIMAL(10,2) NOT NULL DEFAULT 0.00
amount_gross    DECIMAL(10,2) NOT NULL
tax_rate        DECIMAL(5,2) NOT NULL DEFAULT 19.00
currency        VARCHAR(8) NOT NULL DEFAULT 'EUR'
due_date        DATE DEFAULT NULL
paid_at         DATETIME DEFAULT NULL
sent_at         DATETIME DEFAULT NULL
notes           TEXT DEFAULT NULL
pdf_path        VARCHAR(512) DEFAULT NULL    -- Pfad zur gespeicherten PDF-Datei
created_by      VARCHAR(64) DEFAULT 'system'
created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
updated_at      DATETIME DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP
```

ANFORDERUNGEN — Tabelle `invoice_items`:
```sql
id           INT AUTO_INCREMENT PRIMARY KEY
invoice_id   INT NOT NULL  -- FK auf invoices.id
description  VARCHAR(512) NOT NULL
quantity     DECIMAL(10,2) NOT NULL DEFAULT 1
unit_price   DECIMAL(10,2) NOT NULL
total        DECIMAL(10,2) NOT NULL
sort_order   INT DEFAULT 0
```

ANFORDERUNGEN — Tabelle `invoice_settings`:
```sql
id              INT PRIMARY KEY DEFAULT 1
company_name    VARCHAR(255)
company_address TEXT
company_tax_id  VARCHAR(64)
company_iban    VARCHAR(64)
company_bic     VARCHAR(32)
invoice_prefix  VARCHAR(16) DEFAULT 'INV'    -- Nummernkreis-Präfix
next_number     INT DEFAULT 1               -- Laufende Nummer
logo_path       VARCHAR(512)
footer_text     TEXT
updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
```

ZUSÄTZLICH:
- Alle FKs mit ON DELETE CASCADE / ON DELETE SET NULL korrekt setzen
- INDEX auf `invoices.customer_id`, `invoices.status`, `invoices.due_date`
- `up()` und `down()` Funktionen
- ES-Module (import/export)

Gib den vollständigen Code der Migration-Datei aus.
```

---

## Phase 2 — Backend: Hilfs-Funktionen

### Prompt 2.1 — Invoice Helper & Nummerngenerierung

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

VORAUSSETZUNG: Prompts 1.1 und 1.2 wurden ausgeführt (Tabellen existieren).

AUFGABE:
Erstelle die Datei `server/invoiceHelper.js` mit folgenden Funktionen:

1. `generateInvoiceNumber(db)` — async
   - Liest `invoice_settings` (id=1) und baut die Nummer: `{prefix}-{YYYY}-{next_number padded 4 digits}`
   - Beispiel: Prefix="INV", Jahr=2025, next_number=7 → "INV-2025-0007"
   - Erhöht `next_number` in `invoice_settings` um 1 (atomic via UPDATE)
   - Gibt die generierte Nummer zurück

2. `calculateInvoiceTotals(items, taxRate)` — sync
   - items: Array mit { quantity, unit_price }
   - taxRate: z.B. 19.00
   - Gibt zurück: { amount_net, amount_tax, amount_gross } als DECIMAL gerundet auf 2 Stellen

3. `createInvoiceFromLicense(db, licenseKey, createdBy)` — async
   - Liest Lizenz + Kundendaten aus DB
   - Ermittelt Preis anhand des Lizenztyps aus `server/plans.js`
   - Erstellt automatisch eine `invoice` + ein `invoice_item` (Lizenzgebühr)
   - Nutzt `generateInvoiceNumber()`
   - Gibt die erstellte invoice_id zurück

4. `getInvoiceWithItems(db, invoiceId)` — async
   - Joined invoice + invoice_items + customer
   - Gibt vollständiges Invoice-Objekt zurück

KONTEXT:
- DB-Pool wird über `import db from './db.js'` eingebunden (der Helper bekommt db als Parameter)
- Lizenzpläne und Preise stehen in `server/plans.js` — lies die Datei vorher
- Nutze ES-Module (import/export)
- Fehlerbehandlung mit try/catch und aussagekräftigen Error-Messages

Gib den vollständigen Code von `server/invoiceHelper.js` aus.
```

---

### Prompt 2.2 — PDF-Generierung

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

VORAUSSETZUNG: Prompt 2.1 (`server/invoiceHelper.js`) wurde erstellt.

AUFGABE:
Erstelle die Datei `server/pdfGenerator.js` für die Rechnungs-PDF-Generierung.

ANFORDERUNGEN:
- Nutze das npm-Package `pdfkit` (füge es zu package.json hinzu)
- Funktion: `generateInvoicePDF(invoiceData, outputPath)` — async
  - invoiceData: Objekt aus `getInvoiceWithItems()` + `invoice_settings`
  - outputPath: z.B. `./storage/invoices/INV-2025-0001.pdf`
  - Erstelle das Verzeichnis automatisch falls es nicht existiert (`fs.mkdirSync`)

PDF-LAYOUT (professionell, deutsch):
- Oben links: Firmenname + Adresse aus `invoice_settings`
- Oben rechts: Rechnungsnummer, Datum, Fälligkeitsdatum
- Kundendaten: Name, Firma, billing_address
- Tabelle: Position | Beschreibung | Menge | Einzelpreis | Gesamt
- Summenblock: Netto, MwSt. (XX %), Brutto — rechtsbündig
- Fußzeile: IBAN, BIC, Steuernummer, footer_text
- Schriftart: Helvetica (eingebaut in pdfkit, kein externen Font nötig)
- Farben: Professionelles Grau/Dunkelblau (#1a2740)

ZUSÄTZLICH:
- Funktion: `getInvoicePDFBuffer(invoiceData)` — async
  - Gleiche Logik aber gibt Buffer zurück (für direkten HTTP-Download ohne Dateispeicherung)

KONTEXT:
- Nutze `import PDFDocument from 'pdfkit'`
- ES-Module (import/export)
- Alle Geldbeträge mit `toFixed(2)` + ' €' formatieren
- Datum-Formatierung: deutsches Format (TT.MM.YYYY)

Gib den vollständigen Code von `server/pdfGenerator.js` aus und die aktualisierte `package.json` mit pdfkit-Dependency.
```

---

## Phase 3 — Backend: API-Routen

### Prompt 3.1 — Admin Invoice Routes

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

VORAUSSETZUNG: Prompts 2.1 und 2.2 wurden erstellt (invoiceHelper.js, pdfGenerator.js existieren).

AUFGABE:
Erstelle die Datei `server/routes/admin-invoices.js` mit vollständigen CRUD-Routen für das Rechnungsmanagement.

ROUTEN (alle mit Admin-Auth-Middleware geschützt — nutze das bestehende Middleware-Pattern aus `server/middleware.js`):

GET    /admin/invoices
  - Pagination: ?page=1&limit=25
  - Filter: ?status=paid|sent|draft|overdue|cancelled
  - Filter: ?customer_id=xxx
  - Suche: ?search=Rechnungsnummer oder Kundenname
  - Rückgabe: { invoices: [...], total, page, pages }

GET    /admin/invoices/:id
  - Vollständige Rechnung mit items + Kundendaten
  - Rückgabe: vollständiges Invoice-Objekt

POST   /admin/invoices
  - Body: { customer_id, license_key?, items: [{description, quantity, unit_price}], tax_rate?, due_date?, notes?, type? }
  - Nutzt generateInvoiceNumber() und calculateInvoiceTotals()
  - Erstellt invoice + invoice_items in einer Transaktion
  - Schreibt audit_log Eintrag (Aktion: 'invoice_created')
  - Rückgabe: erstellte invoice

PUT    /admin/invoices/:id
  - Nur erlaubt wenn status = 'draft'
  - Aktualisiert items (löscht alle alten, fügt neue ein)
  - Rekalkuliert Summen
  - Schreibt audit_log

POST   /admin/invoices/:id/send
  - Setzt status = 'sent', sent_at = NOW()
  - Generiert PDF via generateInvoicePDF(), speichert Pfad in pdf_path
  - Sendet PDF per E-Mail an Kunden via sendTemplateMail (Template: 'invoiceSent')
  - Schreibt audit_log

POST   /admin/invoices/:id/mark-paid
  - Body: { paid_at? } — optional manuelles Datum
  - Setzt status = 'paid', paid_at = NOW() oder übergebenem Datum
  - Aktualisiert customer.payment_status = 'paid'
  - Schreibt audit_log

GET    /admin/invoices/:id/pdf
  - Streamt PDF als HTTP-Response (Content-Type: application/pdf)
  - Wenn pdf_path vorhanden: aus Datei lesen
  - Sonst: on-the-fly via getInvoicePDFBuffer() generieren
  - Header: Content-Disposition: attachment; filename="Rechnung-{invoice_number}.pdf"

DELETE /admin/invoices/:id
  - Nur erlaubt wenn status = 'draft' oder 'cancelled'
  - Löscht invoice + items (CASCADE)
  - Schreibt audit_log

GET    /admin/invoice-settings
  - Gibt aktuelle invoice_settings zurück

PUT    /admin/invoice-settings
  - Aktualisiert invoice_settings
  - Validiert Pflichtfelder (company_name, company_address)

KONTEXT:
- Importiere db aus '../db.js'
- Importiere invoiceHelper aus '../invoiceHelper.js'
- Importiere pdfGenerator aus '../pdfGenerator.js'
- Nutze addAuditLog aus '../helpers.js'
- Nutze sendTemplateMail aus '../mailer/index.js'
- Alle Fehler mit try/catch, HTTP-Status-Codes korrekt (400, 404, 409, 500)
- ES-Module (import/export)

Gib den vollständigen Code von `server/routes/admin-invoices.js` aus.
```

---

### Prompt 3.2 — Kunden-Portal Invoice Routes

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

VORAUSSETZUNG: Prompts 3.1 wurde erstellt.

AUFGABE:
Erweitere die bestehende Datei `server/routes/customer-portal.js` um Rechnungs-Routen für den eingeloggten Kunden.

LES ZUERST die komplette aktuelle `customer-portal.js` und füge dann folgende Routen hinzu (ohne bestehende Routen zu verändern):

GET /customer-portal/invoices
  - Nur Rechnungen des eingeloggten Kunden (customer_id aus Session)
  - Nur status IN ('sent', 'paid', 'overdue') — kein 'draft' für Kunden sichtbar
  - Pagination: ?page=1&limit=10
  - Rückgabe: { invoices: [{ invoice_number, status, amount_gross, due_date, paid_at, created_at }], total }

GET /customer-portal/invoices/:id
  - Nur eigene Rechnung (customer_id prüfen!)
  - Vollständige Rechnung mit items
  - 403 wenn fremde Rechnung

GET /customer-portal/invoices/:id/pdf
  - Nur eigene Rechnung
  - PDF-Download (gleiche Logik wie Admin-Route)

KONTEXT:
- Nutze die bestehende Customer-Auth-Middleware aus der customer-portal.js
- customer_id aus req.customer.id oder ähnlich (schau in der Datei nach)
- Importiere invoiceHelper und pdfGenerator
- ES-Module

Gib den vollständigen aktualisierten Code von `server/routes/customer-portal.js` aus (mit den neuen Routen unten angehängt).
```

---

## Phase 4 — Automatisierungen

### Prompt 4.1 — Cron: Auto-Rechnungen & Mahnungen

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

VORAUSSETZUNG: Alle vorherigen Prompts wurden ausgeführt.

AUFGABE:
Erweitere `server/cron.js` um zwei neue Cron-Funktionen. LES ZUERST die aktuelle cron.js vollständig.

NEUE FUNKTION 1: `runOverdueInvoicesCron()`
- Sucht alle Rechnungen mit:
  - status = 'sent'
  - due_date < NOW()
- Setzt diese auf status = 'overdue'
- Für jede überfällige Rechnung:
  - Aktualisiert customer.payment_status = 'overdue'
  - Sendet Mahnungs-E-Mail via sendTemplateMail('invoiceOverdue', email, {...})
  - Schreibt audit_log mit action: 'invoice_overdue'
  - Ruft fireWebhook('invoice.overdue', {...}) auf
- Fehlerbehandlung: einzelne Fehler dürfen den gesamten Loop nicht stoppen

NEUE FUNKTION 2: `runAutoInvoicesCron()`
- Sucht Lizenzen die:
  - status = 'active'
  - type != 'FREE'
  - In den letzten 24h verlängert wurden (anhand eines zu ergänzenden Feldes `last_renewed_at` — prüfe ob es existiert, falls nicht: Logik überspringen und Kommentar hinterlassen)
  - Noch keine Rechnung für diese Verlängerung haben
- Für jede passende Lizenz:
  - Ruft createInvoiceFromLicense(db, licenseKey, 'system') auf
  - Schreibt audit_log

IN `startCron()`:
- Beide neuen Funktionen registrieren:
  - `runOverdueInvoicesCron`: täglich (alle 24h), sofort beim Start ausführen
  - `runAutoInvoicesCron`: täglich (alle 24h), 1 Minute nach Start ausführen

KONTEXT:
- Importiere createInvoiceFromLicense aus './invoiceHelper.js'
- Bestehende Funktionen NICHT verändern
- ES-Module

Gib den vollständigen aktualisierten Code von `server/cron.js` aus.
```

---

### Prompt 4.2 — Mail-Template: Rechnung & Mahnung

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

AUFGABE:
Lese zuerst den Ordner `server/mailer/` vollständig (alle Dateien) um das bestehende Template-System zu verstehen.

Erstelle dann folgende neuen E-Mail-Templates im bestehenden Format:

TEMPLATE 1: `invoiceSent`
Variablen: customer_name, invoice_number, amount_gross, due_date, invoice_url (Link zum Kunden-Portal)
Betreff: "Ihre Rechnung {invoice_number} von OPA! Santorini"
Inhalt: Professionelle deutsche Rechnungsbenachrichtigung, PDF ist angehängt, Link zum Kunden-Portal

TEMPLATE 2: `invoiceOverdue`
Variablen: customer_name, invoice_number, amount_gross, due_date, days_overdue, invoice_url
Betreff: "Zahlungserinnerung: Rechnung {invoice_number} ist überfällig"
Inhalt: Freundliche aber klare Mahnung auf Deutsch

TEMPLATE 3: `licenseExpiring7d` (eigenes Template statt Wiederverwendung von licenseExpiringSoon)
Variablen: customer_name, license_key, type, expires_at, days_left
Betreff: "Ihre Lizenz läuft in {days_left} Tagen ab – Jetzt verlängern"
Inhalt: Dringenderer Ton als 30-Tage-Mail

KONTEXT:
- Nutze exakt das gleiche Format/Exportsystem wie die bestehenden Templates
- Alle Mails auf Deutsch
- HTML + Text-Fallback falls das bestehende System das unterstützt

Gib die vollständigen neuen Template-Dateien aus.
```

---

## Phase 5 — Server-Integration & Registrierung

### Prompt 5.1 — server.js Integration

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

AUFGABE:
Lese die aktuelle `server.js` vollständig.

Führe dann folgende Änderungen durch:

1. NEUE ROUTE REGISTRIEREN:
   - Importiere `adminInvoiceRoutes` aus `./server/routes/admin-invoices.js`
   - Registriere sie: `app.use('/api', adminInvoiceRoutes)` (oder dem bestehenden Präfix-Muster entsprechend)

2. STORAGE-VERZEICHNIS SICHERSTELLEN:
   - Füge beim Server-Start hinzu:
     ```js
     import fs from 'fs';
     fs.mkdirSync('./storage/invoices', { recursive: true });
     ```

3. STATISCHE PDF-AUSLIEFERUNG ABSICHERN:
   - Falls `./storage/invoices` als static-Pfad freigegeben wird: NICHT tun — PDFs nur über Auth-Routen ausliefern

4. MIGRATIONS BEI START:
   - Prüfe ob Migrationen beim Server-Start automatisch laufen (schau in server.js)
   - Falls nicht: Kommentiere deutlich im Code wo `node server/migrate.js` manuell ausgeführt werden muss

Gib den vollständigen aktualisierten Code von `server.js` aus.
```

---

## Phase 6 — Refactoring & Sicherheit

### Prompt 6.1 — admin.js aufteilen

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

AUFGABE:
Die Datei `server/routes/admin.js` ist ca. 70 KB groß und muss aufgeteilt werden.

LES ZUERST die komplette `server/routes/admin.js`.

Teile sie auf in folgende Dateien (bewahre alle bestehenden Funktionen, ändere keine Logik):
- `server/routes/admin-licenses.js` — alle Routen rund um Lizenzen
- `server/routes/admin-customers.js` — alle Routen rund um Kunden
- `server/routes/admin-settings.js` — SMTP, Webhooks, System-Einstellungen, Admin-Verwaltung
- `server/routes/admin-stats.js` — Dashboard-Statistiken, Analytics

DANN aktualisiere `server/routes/admin.js` so dass sie nur noch als zentraler Router fungiert:
```js
import adminLicenses  from './admin-licenses.js';
import adminCustomers from './admin-customers.js';
import adminSettings  from './admin-settings.js';
import adminStats     from './admin-stats.js';
import adminInvoices  from './admin-invoices.js';

router.use('/', adminLicenses);
router.use('/', adminCustomers);
router.use('/', adminSettings);
router.use('/', adminStats);
router.use('/', adminInvoices);

export default router;
```

WICHTIG: Keine Route-Logik darf verloren gehen. Alle Middleware-Importe in jede Sub-Datei mitnehmen.

Gib alle neuen Dateien vollständig aus.
```

---

### Prompt 6.2 — Sicherheits-Fixes

```
Du bist ein Node.js/MySQL Fullstack-Entwickler und arbeitest am Projekt:
GitHub: stb-srv/licens-srv_OPA-Santorini

AUFGABE:
Führe folgende Sicherheits-Verbesserungen durch:

1. `setup-db.js` — Ersetze das Hardcoded-Passwort:
   - Aktuell: bcrypt.hash('admin123', 12)
   - Neu: Lese Passwort aus process.env.ADMIN_INIT_PASSWORD
   - Falls nicht gesetzt: Generiere ein zufälliges 16-Zeichen-Passwort und gib es einmalig in der Konsole aus
   - Füge ADMIN_INIT_PASSWORD zum .env.example hinzu

2. `debug-admin.js` — Füge folgende Warnung am Anfang der Datei ein:
   ```js
   if (process.env.NODE_ENV === 'production') {
     console.error('⛔ debug-admin.js darf in production NICHT ausgeführt werden!');
     process.exit(1);
   }
   ```

3. `.gitignore` — Prüfe ob `storage/` bereits ignoriert wird. Falls nicht: füge hinzu:
   ```
   storage/
   *.pdf
   ```

4. `.env.example` — Füge fehlende Variablen hinzu:
   - ADMIN_INIT_PASSWORD=
   - STORAGE_PATH=./storage
   - APP_URL=http://localhost:3000  (für Links in E-Mails)

Gib alle geänderten Dateien vollständig aus.
```

---

## Ausführungsreihenfolge (Zusammenfassung)

| Schritt | Prompt | Datei(en) | Abhängigkeit |
|---------|--------|-----------|--------------|
| 1 | 1.1 | `server/migrations/003_customers_billing.js` | Keine |
| 2 | 1.2 | `server/migrations/004_invoices.js` | Schritt 1 |
| 3 | 2.1 | `server/invoiceHelper.js` | Schritt 2 |
| 4 | 2.2 | `server/pdfGenerator.js` + `package.json` | Schritt 3 |
| 5 | 3.1 | `server/routes/admin-invoices.js` | Schritt 4 |
| 6 | 3.2 | `server/routes/customer-portal.js` | Schritt 5 |
| 7 | 4.1 | `server/cron.js` | Schritt 5 |
| 8 | 4.2 | `server/mailer/` Templates | Schritt 5 |
| 9 | 5.1 | `server.js` | Schritte 5–8 |
| 10 | 6.1 | admin.js aufteilen | Schritt 9 |
| 11 | 6.2 | Sicherheits-Fixes | Schritt 9 |

---

## Hinweise für den Agenten (nach jeder Phase)

Nach Phase 1 (Schritte 1–2): Migrationen ausführen mit `node server/migrate.js`

Nach Phase 2 (Schritte 3–4): `npm install pdfkit` ausführen

Nach Phase 5 (Schritt 9): Server neu starten und alle neuen Endpunkte mit einem HTTP-Client testen

Nach Phase 6 (Schritte 10–11): Regression-Test — alle bestehenden Admin-Routen prüfen ob sie noch funktionieren

