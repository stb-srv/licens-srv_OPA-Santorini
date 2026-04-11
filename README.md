# 🏛️ OPA! Santorini License Server

Central license management server for the **OPA-Santorini** restaurant CMS system.

![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express)
![MySQL](https://img.shields.io/badge/MySQL-8.0%2B-4479A1?logo=mysql&logoColor=white)
![License](https://img.shields.io/badge/License-Private-red)
![Version](https://img.shields.io/badge/Version-2.0.0-6366f1)

---

## 📋 Inhaltsverzeichnis

- [Features](#-features)
- [Architektur](#-architektur)
- [Erstinstallation (Produktion)](#-erstinstallation-produktion)
- [Manuelle Installation (Lokal/Dev)](#-manuelle-installation-lokaldev)
- [Konfiguration (.env)](#-konfiguration-env)
- [Datenbank-Migration](#-datenbank-migration)
- [Server updaten](#-server-updaten)
- [Pläne & Module](#-pläne--module)
- [API Referenz](#-api-referenz)
- [Sicherheit](#-sicherheit)
- [Admin Panel](#-admin-panel)
- [Nginx Reverse Proxy](#-nginx-reverse-proxy)
- [Troubleshooting](#-troubleshooting)
- [Changelog](#-changelog)

---

## ✨ Features

| Feature | Status |
|---|---|
| Lizenz-Validierung (Key-based) | ✅ |
| MySQL-Datenbank (kein JSON-File mehr) | ✅ |
| Kunden- & Account-Verwaltung | ✅ |
| Geräte-Management (Device Fingerprint) | ✅ |
| Gerätelimit pro Lizenz | ✅ |
| Analytics & Nutzungsdaten | ✅ |
| RSA-2048 signierte License Tokens (RS256) | ✅ |
| HMAC-signierte Antworten | ✅ |
| Replay-Schutz (Nonce) | ✅ |
| Offline Tokens (JWT, zeitlich begrenzt) | ✅ |
| Rate Limiting | ✅ |
| Audit Log (alle Aktionen) | ✅ |
| Admin Panel (Web UI) | ✅ |
| Superadmin / Admin Rollen | ✅ |
| Impersonate (Support-Feature) | ✅ |
| Domain-Whitelist / Wildcard | ✅ |
| Ablauf-Benachrichtigungen per E-Mail | ✅ |
| Webhook-Unterstützung | ✅ |
| Automatisches Deploy-Script | ✅ |
| Automatisches Update-Script | ✅ |

---

## 🏗️ Architektur

```
licens-srv_OPA-Santorini/
├── server.js        # Express-Server, alle API-Endpunkte
├── migrate.js       # Datenbank-Schema erstellen + db.json migrieren
├── deploy.sh        # Erstinstallation auf Produktionsserver (als root)
├── update.sh        # Konfliktfreies Update + Migration + Neustart
├── package.json
├── .env             # Umgebungsvariablen (nie in Git!)
├── .env.example     # Vorlage für .env
├── private.pem      # RSA Private Key (automatisch generiert, nie in Git!)
├── public.pem       # RSA Public Key (fürs CMS)
├── backups/         # Automatische Backups (db.json + .env)
└── public/
    └── index.html     # Admin Panel (Single Page App)
```

**Datenbank-Tabellen (MySQL):**

| Tabelle | Inhalt |
|---|---|
| `licenses` | Lizenz-Schlüssel, Typ, Status, Ablaufdatum, Module |
| `customers` | Kunden mit E-Mail, Firma, Zahlungsstatus |
| `devices` | Registrierte Client-Geräte |
| `admins` | Admin-Accounts (bcrypt-gehashed) |
| `audit_log` | Alle Aktionen protokolliert |
| `smtp_config` | SMTP-Einstellungen |
| `webhooks` | Webhook-URLs |
| `used_nonces` | Replay-Schutz (5 min TTL) |

---

## 🚀 Erstinstallation (Produktion)

> Voraussetzungen: Ubuntu 22.04/24.04/25.04, Root-Zugriff, MySQL-Datenbank vorhanden

### Schritt 1 — deploy.sh herunterladen & ausführen

```bash
# Als root auf dem Produktionsserver:
wget https://raw.githubusercontent.com/stb-srv/licens-srv_OPA-Santorini/main/deploy.sh
bash deploy.sh
```

Das Script führt **automatisch** folgende Schritte aus:

1. ✅ Node.js 22, Git, OpenSSL installieren
2. ✅ System-User `licens-srv` anlegen
3. ✅ Repository klonen (fragt GitHub Token ab – da privates Repo)
4. ✅ Alle Secrets automatisch generieren:
   - `ADMIN_SECRET` – 48-Byte zufälliger Hex-String
   - `HMAC_SECRET` – 48-Byte zufälliger Hex-String
   - `WEBHOOK_SECRET` – 24-Byte zufälliger Hex-String
   - RSA-2048 Schlüsselpaar (`private.pem` + `public.pem`)
5. ✅ DB-Passwort interaktiv abfragen
6. ✅ `.env` mit allen Werten erstellen (`chmod 600`)
7. ✅ `npm install`
8. ✅ `node migrate.js` – Tabellen erstellen + Admin anlegen
9. ✅ systemd-Service einrichten & starten

> ❗ **Wichtig:** Das Script benötigt einen **GitHub Personal Access Token** mit `repo`-Berechtigung, da das Repository privat ist.
> Token erstellen unter: https://github.com/settings/tokens

### Schritt 2 — Netcup: Externen DB-Zugriff freischalten

Da die Datenbank bei Netcup liegt, muss die IP des Lizenzservers in der Netcup-Firewall freigegeben werden:

1. → https://www.customercontrolpanel.de einloggen
2. → **Produkte** → Webhosting-Paket
3. → **MySQL-Datenbanken** → `k220163_opa`
4. → **Externer Zugriff** → IP des Lizenzservers eintragen

### Schritt 3 — Firewall & erster Login

```bash
# Port 4000 freigeben
ufw allow 4000

# Logs prüfen
journalctl -fu licens-srv

# Erwartete Ausgabe:
# ✅  MySQL Verbindung erfolgreich – mysql2ebc.netcup.net:3306
# 🏛️  OPA! Santorini License Server läuft auf http://localhost:4000
```

Admin Panel: `http://DEINE-SERVER-IP:4000`

**Standard-Zugangsdaten (sofort ändern!):**
```
Username: admin
Password: admin123
```

### Schritt 4 — RSA Public Key ins CMS kopieren

```bash
cat /opt/licens-srv/public.pem
# Ausgabe in die CMS-Konfiguration einfügen
```

---

## 💻 Manuelle Installation (Lokal/Dev)

```bash
# 1. Repository klonen (GitHub Token erforderlich)
git clone https://github.com/stb-srv/licens-srv_OPA-Santorini.git
cd licens-srv_OPA-Santorini

# 2. Abhängigkeiten installieren
npm install

# 3. .env anlegen
cp .env.example .env
nano .env  # DB-Zugangsdaten + Secrets eintragen

# 4. Datenbank-Tabellen erstellen + Admin anlegen
node migrate.js

# 5. Server starten
npm start
# oder für Entwicklung mit Auto-Reload:
npm run dev
```

Der Server läuft auf `http://localhost:4000`.

---

## ⚙️ Konfiguration (.env)

Alle Einstellungen erfolgen über die `.env` Datei im Projektverzeichnis.
Die `.env` wird automatisch beim Start geladen (via `dotenv`).

```env
# Server-Port
PORT=4000

# Admin JWT Secret (automatisch generiert durch deploy.sh)
ADMIN_SECRET=dein-sehr-sicherer-jwt-key-hier

# HMAC Signing Secret (automatisch generiert durch deploy.sh)
HMAC_SECRET=dein-hmac-signing-secret-hier

# RSA-2048 Private Key für signierte License Tokens (RS256)
# Automatisch generiert durch deploy.sh, als Inline-String:
RSA_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"

# MySQL Datenbank
DB_HOST=mysql2ebc.netcup.net
DB_PORT=3306
DB_NAME=k220163_opa
DB_USER=k220163_opa
DB_PASS=dein-db-passwort

# CORS: erlaubte Origins (kommagetrennt, leer = alle erlaubt)
CORS_ORIGINS=https://dein-cms.de

# SMTP (optional – kann auch im Admin-Panel konfiguriert werden)
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# Webhook (optional)
WEBHOOK_URL=
WEBHOOK_SECRET=
```

> ⚠️ **Sonderzeichen im Passwort** (`$`, `!`, `#`, `@`) müssen in Anführungszeichen gesetzt werden:
> ```env
> DB_PASS="mein$Pa$$wort!"
> ```

Secrets manuell generieren:
```bash
openssl rand -hex 48
```

---

## 🔄 Datenbank-Migration

Das `migrate.js`-Script übernimmt zwei Aufgaben:

1. **Schema erstellen** – Alle MySQL-Tabellen werden angelegt (`CREATE TABLE IF NOT EXISTS`)
2. **Daten migrieren** – Vorhandene `db.json` (altes Format) wird in MySQL importiert

### Wann muss `migrate.js` ausgeführt werden?

| Situation | Aktion |
|---|---|
| Erstinstallation (keine Tabellen) | `node migrate.js` |
| Update mit neuen Tabellen/Spalten | `node migrate.js` |
| Migration von alter `db.json` | `node migrate.js` |
| Fehler `Table '...' doesn't exist` | `node migrate.js` |

```bash
cd /opt/licens-srv
node migrate.js
```

**Erwartete Ausgabe:**
```
🔄 Starte Migration...
✅ Tabellen erstellt/geprüft
✅ Admin 'admin' angelegt (Passwort: admin123)
✅ Migration abgeschlossen

📊 Zusammenfassung:
   Lizenzen migriert:  1
   Kunden migriert:    0
   Admins migriert:    1
```

> ❗ **Nach der Migration:** Standard-Passwort `admin123` sofort im Admin-Panel ändern!

### Verhalten bei wiederholter Ausführung

- Bereits vorhandene Lizenzen/Kunden werden **nicht überschrieben**
- `usage_count` und Timestamps werden aktualisiert
- Bestehende Admin-Accounts bleiben erhalten (Passwörter nicht zurückgesetzt)
- Sicher jederzeit ausführbar (idempotent)

---

## 🔄 Server updaten

Für Updates auf dem Produktionsserver gibt es das `update.sh`-Script.
Es ist **vollautomatisch** – keine manuelle Intervention nötig.

```bash
cd /opt/licens-srv
bash update.sh
```

**Was das Script macht:**

1. 📦 Backup von `db.json` und `.env` nach `backups/` (max. 10 Backups)
2. 📥 `git fetch origin main` + `git reset --hard origin/main`
   - **Kein `git pull`**, kein Stash, kein Merge – überschreibt lokale Änderungen
   - `.env` ist in `.gitignore` und wird **nie überschrieben**
3. 📦 `npm install` (bei geänderter `package.json` automatisch `npm ci`)
4. ⏸️ Server kurz stoppen (für saubere Migration)
5. 🔄 `node migrate.js` (neue Tabellen/Spalten werden angelegt)
6. 🚀 Server neu starten (PM2 oder systemd)

> ❗ **Wichtig:** Das Script überschreibt alle versionierten Dateien (`server.js`, `package.json`, etc.) ohne Rückfrage.
> Eigene Änderungen an diesen Dateien gehen verloren. Konfiguration gehört ausschließlich in die `.env`.

### Typischer Update-Ablauf

```bash
# Auf dem Server:
bash update.sh

# Logs prüfen:
journalctl -fu licens-srv
```

---

## 📦 Pläne & Module

| Plan | Schlüssel-Prefix | Speisen | Tische | Laufzeit |
|---|---|---|---|---|
| Free | `OPA-FREE-` | 30 | 5 | Unbegrenzt |
| Starter | `OPA-START-` | 60 | 10 | 365 Tage |
| Pro | `OPA-PRO-` | 150 | 25 | 365 Tage |
| Pro+ | `OPA-PROPLUS-` | 300 | 50 | 365 Tage |
| Enterprise | `OPA-ENT-` | 999 | 999 | 365 Tage |

**Verfügbare Module pro Plan:**

| Modul | Free | Starter | Pro | Pro+ | Enterprise |
|---|---|---|---|---|---|
| `menu_edit` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `multilanguage` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `orders_kitchen` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `reservations_phone` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `reservations_online` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `seasonal_menu` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `custom_branding` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `qr_pay` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `analytics` | ❌ | ❌ | ❌ | ✅ | ✅ |

---

## 📡 API Referenz

### Public API

#### `POST /api/v1/validate`

Validiert einen Lizenz-Key. Hauptendpoint für Client-Plugins.

**Rate Limit:** 30 Requests/Minute pro IP

**Request Body:**
```json
{
  "license_key": "OPA-PRO-ABCD1234-2026",
  "domain": "meinrestaurant.de",
  "device_id": "unique-device-fingerprint",
  "device_type": "windows",
  "nonce": "zufaelliger-einmal-string",
  "features_used": ["menu_edit", "reservations_online"]
}
```

**Erfolgreiche Antwort (`200`):**
```json
{
  "status": "active",
  "customer_name": "Taverna Papadopoulos",
  "type": "PRO",
  "plan_label": "Pro",
  "expires_at": "2027-04-08T00:00:00.000Z",
  "allowed_modules": { "menu_edit": true, "qr_pay": true, "..." : "..." },
  "limits": { "max_dishes": 150, "max_tables": 25 },
  "license_token": "eyJhbGciOiJSUzI1NiJ9...",
  "license_token_public_key": "-----BEGIN PUBLIC KEY-----...",
  "_sig": "hmac-sha256-signatur",
  "_ts": 1712607600000
}
```

**Fehlercodes:**

| HTTP | `status` | Beschreibung |
|---|---|---|
| 404 | `invalid` | Key nicht gefunden |
| 403 | `expired` | Lizenz abgelaufen |
| 403 | `inactive` | Lizenz deaktiviert |
| 403 | `domain_mismatch` | Domain nicht erlaubt |
| 403 | `device_limit` | Max. Gerätanzahl erreicht |
| 400 | `replay` | Nonce bereits verwendet |
| 429 | `rate_limited` | Zu viele Requests |

---

#### `POST /api/v1/heartbeat`

Reguläre Verbindungskontrolle. Erneuert den `license_token` ohne vollständige Validierung.

```json
{ "license_key": "OPA-PRO-ABCD1234-2026", "domain": "meinrestaurant.de" }
```

---

#### `GET /api/v1/public-key`

Gibt den RSA Public Key zurück (für Client-seitige Token-Verifikation).

```json
{ "public_key": "-----BEGIN PUBLIC KEY-----...", "algorithm": "RS256" }
```

---

#### `POST /api/v1/offline-token`

Generiert einen signierten JWT-Token für Offline-Betrieb (max. 168h / 7 Tage).

```json
{
  "license_key": "OPA-PRO-ABCD1234-2026",
  "domain": "meinrestaurant.de",
  "device_id": "fingerprint",
  "duration_hours": 24
}
```

---

### Admin API

Alle `/api/admin/*` Endpunkte benötigen:
```
Authorization: Bearer <token>
```

#### `POST /api/admin/login`
```json
{ "username": "admin", "password": "deinpasswort" }
```
**Rate Limit:** 10 Versuche / 15 Minuten

---

#### Lizenzen

| Methode | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/admin/licenses` | Alle Lizenzen + Stats |
| `POST` | `/api/admin/licenses` | Neue Lizenz erstellen |
| `GET` | `/api/admin/licenses/:key` | Einzelne Lizenz |
| `PATCH` | `/api/admin/licenses/:key/status` | Status ändern |
| `POST` | `/api/admin/licenses/:key/renew` | Lizenz verlängern |
| `PATCH` | `/api/admin/licenses/:key/customer` | Kunde verknüpfen |
| `DELETE` | `/api/admin/licenses/:key` | Lizenz löschen |

**Lizenz erstellen:**
```json
{
  "type": "PRO",
  "customer_name": "Taverna Papadopoulos",
  "customer_id": "uuid-optional",
  "license_key": "OPA-PRO-CUSTOM-2026",
  "associated_domain": "*.meinrestaurant.de",
  "max_devices": 3,
  "expires_at": "2027-04-08T00:00:00"
}
```
> `license_key` leer lassen → wird automatisch generiert  
> `associated_domain: "*"` → alle Domains erlaubt  
> `max_devices: 0` → unbegrenzte Geräte

---

#### Kunden

| Methode | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/admin/customers` | Alle Kunden |
| `POST` | `/api/admin/customers` | Neuen Kunden anlegen |
| `PATCH` | `/api/admin/customers/:id` | Kunden bearbeiten |
| `DELETE` | `/api/admin/customers/:id` | Kunden löschen |

---

#### Geräte

| Methode | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/admin/devices` | Alle Geräte (`?license_key=` optional) |
| `PATCH` | `/api/admin/devices/:id/deactivate` | Gerät deaktivieren |
| `DELETE` | `/api/admin/devices/:id` | Gerät entfernen |

---

#### Analytics, Audit Log, Webhooks

| Methode | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/admin/analytics` | Statistiken & Feature-Nutzung |
| `GET` | `/api/admin/audit-log` | Alle Events (`?limit=100&action=...`) |
| `GET` | `/api/admin/webhooks` | Webhooks anzeigen |
| `POST` | `/api/admin/webhooks` | Webhook hinzufügen |
| `DELETE` | `/api/admin/webhooks/:id` | Webhook entfernen |

---

#### Benutzer *(nur Superadmin)*

| Methode | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/admin/users` | Alle Admin-User |
| `POST` | `/api/admin/users` | Neuen User erstellen |
| `DELETE` | `/api/admin/users/:username` | User löschen |
| `PATCH` | `/api/admin/users/:username/password` | Passwort ändern |

**Rollen:** `admin` | `superadmin`

---

## 🔐 Sicherheit

### RSA-2048 License Tokens (RS256)

Jede erfolgreiche Validierung gibt einen signierten JWT `license_token` zurück.
Das CMS kann diesen lokal mit dem Public Key verifizieren – ohne Serverzugriff:

```javascript
import jwt from 'jsonwebtoken';

const decoded = jwt.verify(licenseToken, publicKey, { algorithms: ['RS256'] });
console.log(decoded.type);            // 'PRO'
console.log(decoded.allowed_modules); // { menu_edit: true, ... }
```

### HMAC-Signierung

Wenn `HMAC_SECRET` gesetzt ist, enthält jede Validate-Antwort:
- `_sig`: HMAC-SHA256-Signatur des Response-Bodies
- `_ts`: Unix-Timestamp

```javascript
const crypto = require('crypto');
function verifyResponse(body, hmacSecret) {
  const { _sig, _ts, ...payload } = body;
  const expected = crypto.createHmac('sha256', hmacSecret)
    .update(JSON.stringify(payload)).digest('hex');
  return expected === _sig;
}
```

### Replay-Schutz

```javascript
const nonce = crypto.randomBytes(16).toString('hex');
// Im Request: { ..., nonce }
// Server lehnt bereits verwendete Nonces (5-Minuten-Fenster) ab
```

### Rate Limiting

| Endpoint | Limit |
|---|---|
| `POST /api/admin/login` | 10 / 15 Minuten |
| `POST /api/v1/validate` | 30 / Minute |
| `POST /api/v1/offline-token` | 30 / Minute |
| Alle anderen Admin-Endpunkte | 60 / Minute |

---

## 🖥️ Admin Panel

Erreichbar unter: `http://DEINE-IP:4000` (oder via Nginx: `https://deine-domain.de`)

| Tab | Beschreibung |
|---|---|
| **🔑 Lizenzen** | Lizenzen erstellen, sperren, verlängern, löschen. Stats-Übersicht. |
| **🏢 Kunden** | Kunden anlegen/bearbeiten mit E-Mail, Firma, Zahlungsstatus, Notizen |
| **💻 Geräte** | Alle registrierten Client-Geräte sehen, deaktivieren oder entfernen |
| **📊 Analytics** | Feature-Nutzung, Top-Lizenzen, 30-Tage-Diagramm |
| **📜 Audit Log** | Alle Events, filterbar nach Typ |
| **📧 SMTP** | E-Mail-Konfiguration für Ablauf-Benachrichtigungen |
| **👥 Benutzer** | *(Nur Superadmin)* Admin-User verwalten |

---

## 🌐 Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name licens-prod.stb-srv.de;

    ssl_certificate     /etc/letsencrypt/live/licens-prod.stb-srv.de/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/licens-prod.stb-srv.de/privkey.pem;

    location / {
        proxy_pass http://localhost:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
```

> `app.set('trust proxy', 1)` ist bereits gesetzt – IP-Adressen hinter Nginx werden korrekt erkannt.

---

## 🐛 Troubleshooting

### `Table '...' doesn't exist`

```bash
cd /opt/licens-srv && node migrate.js
```

Das Schema wurde noch nicht erstellt. Migration löst das sofort.

---

### `Access denied for user '...'@'87.x.x.x'`

Netcup blockiert externe MySQL-Verbindungen. Lösung:
1. → https://www.customercontrolpanel.de
2. → Webhosting → MySQL-Datenbanken → `k220163_opa`
3. → **Externer Zugriff** → Server-IP eintragen

---

### `connect ENETUNREACH` / DB-Host nicht erreichbar

Server kann `mysql2ebc.netcup.net` nicht erreichen:
```bash
nc -zv mysql2ebc.netcup.net 3306   # Verbindungstest
grep DB_HOST /opt/licens-srv/.env  # Prüfen ob Host korrekt gesetzt
```

---

### `.env` wird nicht geladen / Server nimmt Fallback-Werte

Seit v2.0 wird `dotenv` automatisch beim Start geladen. Prüfen:
```bash
# .env vorhanden?
ls -la /opt/licens-srv/.env

# Inhalt prüfen
grep DB_HOST /opt/licens-srv/.env

# Sonderzeichen im Passwort?
# Falls ja: DB_PASS="mein$Passwort" in Anführungszeichen setzen

# Service neu starten
systemctl restart licens-srv
journalctl -fu licens-srv
```

---

### `git pull` schlägt fehl / Merge-Konflikt

Nicht `git pull` verwenden – stattdessen `update.sh` nutzen:
```bash
bash update.sh
# Nutzt intern: git fetch + git reset --hard origin/main
# Kein Stash, kein Merge, keine Konflikte
```

---

### Server startet nicht nach Update

```bash
# Letzten 50 Log-Zeilen anzeigen
journalctl -u licens-srv -n 50 --no-pager

# Service-Status
systemctl status licens-srv

# Manuell testen (zeigt direkte Fehlerausgabe)
cd /opt/licens-srv && node server.js
```

---

### Admin-Passwort vergessen

```bash
# Direkt in MySQL zurücksetzen:
node -e "
import bcrypt from 'bcryptjs';
const hash = await bcrypt.hash('neuesPasswort', 12);
console.log(hash);
" --input-type=module

# Dann in MySQL:
# UPDATE admins SET password_hash='DER_HASH' WHERE username='admin';
```

---

## 📋 Client-Integration (PHP/WordPress)

```php
function opa_validate_license($license_key, $domain) {
    $response = wp_remote_post('https://licens-prod.stb-srv.de/api/v1/validate', [
        'body' => json_encode([
            'license_key'   => $license_key,
            'domain'        => $domain,
            'device_id'     => md5(gethostname()),
            'device_type'   => 'server',
            'nonce'         => bin2hex(random_bytes(16)),
            'features_used' => ['menu_edit', 'reservations_online'],
        ]),
        'headers' => ['Content-Type' => 'application/json'],
        'timeout' => 10,
    ]);

    if (is_wp_error($response)) return false;
    $data = json_decode(wp_remote_retrieve_body($response), true);
    return $data['status'] === 'active' ? $data : false;
}
```

---

## 📝 Changelog

### v2.0.0 (2026-04-11)
- 🔄 **MySQL statt JSON-Datei** – vollständige Datenbankmigrierung
- ✨ **`migrate.js`** – automatische Schema-Erstellung + `db.json`-Import
- ✨ **`deploy.sh` v2.1** – vollautomatische Erstinstallation inkl. Secret-Generierung
- ✨ **`update.sh`** – konfliktfreies Update via `git reset --hard`
- ✨ **RSA-2048 License Tokens** (RS256) – CMS kann Tokens lokal verifizieren
- ✨ **`dotenv`** – `.env` wird immer geladen, auch bei manuellem Start
- ✨ **GitHub Token Auth** im `deploy.sh` für private Repositories
- ✨ **Lizenz verlängern** (`/api/admin/licenses/:key/renew`)
- 🔒 Verbesserter DB-Verbindungsfehler-Log (zeigt verwendeten Host)
- 🛠️ Netcup-spezifische DB-Host-Konfiguration (`mysql2ebc.netcup.net`)

### v1.2.0 (2026-04-08)
- ✨ Kunden-Verwaltung, Geräte-Management, Analytics
- ✨ HMAC-Signierung, Replay-Schutz, Offline Tokens
- ✨ Audit Log, Impersonate, Admin Panel (5 Tabs)

### v1.0.0
- Initiales Release – Lizenz-Validierung mit JSON-Datenbank

---

## 📄 Lizenz

Proprietär — Alle Rechte vorbehalten. Nur für den internen Einsatz im OPA-Santorini System.
