# OPA-Santorini License Server

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D%2018-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)
![Status](https://img.shields.io/badge/Status-Production-success)

---

## 2. Kurzbeschreibung

Der **OPA-Santorini License Server** ist der zentrale REST-API-Lizenzserver für das [OPA-Santorini Restaurant-Management-System (CMS)](https://github.com/stb-srv/OPA-Sanatori). Er dient zur sicheren Verwaltung, Validierung und Überwachung von Lizenzen für registrierte CMS-Instanzen und stellt sicher, dass lizenzierte Restaurant-Features und Gerätelimits eingehalten werden. Durch signierte kryptografische Tokens ermöglicht er sowohl hochsichere Echtzeit-Validierungen als auch zeitlich begrenzte Offline-Freischaltungen für Restaurant-Instanzen vor Ort.

---

## 3. Features

* **🔑 Lizenzverwaltung & Validierung:** Vollwertiges Key-Management mit Unterstützung von Typen (TRIAL, FREE, BASIC, PRO, ENTERPRISE), Domain-Binding (mit Wildcard-Support) und automatischen Validierungs-Checks.
* **🧑‍💼 Integriertes Kunden-Portal:** Dedizierter Bereich für Kunden zur Profilverwaltung, zum Ändern ihrer Rechnungsadresse und zum Verwalten verknüpfter Domains und Lizenzen.
* **🧾 Automatisches Rechnungssystem:** Dynamische Generierung von Rechnungen bei Lizenz-Erstellung oder -Verlängerung inklusive Mahnwesen-Cronjob für überfällige Posten.
* **📄 PDF-Generierung:** Automatisierte Erstellung professioneller Rechnungs-PDFs via `pdfkit` mit konfigurierbarem Design, Firmenlogo und Steuerangaben.
* **🤝 Reseller-System:** Dedizierte Endpunkte für Reseller zur automatisierten Lizenzbestellung und -ausgabe über verschlüsselte API-Keys.
* **🔐 Zwei-Faktor-Authentifizierung (2FA):** Optionale Absicherung von Superadmin- und Admin-Accounts mittels zeitbasierter Einmalpasswörter (TOTP/Google Authenticator) inklusive QR-Code-Setup.
* **📡 Webhooks & Logs:** Event-getriebene HTTP POST Notifications an Drittsysteme bei Lizenz- oder Rechnungsereignissen inklusive detailliertem Logging.
* **⏰ Zuverlässige Cron-Jobs:** Automatische Bereinigung abgelaufener Nonces, Prüfung fälliger/überfälliger Rechnungen und E-Mail-Ablaufwarnungen vor dem Lizenzende.
* **🔄 Auto-Migrationssystem:** Vollautomatisches Schema- und Datenmigrationssystem direkt beim Serverstart – manuelle DB-Setups entfallen komplett.
* **📩 Self-Registration (In Progress):** Integriertes Feature zur E-Mail-Verifizierung und Kundenregistrierung für den einfachen Einstieg.

---

## 4. Voraussetzungen

* **Node.js** >= 18.x
* **MySQL / MariaDB** >= 10.5.x
* **pdfkit** (für PDF-Generierung)

### Installierte npm-Abhängigkeiten (aus `package.json`):

* `express` – Web-Framework für die REST-API
* `mysql2` – MySQL/MariaDB-Treiber mit Promise-Support
* `bcryptjs` – Sicheres Passwort-Hashing für Admin- und Kunden-Accounts
* `jsonwebtoken` – Token-basierte Authentifizierung (RS256 für Lizenzen, HS256 für Portal- & Admin-Sessions)
* `helmet` – Schutz vor gängigen Web-Schachstellen durch HTTP-Header
* `cors` – Steuerung von Cross-Origin Resource Sharing
* `express-rate-limit` – Schutz vor Brute-Force und API-Abuse
* `nodemailer` – Integrierter E-Mail-Versand (SMTP)
* `otplib` – Implementierung von TOTP für die 2FA
* `qrcode` – Generierung von Setup-QR-Codes im Admin-Bereich
* `pdfkit` – Modul zur Erstellung von Rechnungs-PDFs
* `dotenv` – Laden von Konfigurationsvariablen aus der `.env`-Datei

---

## 5. Installation & Setup

Befolgen Sie diese Schritte, um den Server lokal oder auf einer Produktionsumgebung einzurichten:

```bash
# 1. Repository klonen
git clone https://github.com/stb-srv/licens-srv_OPA-Santorini
cd licens-srv_OPA-Santorini

# 2. Abhängigkeiten installieren
npm install

# 3. Umgebungsvariablen einrichten
cp .env.example .env

# 4. Passe die .env-Datei an (Datenbank-Zugangsdaten, Secrets und SMTP)
# nano .env

# 5. Server starten
npm start
```

> 💡 **Hinweis:** Die Datenbank-Migrationen laufen beim Start (`npm start`) **vollkommen automatisch** ab. Es ist keine manuelle Ausführung von Einrichtungs-Skripten nötig.

---

## 6. Datenbank-Migrationen

Der Server verfügt über ein eingebautes, robustes Migrationssystem.

> 📢 **Automatischer Ablauf:** Die Migrationen laufen **automatisch** beim Serverstart (`npm start`).
> Neue Dateien im Verzeichnis `server/migrations/` werden beim nächsten Start
> automatisch erkannt und ausgeführt. Eine bereits ausgeführte Migration
> wird nicht erneut angewendet (das Tracking erfolgt über die Tabelle `schema_migrations` in der DB).

### Manueller Aufruf (z.B. für Debugging oder CI/CD):
Falls Sie Migrationen manuell ausführen oder das Schema unabhängig vom Server-Boot prüfen möchten, führen Sie folgenden Befehl aus:
```bash
node server/migrate.js
```

### Neue Migration hinzufügen:
Um eine neue Tabellenänderung oder ein neues Schema einzuführen, verwenden Sie folgende Namenskonvention:

**Namenskonvention:** `vierstellige laufende Nummer` + `Underscore` + `kurze Beschreibung`.
Beispiel: `0020_add_new_table.js` (oder `.sql` für reines SQL).

Beispiel-Template für eine neue JavaScript-basierte Migration:
```js
export async function up(db) {
    await db.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS my_field VARCHAR(255) NULL`);
}

