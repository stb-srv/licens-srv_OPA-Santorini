# 🗝️ Grieche-CMS Lizenz-Server (Spezifikation)

Dieses Dokument beschreibt die serverseitige Implementierung des Lizenz-Management-Systems für das Grieche-CMS.

## 1. API Endpunkte

### `POST /api/v1/validate`
Prüft die Gültigkeit einer Lizenz für eine bestimmte Domain.

**Request Payload:**
```json
{
  "license_key": "XXXX-XXXX-XXXX-XXXX",
  "domain": "restaurant-athos.de",
  "hwid": "unique-server-id-optional"
}
```

**Response (Erfolg):**
```json
{
  "status": "active",
  "expires_at": "2026-12-31T23:59:59Z",
  "customer_name": "Restaurant Athos",
  "allowed_modules": {
    "qr_pay": true,
    "ordering": true,
    "reservations": true,
    "crm": true
  },
  "signature": "sha256-signed-hash-for-security"
}
```

**Response (Fehler):**
```json
{
  "status": "invalid",
  "reason": "domain_mismatch" // oder "expired", "key_not_found"
}
```

---

## 2. Datenbank-Struktur (Vorschlag)

Table `licenses`:
- `id`: UUID (Primary Key)
- `license_key`: String (Unique, Indexed)
- `associated_domain`: String (z.B. "localhost" für Dev, "restaurant.de" für Prod)
- `status`: Enum ('active', 'suspended', 'expired')
- `tier`: String (z.B. 'basic', 'premium', 'ultimate')
- `modules_config`: JSON (Definiert, welche Features freigeschaltet sind)
- `created_at`: Timestamp
- `expires_at`: Timestamp

---

## 3. Sicherheits-Mechanismen

1.  **Domain-Locking:** Ein Lizenzschlüssel kann nur von der hinterlegten Domain aus validiert werden.
2.  **Payload-Signierung:** Die Antwort des Servers wird mit einem Private Key signiert. Das CMS prüft die Signatur mit dem Public Key, um "Man-in-the-Middle" Angriffe oder lokale Manipulationen zu verhindern.
3.  **Rate-Limiting:** Schutz gegen Brute-Force Angriffe auf Lizenzschlüssel.

---

## 4. Admin-Interface (Master-Panel)

Ein separates Dashboard für den Entwickler (Dich), um:
- Neue Lizenzen zu generieren.
- Domains manuell zu ändern.
- Statistiken zu sehen (Welches Restaurant nutzt welches Modul?).
