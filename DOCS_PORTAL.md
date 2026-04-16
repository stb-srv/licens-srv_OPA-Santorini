# 📑 Kunden-Portal API — Dokumentation

Das Kunden-Portal ermöglicht Endkunden (z.B. den Restaurants), ihre Lizenzen zu verwalten, Domains zu binden und ihre Kaufhistorie einzusehen.

## Authentifizierung
Alle Anfragen außer `/login` und `/forgot-password` erfordern einen Bearer-Token im Header:
`Authorization: Bearer <JWT>`

Die Authentifizierung erfolgt über JWT (HS256) signiert mit `PORTAL_SECRET`.
Sessions werden zusätzlich in der Tabelle `customer_sessions` getrackt und können serverseitig widerrufen werden.

## Endpunkte (`/api/portal/`)

| Methode | Route | Beschreibung | Brute-Force Schutz |
| :--- | :--- | :--- | :--- |
| `POST` | `/login` | Login via E-Mail/Username + Passwort | **Ja** (10/15min) |
| `POST` | `/logout` | Beendet die aktuelle Session | - |
| `POST` | `/forgot-password` | Sendet Reset-Link per E-Mail | **Ja** (5/1h) |
| `POST` | `/setup-password` | Setzt Initial-Passwort (Einmal-Token) | **Ja** (5/1h) |
| `GET` | `/me` | Aktuelle Kundendaten abrufen | - |
| `PATCH` | `/update-profile`| Profil bearbeiten (Name, Firma, Tel) | - |
| `GET` | `/licenses` | Liste aller Lizenzen des Kunden | - |
| `PATCH` | `/licenses/:id/domain` | Domain einer Lizenz binden / ändern | - |
| `GET` | `/history` | Kaufhistorie (letzte 200 Einträge) | - |
| `POST` | `/change-password` | Passwort im eingeloggten Zustand ändern | - |

## Sicherheits-Features
- **Rate-Limiting**: Kritische Endpunkte sind gegen Brute-Force-Angriffe geschützt.
- **Session-Rotation**: Tokens sind 24h gültig und werden in der DB persistiert.
- **SQL-Injection**: Alle Abfragen verwenden parametrisierte Statements.
- **Password Hashing**: Passwörter werden mit `bcryptjs` (Cost 12) gehasht.
- **Email Enumeration**: `/forgot-password` gibt keine Hinweise darauf, ob eine E-Mail-Adresse existiert.
- **Password Enforcement**: Wenn `must_change_password` gesetzt ist, ist das Portal bis zur Passwortänderung gesperrt.

## Einrichtung
Um das Portal zu nutzen, muss in der `.env` gesetzt sein:
- `PORTAL_SECRET`: Ein sicherer JWT-Key.
- `PORTAL_URL`: Basis-URL für die Links in den Einladungs-Mails.
