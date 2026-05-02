# AGENTS.md — AI Context File
> Dieses File gibt KI-Assistenten (Perplexity, Copilot, etc.) sofortigen Kontext über das Projekt.

---

## Projekt-Übersicht
- **Name:** OPA! Santorini License Server
- **Version:** 2.1
- **Zweck:** REST-API Lizenzserver für das OPA-Santorini Restaurant-Management-System (CMS)
- **Stack:** Node.js (ESM), Express.js, MySQL/MariaDB, JWT (RS256 + HS256), bcryptjs
- **Port:** `4000` (default)
- **Repo:** https://github.com/stb-srv/licens-srv_OPA-Santorini

---

## Dateistruktur
```
/
├── server.js               # Entry Point – App-Setup, CORS, Helmet, DB-Check, Server-Start
├── server/
│   ├── db.js               # MySQL Connection Pool (mysql2/promise)
│   ├── crypto.js           # RSA Key-Handling, JWT Signing (RS256), HMAC Signing
│   ├── middleware.js       # requireAuth, requireSuperAdmin, Rate-Limiters
│   ├── helpers.js          # generateKey, getClientIp, addAuditLog, parseJsonField, domainMatches
│   ├── plans.js            # PLAN_DEFINITIONS (FREE, BASIC, PRO, ENTERPRISE)
│   ├── cron.js             # Cron-Jobs: Lizenz-Ablauf, Nonce-Cleanup
│   ├── smtp.js             # Nodemailer SMTP-Transporter aus DB
│   ├── webhook.js          # fireWebhook() – HTTP POST an konfigurierte Webhook-URLs
│   └── routes/
│       ├── public.js       # Öffentliche API-Endpunkte (validate, heartbeat, refresh, setup)
│       └── admin.js        # Admin-API (Auth-Guard: requireAuth + requireSuperAdmin)
├── setup-db.js             # DB-Tabellen erstellen (erstmaliges Setup)
├── setup-admin.js          # Superadmin-Account anlegen (CLI)
├── migrate.js              # Migrationsskript SQLite → MySQL
├── deploy.sh               # Deploy-Script (git pull, npm ci, pm2 restart)
├── update.sh               # Update-Script (ähnlich deploy.sh)
├── public/                 # Statisches Frontend (Admin-UI)
├── .env.example            # Alle benötigten Umgebungsvariablen
└── db.json                 # ⚠️ ACHTUNG: Sollte in .gitignore (evtl. Lizenzdaten!)
```

---

## Umgebungsvariablen (.env)
```env
PORT=4000
ADMIN_SECRET=         # JWT-Secret für Admin-Tokens (HS256) — PFLICHT
HMAC_SECRET=          # HMAC-Secret für Offline-Tokens — PFLICHT
SETUP_TOKEN=          # Einmal-Token für /api/v1/setup (nach Setup löschen)
RSA_PRIVATE_KEY=      # RSA Private Key (PEM) für License-JWTs (RS256)
RSA_PUBLIC_KEY=       # RSA Public Key (PEM)
CORS_ORIGINS=         # Komma-getrennte Allowed Origins (optional, sonst nur DB-dynamisch)
DB_HOST=
DB_PORT=3306
DB_USER=
DB_PASS=
DB_NAME=
SMTP_HOST=            # Optional – auch via Admin-UI in DB konfigurierbar
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
```

---

## API-Endpunkte

### Public (`/api/v1/`)
| Method | Route | Beschreibung |
|--------|-------|--------------|
| POST | `/setup` | Erstellt ersten Superadmin (nur wenn SETUP_TOKEN gesetzt) |
| POST | `/validate` | Lizenz validieren (Domain, Device, Nonce-Check) |
| POST | `/heartbeat` | Herzschlag-Check – aktualisiert `last_heartbeat` |
| POST | `/refresh` | Token erneuern (alle 72h vom CMS aufgerufen) |
| POST | `/verify-license-token` | RS256 JWT verifizieren |
| POST | `/offline-token` | Offline-Token ausstellen (max. 168h) |
| POST | `/verify-offline-token` | Offline-Token prüfen |
| GET  | `/public-key` | RSA Public Key abrufen |

