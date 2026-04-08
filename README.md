# 🏘️ OPA License Server

Central license management server for the **OPA-Santorini** restaurant CMS system.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express)
![License](https://img.shields.io/badge/License-Private-red)
![Version](https://img.shields.io/badge/Version-1.2.0-6366f1)

---

## 📋 Inhaltsverzeichnis

- [Features](#-features)
- [Architektur](#-architektur)
- [Installation](#-installation)
- [Konfiguration](#-konfiguration)
- [Pläne & Module](#-pläne--module)
- [API Referenz](#-api-referenz)
  - [Public API](#public-api)
  - [Admin API – Lizenzen](#admin-api--lizenzen)
  - [Admin API – Kunden](#admin-api--kunden)
  - [Admin API – Geräte](#admin-api--geräte)
  - [Admin API – Analytics](#admin-api--analytics)
  - [Admin API – Audit Log](#admin-api--audit-log)
  - [Admin API – Benutzer](#admin-api--benutzer)
- [Sicherheit](#-sicherheit)
- [Admin Panel](#-admin-panel)
- [Deployment](#-deployment)
- [Changelog](#-changelog)

---

## ✨ Features

| Feature | Status |
|---|---|
| Lizenz-Validierung (Key-based) | ✅ |
| Kunden- & Account-Verwaltung | ✅ |
| Geräte-Management (Device Fingerprint) | ✅ |
| Gerätelimit pro Lizenz | ✅ |
| Analytics & Nutzungsdaten | ✅ |
| HMAC-signierte Antworten | ✅ |
| Replay-Schutz (Nonce) | ✅ |
| Offline Tokens (JWT, zeitlich begrenzt) | ✅ |
| Rate Limiting | ✅ |
| Audit Log (alle Aktionen) | ✅ |
| Admin Panel (Web UI) | ✅ |
| Superadmin / Admin Rollen | ✅ |
| Impersonate (Support-Feature) | ✅ |
| Domain-Whitelist / Wildcard | ✅ |

---

## 🏗️ Architektur

```
licens-srv_OPA-Santorini/
├── server.js          # Express-Server, alle API-Endpunkte
├── db.json            # JSON-Datenbank (Lizenzen, Kunden, Geräte, Logs)
├── setup-admin.js     # Setup-Script: ersten Admin anlegen
├── deploy.sh          # Deploy-Script für Produktionsserver
├── package.json
├── .env.example       # Umgebungsvariablen-Vorlage
└── public/
    └── index.html     # Admin Panel (Single Page App)
```

**Datenbank-Struktur (`db.json`):**
```json
{
  "licenses":    [...],   // Lizenz-Objekte
  "customers":   [...],   // Kunden / Accounts
  "devices":     [...],   // Registrierte Client-Geräte
  "audit_log":   [...],   // Audit-Einträge (max. 2000)
  "used_nonces": [...],   // Replay-Schutz (5 min TTL)
  "admins":      [...]    // Admin-Accounts (bcrypt-gehashed)
}
```

---

## 🚀 Installation

### Voraussetzungen
- Node.js 18+
- npm

### Setup

```bash
# 1. Repository klonen
git clone https://github.com/stb-srv/licens-srv_OPA-Santorini.git
cd licens-srv_OPA-Santorini

# 2. Abhängigkeiten installieren
npm install

# 3. Umgebungsvariablen konfigurieren
cp .env.example .env
nano .env

# 4. Ersten Admin anlegen
node setup-admin.js

# 5. Server starten
npm start
```

Der Server läuft dann auf `http://localhost:4000`.

---

## ⚙️ Konfiguration

Alle Einstellungen erfolgen über die `.env` Datei:

```env
# Server-Port (Standard: 4000)
PORT=4000

# JWT-Secret für Admin-Authentifizierung
# Mindestens 32 zufällige Zeichen!
ADMIN_SECRET=dein-sehr-sicherer-jwt-key-hier

# HMAC-Secret für signierte Validate-Antworten
# Mindestens 32 zufällige Zeichen!
HMAC_SECRET=dein-hmac-signing-secret-hier

# Erlaubte CORS-Origins (kommagetrennt)
# Leer lassen = alle Origins erlaubt
CORS_ORIGINS=https://licens-prod.stb-srv.de
```

> ⚠️ **Wichtig:** Ohne gesetztes `HMAC_SECRET` sind Response-Signaturen deaktiviert. Ohne gesetztes `ADMIN_SECRET` ist das System unsicher!

Zufällige Secrets generieren:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 📦 Pläne & Module

| Plan | Schlüssel-Prefix | Speisen | Tische | Laufzeit |
|---|---|---|---|---|
| Free | `OPA-FREE-` | 10 | 5 | Unbegrenzt |
| Starter | `OPA-START-` | 40 | 10 | 365 Tage |
| Pro | `OPA-PRO-` | 100 | 25 | 365 Tage |
| Pro+ | `OPA-PROPLUS-` | 200 | 50 | 365 Tage |
| Enterprise | `OPA-ENT-` | 500 | 999 | 365 Tage |

**Verfügbare Module pro Plan:**

| Modul | Free | Starter | Pro | Pro+ | Enterprise |
|---|---|---|---|---|---|
| `menu_edit` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `orders_kitchen` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `reservations` | ❌ | ✅ | ✅ | ✅ | ✅ |
| `custom_design` | ❌ | ❌ | ✅ | ✅ | ✅ |
| `analytics` | ❌ | ❌ | ❌ | ✅ | ✅ |
| `qr_pay` | ❌ | ❌ | ❌ | ❌ | ✅ |

---

## 📡 API Referenz

### Public API

#### `POST /api/v1/validate`

Validiert einen Lizenz-Key. Dies ist der Hauptendpoint für Client-Plugins.

**Rate Limit:** 30 Requests/Minute pro IP

**Request Body:**
```json
{
  "license_key": "OPA-PRO-ABCD1234-2026",
  "domain": "meinrestaurant.de",

  // Optional: Geräteverwaltung
  "device_id": "unique-device-fingerprint",
  "device_type": "windows",

  // Optional: Replay-Schutz
  "nonce": "zufaelliger-einmal-string",

  // Optional: Feature-Tracking
  "features_used": ["menu_edit", "reservations"]
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
  "allowed_modules": {
    "menu_edit": true,
    "orders_kitchen": true,
    "reservations": true,
    "custom_design": true,
    "analytics": false,
    "qr_pay": false
  },
  "limits": {
    "max_dishes": 100,
    "max_tables": 25
  },
  // Wenn HMAC_SECRET gesetzt:
  "_sig": "hmac-sha256-signatur",
  "_ts": 1712607600000
}
```

**Fehlerfälle:**

| HTTP | `status` | Beschreibung |
|---|---|---|
| 400 | `invalid` | Kein Key angegeben |
| 404 | `invalid` | Key nicht gefunden |
| 403 | `expired` | Lizenz abgelaufen |
| 403 | `inactive` | Lizenz deaktiviert |
| 403 | `domain_mismatch` | Domain nicht erlaubt |
| 403 | `device_limit` | Max. Gerätanzahl erreicht |
| 400 | `replay` | Nonce bereits verwendet |
| 429 | `rate_limited` | Zu viele Requests |

---

#### `POST /api/v1/offline-token`

Generiert einen signierten JWT-Token für Offline-Betrieb.

**Request Body:**
```json
{
  "license_key": "OPA-PRO-ABCD1234-2026",
  "domain": "meinrestaurant.de",
  "device_id": "device-fingerprint",
  "duration_hours": 24
}
```

**Antwort:**
```json
{
  "success": true,
  "offline_token": "eyJhbGciOiJIUzI1NiJ9...",
  "valid_hours": 24
}
```

> Maximum: 168 Stunden (7 Tage). Benötigt `HMAC_SECRET`.

---

#### `POST /api/v1/verify-offline-token`

Verifiziert einen Offline-Token lokal (kein DB-Zugriff).

**Request Body:**
```json
{
  "offline_token": "eyJhbGciOiJIUzI1NiJ9..."
}
```

---

### Admin API – Authentifizierung

Alle `/api/admin/*` Endpunkte benötigen einen Bearer Token im Header:
```
Authorization: Bearer <token>
```

#### `POST /api/admin/login`

```json
{ "username": "admin", "password": "deinpasswort" }
```
**Rate Limit:** 10 Versuche / 15 Minuten

---

### Admin API – Lizenzen

| Methode | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/admin/licenses` | Alle Lizenzen + Stats |
| `POST` | `/api/admin/licenses` | Neue Lizenz erstellen |
| `PATCH` | `/api/admin/licenses/:key/status` | Status ändern (`active`/`inactive`) |
| `PATCH` | `/api/admin/licenses/:key/customer` | Lizenz mit Kunden verknüpfen |
| `DELETE` | `/api/admin/licenses/:key` | Lizenz löschen |
| `GET` | `/api/admin/plans` | Plan-Definitionen abrufen |

**Lizenz erstellen – Body:**
```json
{
  "type": "PRO",
  "customer_name": "Taverna Papadopoulos",
  "customer_id": "uuid-optional",
  "license_key": "OPA-PRO-CUSTOM-2026",
  "associated_domain": "*.meinrestaurant.de",
  "max_devices": 3,
  "expires_at": "2027-04-08T00:00:00.000Z"
}
```

> `license_key` leer lassen → wird automatisch generiert  
> `associated_domain: "*"` → alle Domains erlaubt  
> `max_devices: 0` → unbegrenzte Geräte

---

### Admin API – Kunden

| Methode | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/admin/customers` | Alle Kunden |
| `POST` | `/api/admin/customers` | Neuen Kunden anlegen |
| `PATCH` | `/api/admin/customers/:id` | Kunden bearbeiten |
| `DELETE` | `/api/admin/customers/:id` | Kunden löschen |

**Kunden-Objekt:**
```json
{
  "id": "uuid",
  "name": "Max Mustermann",
  "email": "max@taverna.de",
  "company": "Taverna GmbH",
  "payment_status": "active",
  "notes": "Jahresvertrag, Verlängerung April 2027",
  "created_at": "2026-04-08T21:00:00.000Z"
}
```

**Zahlungsstatus-Werte:** `active` | `trial` | `unpaid` | `unknown`

---

### Admin API – Geräte

| Methode | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/admin/devices` | Alle Geräte (optional `?license_key=`) |
| `PATCH` | `/api/admin/devices/:id/deactivate` | Gerät deaktivieren |
| `DELETE` | `/api/admin/devices/:id` | Gerät endgültig entfernen |

**Geräte-Objekt:**
```json
{
  "id": "uuid",
  "license_key": "OPA-PRO-ABCD1234-2026",
  "device_id": "client-fingerprint-hash",
  "device_type": "windows",
  "ip": "192.168.1.100",
  "first_seen": "2026-04-08T21:00:00.000Z",
  "last_seen": "2026-04-08T21:15:00.000Z",
  "active": true
}
```

**Gerätetypen:** `windows` | `ios` | `android` | `server` | `unknown`

---

### Admin API – Analytics

#### `GET /api/admin/analytics`

```json
{
  "top_licenses": [
    {
      "license_key": "OPA-PRO-...",
      "customer_name": "Taverna ...",
      "type": "PRO",
      "usage_count": 1250,
      "last_validated": "2026-04-08T21:00:00.000Z"
    }
  ],
  "daily_requests": {
    "2026-04-07": 143,
    "2026-04-08": 87
  },
  "feature_usage": {
    "menu_edit": 980,
    "reservations": 540
  },
  "total_devices": 12,
  "active_devices": 9
}
```

---

### Admin API – Audit Log

#### `GET /api/admin/audit-log`

Query-Parameter: `?limit=100&action=validate_failed&license_key=OPA-PRO-...`

**Audit-Event-Typen:**

| Event | Beschreibung |
|---|---|
| `validate_success` | Erfolgreiche Validierung |
| `validate_failed` | Fehlgeschlagene Validierung |
| `replay_attack` | Replay-Angriff erkannt |
| `device_registered` | Neues Gerät registriert |
| `device_deactivated` | Gerät deaktiviert |
| `device_removed` | Gerät entfernt |
| `license_created` | Lizenz erstellt |
| `license_deleted` | Lizenz gelöscht |
| `license_status_changed` | Lizenz-Status geändert |
| `license_customer_linked` | Lizenz ↔ Kunde verknüpft |
| `offline_token_issued` | Offline-Token ausgestellt |
| `admin_login` | Erfolgreicher Admin-Login |
| `admin_login_failed` | Fehlgeschlagener Login |
| `admin_user_created` | Admin-User erstellt |
| `admin_user_deleted` | Admin-User gelöscht |
| `admin_password_changed` | Passwort geändert |
| `customer_created` | Kunde angelegt |
| `customer_updated` | Kunde bearbeitet |
| `customer_deleted` | Kunde gelöscht |
| `impersonate` | Superadmin-Impersonation |

---

### Admin API – Benutzer

> Nur für **Superadmin** zugänglich.

| Methode | Endpoint | Beschreibung |
|---|---|---|
| `GET` | `/api/admin/users` | Alle Admin-User |
| `POST` | `/api/admin/users` | Neuen User erstellen |
| `DELETE` | `/api/admin/users/:username` | User löschen |
| `PATCH` | `/api/admin/users/:username/password` | Passwort ändern |

**Rollen:** `admin` (Lizenzen verwalten) | `superadmin` (Lizenzen + User + Impersonate)

---

### Admin API – Impersonate

> Nur **Superadmin**. Gibt vollständigen Lizenz-Kontext zurück (für Support).

#### `POST /api/admin/impersonate`

```json
{ "license_key": "OPA-PRO-ABCD1234-2026" }
```

**Antwort:**
```json
{
  "success": true,
  "license": { ... },
  "customer": { ... },
  "devices": [ ... ]
}
```

---

## 🔐 Sicherheit

### HMAC-Signierung

Wenn `HMAC_SECRET` gesetzt ist, enthält jede `/api/v1/validate`-Antwort:
- `_sig`: HMAC-SHA256-Signatur des Response-Bodies
- `_ts`: Unix-Timestamp der Antwort

**Client-seitige Verifikation (Node.js):**
```javascript
const crypto = require('crypto');

function verifyResponse(responseBody, hmacSecret) {
  const { _sig, _ts, ...payload } = responseBody;
  const expected = crypto
    .createHmac('sha256', hmacSecret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return expected === _sig;
}
```

### Replay-Schutz

Client sendet bei jedem Request einen einmaligen `nonce`:
```javascript
const nonce = crypto.randomBytes(16).toString('hex');
// Im Request-Body mitschicken: { ..., nonce }
```
Der Server lehnt bereits verwendete Nonces innerhalb von 5 Minuten ab.

### Rate Limiting

| Endpoint | Limit |
|---|---|
| `POST /api/admin/login` | 10 / 15 Minuten |
| `POST /api/v1/validate` | 30 / Minute |
| `POST /api/v1/offline-token` | 30 / Minute |
| Alle anderen Admin-Endpunkte | 60 / Minute |

---

## 🖥️ Admin Panel

Erreichbar unter: `http://localhost:4000` (bzw. deine Produktions-URL)

### Tabs

| Tab | Beschreibung |
|---|---|
| **🔑 Lizenzen** | Lizenzen erstellen, sperren, löschen. Stats-Übersicht. Impersonate-Button. |
| **🏢 Kunden** | Kunden anlegen/bearbeiten mit E-Mail, Firma, Zahlungsstatus, Notizen |
| **💻 Geräte** | Alle registrierten Client-Geräte sehen, deaktivieren oder entfernen |
| **📊 Analytics** | Feature-Nutzung, Top-Lizenzen, 30-Tage-Balkendiagramm |
| **📜 Audit Log** | Alle Events, filterbar nach Typ, automatische Farb-Codierung |
| **👥 Benutzer** | *(Nur Superadmin)* Admin-User verwalten, Passwörter ändern |

---

## 🚢 Deployment

### Mit PM2 (empfohlen)

```bash
# PM2 installieren (einmalig)
npm install -g pm2

# Server starten
pm2 start server.js --name opa-license-server

# Autostart bei Reboot
pm2 startup
pm2 save

# Logs anzeigen
pm2 logs opa-license-server

# Neustart
pm2 restart opa-license-server
```

### Mit deploy.sh

```bash
chmod +x deploy.sh
./deploy.sh
```

### Nginx Reverse Proxy

```nginx
server {
    listen 443 ssl;
    server_name licens-prod.stb-srv.de;

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

> Wichtig: `app.set('trust proxy', 1)` ist bereits im Server gesetzt, damit IP-Adressen hinter Nginx korrekt erkannt werden.

---

## 📌 Client-Integration (Beispiel PHP/WordPress)

```php
function opa_validate_license($license_key, $domain) {
    $response = wp_remote_post('https://licens-prod.stb-srv.de/api/v1/validate', [
        'body' => json_encode([
            'license_key'   => $license_key,
            'domain'        => $domain,
            'device_id'     => md5(gethostname()),
            'device_type'   => 'server',
            'nonce'         => bin2hex(random_bytes(16)),
            'features_used' => ['menu_edit', 'reservations'],
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

## 📋 Changelog

### v1.2.0 (2026-04-08)
- ✨ **Kunden-Verwaltung**: Accounts mit E-Mail, Firma, Zahlungsstatus
- ✨ **Geräte-Management**: Fingerprint, Typ, IP, Gerätelimit, Deaktivierung
- ✨ **Analytics**: Tagesstatistiken (90 Tage), Feature-Tracking, Top-Lizenzen
- ✨ **HMAC-Signierung**: Signierte Validate-Antworten
- ✨ **Replay-Schutz**: Nonce-basierter Schutz (5-Minuten-Fenster)
- ✨ **Offline Tokens**: JWT-basiert, konfigurierbarer Zeitraum (max. 7 Tage)
- ✨ **Audit Log**: Alle Aktionen protokolliert (max. 2000 Einträge)
- ✨ **Impersonate**: Superadmin kann Lizenz-Kontext für Support einsehen
- ✨ **Admin Panel**: 5 Tabs (Lizenzen, Kunden, Geräte, Analytics, Audit Log)
- 🔒 Verschärftes Rate Limiting auf Validate-Endpoint
- 🔄 **Vollständig backward-kompatibel** — existierende Clients unverändert

### v1.1.0
- Admin-Benutzer-Verwaltung (superadmin/admin Rollen)
- Rate Limiting auf Login-Endpoint
- CORS-Konfiguration via `.env`

### v1.0.0
- Initiales Release
- Lizenz-Validierung mit Plänen (FREE, STARTER, PRO, PRO_PLUS, ENTERPRISE)
- Admin Panel mit Login
- Domain-Whitelist / Wildcard-Support

---

## 📄 Lizenz

Proprietär — Alle Rechte vorbehalten. Nur für den internen Einsatz im OPA-Santorini System.