export async function down(db) {
    await db.query(`ALTER TABLE customers DROP COLUMN IF EXISTS my_field`);
}

export default up;
```

---

## 7. Umgebungsvariablen (.env)

Die Konfiguration der API erfolgt über Umgebungsvariablen in der `.env`-Datei:

| Variable | Pflicht / Optional | Beispielwert | Beschreibung |
| :--- | :--- | :--- | :--- |
| `PORT` | Optional | `4000` | Port, auf dem die Express-App lauscht (Fallback `4000`). |
| `DB_HOST` | **Pflicht** | `localhost` | Host-Adresse des MySQL/MariaDB-Servers. |
| `DB_PORT` | Optional | `3306` | Port des MySQL/MariaDB-Servers. |
| `DB_USER` | **Pflicht** | `licens_user` | Datenbank-Benutzername. |
| `DB_PASS` | **Pflicht** | `sicheres_passwort` | Datenbank-Passwort. |
| `DB_NAME` | **Pflicht** | `licens_db` | Name der MySQL-Datenbank. |
| `ADMIN_SECRET` | **Pflicht** | `sehr_langes_admin_secret` | JWT-Secret zur HS256-Signierung von Admin-Tokens. |
| `PORTAL_SECRET` | **Pflicht** | `sehr_langes_portal_secret` | JWT-Secret zur HS256-Signierung von Kunden-Portal-Tokens. |
| `HMAC_SECRET` | **Pflicht** | `sehr_langes_hmac_secret` | HMAC-Secret zum Signieren und Prüfen von Offline-Tokens. |
| `RSA_PRIVATE_KEY` | Optional | `-----BEGIN RSA PRIVATE KEY-----...` | PEM-formatierter privater RSA-Schlüssel zur RS256-Signierung von Lizenz-Tokens. |
| `RSA_PUBLIC_KEY` | Optional | `-----BEGIN PUBLIC KEY-----...` | PEM-formatierter öffentlicher RSA-Schlüssel zur CMS-seitigen Verifikation. |
| `CORS_ORIGINS` | Optional | `https://cms.meinrestaurant.de` | Kommagetrennte Ursprungsdomains für CORS. Wenn leer, wird dynamisch aus aktiven Lizenzen abgeglichen. |
| `SMTP_HOST` | Optional | `smtp.example.com` | Hostname des SMTP-Servers für Mail-Benachrichtigungen. |
| `SMTP_PORT` | Optional | `587` | Port des SMTP-Servers. |
| `SMTP_USER` | Optional | `noreply@domain.de` | Benutzername des SMTP-Servers. |
| `SMTP_PASS` | Optional | `smtp_password` | Passwort des SMTP-Servers. |
| `SETUP_TOKEN` | Optional | `once_setup_key_123` | Einmaliges Token zum initialen Setup des ersten Admin-Accounts. |
| `STORAGE_PATH` | Optional | `./storage` | Ordnerpfad, unter dem die Rechnungs-PDFs gespeichert werden. |
| `PORTAL_URL` | Optional | `https://portal.domain.de` | Basis-URL des Kundenportals für E-Mail-Einladungslinks. |