### Admin (`/api/admin/`) — Alle Routen: `requireAuth` Pflicht
| Method | Route | Rolle | Beschreibung |
|--------|-------|-------|--------------|
| POST | `/login` | — | Admin Login → JWT |
| GET/POST | `/users` | superadmin | Admin-User verwalten |
| DELETE | `/users/:username` | superadmin | User löschen |
| PATCH | `/users/:username/password` | self/superadmin | Passwort ändern |
| GET | `/plans` | admin | Pläne abrufen |
| GET/POST | `/licenses` | admin | Lizenzen verwalten |
| GET | `/licenses/:key` | admin | Einzelne Lizenz |
| PATCH | `/licenses/:key/status` | admin | Status ändern |
| POST | `/licenses/:key/renew` | admin | Verlängern |
| DELETE | `/licenses/:key` | admin | Löschen |
| PATCH | `/licenses/:key/customer` | admin | Kunde verknüpfen |
| GET/POST/PATCH/DELETE | `/customers` | admin | Kundenverwaltung |
| GET | `/devices` | admin | Geräte-Liste |
| PATCH | `/devices/:id/deactivate` | admin | Gerät deaktivieren |
| DELETE | `/devices/:id` | admin | Gerät löschen |
| GET | `/analytics` | admin | Nutzungsstatistiken |
| GET | `/audit-log` | admin | Audit-Log (max. 1000) |
| GET/POST/DELETE | `/smtp` | superadmin | SMTP-Konfiguration |
| POST | `/smtp/test` | superadmin | SMTP-Test |
| GET/POST/DELETE | `/webhooks` | superadmin | Webhook-Verwaltung |
| GET | `/webhook-logs` | admin | Webhook-Logs abrufen |
| POST | `/impersonate` | superadmin | Lizenz-Kontext einsehen |

---

## Datenbank-Tabellen
| Tabelle | Beschreibung |
|---------|-------------|
| `licenses` | Lizenzen mit Key, Typ, Status, Domain, Expiry, Analytics |
| `customers` | Kundenstammdaten (Name, E-Mail, Firma) |
| `devices` | Registrierte Geräte pro Lizenz |
| `admins` | Admin-User (bcrypt-gehashed, Rolle: admin/superadmin) |
| `audit_log` | Alle sicherheitsrelevanten Aktionen mit Timestamp + IP |
| `used_nonces` | Nonce-Replay-Protection (TTL-Cleanup per Cron) |
| `smtp_config` | SMTP-Konfiguration (in DB gespeichert, 1 Zeile) |
| `webhooks` | Webhook-URLs + Events |
| `webhook_logs` | Historie der Webhook-Aufrufe (Erfolg/Fehler) |

---

## Bekannte offene Punkte / TODOs
- [x] **Branch Protection** auf `main` aktivieren (aktuell direktes Pushen möglich)
- [x] `db.json` aus Git entfernen → `.gitignore` eintragen
- [x] Admin-JWTs auf RS256 migrieren (RS256 wird genutzt wenn RSA-Keys vorhanden sind)
- [x] `/offline-token` Endpunkt: Domain-Validierung gegen `associated_domain` hinzugefügt
- [x] Bug: `analytics_features` Zählung korrigiert (+1 statt undefined)
- [x] Globalen Express Error-Handler eingefügt
- [x] `SELECT *` durch explizite Felder in kritischen Routen ersetzt

---

## Lizenzpläne (PLAN_DEFINITIONS)
| Plan | Label | Ablauf |
|------|-------|--------|
| FREE | Free | 30 Tage |
| BASIC | Basic | 365 Tage |
| PRO | Pro | 365 Tage |
| ENTERPRISE | Enterprise | 730 Tage |

---

## Authentifizierung
- **Admin-Login:** `POST /api/admin/login` → JWT (HS256, 8h Gültigkeit) → `Authorization: Bearer <token>`
- **License-Tokens:** RS256 JWT (73h Gültigkeit) — signiert mit RSA_PRIVATE_KEY
- **Offline-Tokens:** HS256 mit HMAC_SECRET (max. 168h)
- **Setup:** Einmalig via `X-Setup-Token` Header oder `setup_token` im Body

---

## Deployment
```bash
# Erstmalig
bash deploy.sh

# Update
bash update.sh

# PM2
pm2 start server.js --name licens-srv
pm2 save
```
