# 🛡️ OPA! Santorini License Server — Security Audit

Stand: 16.04.2026

## 1. Authentifizierung & Autorisierung
- **Admin-API**: Verwendet JWT (RS256 bevorzugt, HS256 als Fallback).
- **Kunden-Portal**: Verwendet JWT (HS256) mit separatem `PORTAL_SECRET`.
- **Session-Management**: Alle Sessions werden in der DB (`admin_sessions`, `customer_sessions`) getrackt. Logout bewirkt einen serverseitigen Widerruf (`revoked = 1`).
- **Passwörter**: Hashes werden mit `bcryptjs` (Round 12) gespeichert.
- **Rollensystem**: Unterscheidung zwischen `admin` und `superadmin`.

## 2. API-Sicherheit
- **Rate-Limiting**: Implementiert für Login, Setup, Lizenz-Validierung und Bulk-Operationen via `express-rate-limit`.
- **Datenbank**: Alle SQL-Abfragen verwenden parametrisierte Statements (`mysql2/promise`), um SQL-Injection zu verhindern.
- **Header**: `helmet` sorgt für sichere HTTP-Header (HSTS, CSP, etc.).
- **CORS**: Dynamisch konfiguriert über DB oder `.env`.

## 3. Lizenz-Sicherheit
- **RS256 Signing**: Lizenz-Tokens werden mit RSA signiert. Das CMS validiert diese mit dem Public Key.
- **Offline-Tokens**: Werden mit HMAC-SHA256 für begrenzte Zeiträume (max. 168h) ausgestellt.
- **Domain-Locking**: Validierung prüft `associated_domain` (Wildcards unterstützt).
- **Nonce-Check**: Schutz gegen Replay-Attacks bei der Validierung.

## 4. Audit & Monitoring
- **Audit-Log**: Alle kritischen Aktionen (Logins, Lizenzänderungen, Webhook-Erstellungen) werden inkl. Actor, IP und Zeitstempel geloggt.
- **Health-Check**: `/api/health` liefert Status über DB-Verbindung.
- **Webhooks**: Unterstützen HTTP-Signatur (HMAC-SHA256), um die Authentizität gegenüber Empfängern zu gewährleisten.

## 5. Offene Empfehlungen (TODOs)
- [ ] IP-Whitelist für Admin-Login implementieren.
- [ ] 2-Faktor-Authentifizierung (TOTP) für Admins hinzufügen.
- [ ] Automatisierte Vullnerability-Scans (z.B. `npm audit`) in CI integrieren.
- [ ] Regelmäßige Backups der MySQL-Datenbank automatisieren.