---

## 8. API-Übersicht

### Public API (`/api/v1/...`)
| Methode | Route | Beschreibung | Auth |
| :--- | :--- | :--- | :--- |
| `POST` | `/setup` | Erstellt ersten Superadmin-Account (nur wenn SETUP_TOKEN gesetzt) | `X-Setup-Token` Header |
| `POST` | `/validate` | Validiert Lizenz-Key (Domain-Binding, Device, Nonce-Check) | Keine |
| `POST` | `/heartbeat` | Aktualisiert den Zeitstempel des letzten Lebenszeichens | Keine |
| `POST` | `/refresh` | Erneuert einen gültigen Lizenz-Token | Keine |
| `POST` | `/verify-license-token` | Verifiziert einen RS256 signierten Lizenz-Token | Keine |
| `POST` | `/offline-token` | Stellt einen zeitlich begrenzten Offline-Token aus (max. 168h) | Keine |
| `POST` | `/verify-offline-token` | Überprüft die Validität eines Offline-Tokens | Keine |
| `GET` | `/public-key` | Liefert den öffentlichen RSA-Schlüssel für die CMS-Verifikation | Keine |
| `POST` | `/trial/register` | Registriert eine neue kostenlose Trial-Lizenz | Keine |

### Admin API (`/api/admin/...`)
| Methode | Route | Beschreibung | Auth |
| :--- | :--- | :--- | :--- |
| `POST` | `/login` | Administrator Login (liefert JWT zurück) | Keine / Rate-Limit |
| `POST` | `/logout` | Revokiert die aktive Admin-Session | Admin JWT |
| `GET` | `/stats` | Liefert globale System- und Aktivitätsstatistiken | Admin JWT |
| `GET` | `/stats/invoices` | Liefert Rechnungs-KPIs (MRR, ausstehend, bezahlt, etc.) | Admin JWT |
| `GET` | `/analytics` | Liefert detaillierte Feature- und Nutzungsstatistiken | Admin JWT |
| `GET` | `/licenses` | Listet alle Lizenzen auf | Admin JWT |
| `POST` | `/licenses` | Erstellt eine neue Lizenz | Admin JWT |
| `GET` | `/licenses/:key` | Zeigt Details einer einzelnen Lizenz | Admin JWT |
| `PATCH` | `/licenses/:key/status` | Ändert den Status einer Lizenz (aktiv/sperren) | Admin JWT |
| `POST` | `/licenses/:key/renew` | Verlängert die Lizenz-Laufzeit | Admin JWT |
| `DELETE` | `/licenses/:key` | Löscht eine Lizenz aus dem System | Admin JWT |
| `PATCH` | `/licenses/:key/customer` | Verknüpft einen Kunden mit einer Lizenz | Admin JWT |
| `GET` | `/customers` | Listet alle Kundenstammdaten auf | Admin JWT |
| `POST` | `/customers` | Erstellt ein neues Kundenprofil | Admin JWT |
| `PATCH` | `/customers/:id` | Aktualisiert Kunden-Stammdaten | Admin JWT |
| `DELETE` | `/customers/:id` | Löscht ein Kundenprofil | Admin JWT |
| `GET` | `/devices` | Listet alle registrierten Geräte auf | Admin JWT |
| `PATCH` | `/devices/:id/deactivate` | Deaktiviert ein registriertes Client-Gerät | Admin JWT |
| `DELETE` | `/devices/:id` | Löscht eine Geräte-Registrierung | Admin JWT |
| `GET` | `/invoices` | Listet alle Rechnungen auf | Admin JWT |
| `GET` | `/invoices/:id` | Zeigt Details einer Rechnung inklusive Items | Admin JWT |
| `POST` | `/invoices` | Erstellt manuell eine neue Rechnung | Admin JWT |
| `POST` | `/invoices/:id/resend` | Versendet eine Rechnung erneut per Mail samt PDF | Admin JWT |
| `GET` | `/audit-log` | Liefert filterbare Protokolle aller sicherheitsrelevanten Aktionen | Admin JWT |
| `GET` | `/users` | Listet alle Admin-Benutzer auf | Superadmin JWT |
| `POST` | `/users` | Erstellt einen neuen Admin- oder Superadmin-User | Superadmin JWT |
| `DELETE` | `/users/:username` | Löscht einen Admin-User aus dem System | Superadmin JWT |

### Kunden-Portal (`/api/portal/...`)
| Methode | Route | Beschreibung | Auth |
| :--- | :--- | :--- | :--- |
| `POST` | `/login` | Kunden-Login im Portal | Keine |
| `GET` | `/me` | Ruft das eigene Kundenprofil und Zahlungsstatus ab | Portal JWT |
| `PATCH` | `/update-profile` | Aktualisiert Stammdaten und die Rechnungsanschrift | Portal JWT |
| `GET` | `/licenses` | Listet alle eigenen Lizenzen des Kunden auf | Portal JWT |
| `PATCH` | `/licenses/:key/domain` | Aktualisiert die zugeordnete Domain einer Lizenz | Portal JWT |
| `GET` | `/invoices` | Listet alle Rechnungen des Kunden auf | Portal JWT |
| `GET` | `/invoices/:id/pdf` | Lädt das PDF einer spezifischen Rechnung herunter | Portal JWT |

---

## 9. Kunden-Portal

Das Kunden-Portal ermöglicht Kunden die selbstständige Verwaltung ihrer Accounts und Lizenzen ohne Admin-Intervention:
* **Login & Profilverwaltung:** Sicherer Zugang und Bearbeitung der eigenen Stammdaten sowie der Rechnungsanschrift (`billing_street`, `billing_city`, `billing_zip`, `billing_country`, `tax_id`).
* **Lizenzübersicht:** Einsehen aller zugeordneten Lizenzen, Laufzeiten und Module sowie eigenständiges Zuweisen und Ändern der verknüpften Domain.
* **Rechnungsdownload:** Einsicht in die Rechnungshistorie und direkter Download der generierten Rechnungs-PDFs.
* **Passwort zurücksetzen:** Möglichkeit zum sicheren Zurücksetzen des Passworts bei Verlust.

---

## 10. Rechnungssystem

Der License Server beinhaltet ein vollautomatisches Rechnungsmodul:
* **Automatische Erstellung:** Rechnungen werden vollautomatisch über den Cronjob (z.B. bei Lizenzverlängerungen) oder direkt bei manueller Lizenz-Erstellung im Admin-Panel generiert.
* **PDF-Generierung & Speicherung:** Rechnungen werden als professionelle PDFs generiert und sicher unter `${STORAGE_PATH}/invoices/` (Standard: `storage/invoices/`) abgelegt.
* **Rechnungs-Wiederversand:** Bereits gesendete Rechnungen können im Admin-Bereich mit einem Klick neu generiert und erneut per E-Mail an den Kunden verschickt werden (Audit-gesichert inklusive Aufzeichnung des `resent_count`).
* **Flexibilität:** Der Rechnungsnummernkreis sowie Präfixe (`INV-`) und Steuerdaten sind flexibel über die Datenbank und Admin-Einstellungen definierbar.

---

## 11. Sicherheitshinweise

* **Sichere Secrets:** Verwenden Sie für `ADMIN_SECRET`, `PORTAL_SECRET` und `HMAC_SECRET` zwingend kryptografisch sichere Zufallsschlüssel mit mindestens 32 Zeichen (z. B. generiert über `openssl rand -hex 48`).
* **RSA-Verschlüsselung:** Nutzen Sie für Produktionsumgebungen unbedingt RSA-Schlüsselpaare (RS256). Dies erlaubt es dem CMS vor Ort, die Lizenz-Tokens autark und ohne ständige API-Abfragen lokal gegen den Public Key zu verifizieren.
* **IP-Whitelist:** Die Admin-API und sensitive Endpunkte können über die Variable `ADMIN_IP_WHITELIST` in der `.env`-Datei zusätzlich gegen unerlaubte externe Zugriffe per IP-Sperre abgesichert werden.
* **Zwei-Faktor-Authentifizierung (2FA):** Aktivieren Sie für Admins und Superadmins die Zwei-Faktor-Authentifizierung via App (TOTP) zum Schutz vor unberechtigten Login-Versuchen.

---

## 12. Lizenz

Dieses Projekt ist unter der **MIT-Lizenz** lizenziert.
