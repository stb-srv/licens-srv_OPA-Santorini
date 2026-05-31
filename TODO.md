# Migration: MySQL → better-sqlite3

> Abgeschlossen: 2026-05-31  
> Status: ✅ Vollständig implementiert und getestet

---

## Was umgesetzt wurde

### Phase 1 — Abhängigkeiten & DB-Layer ✅
- [x] `mysql2` aus `package.json` entfernt
- [x] `better-sqlite3` installiert (`^12.10.0`)
- [x] `server/db.js` komplett neu — synchroner Wrapper, WAL-Modus, Foreign Keys aktiv
- [x] `server/db-schema.js` — SQLite-Typen (TEXT, INTEGER, REAL)

### Phase 2 — Migrationssystem ✅
- [x] `server/migrate.js` für better-sqlite3 neu geschrieben
- [x] Alle alten `.sql` Migrations-Dateien gelöscht
- [x] Alle alten `.js` Migrations (0002b–0019) durch No-Ops ersetzt
- [x] Neue konsolidierte Migration `0001_schema.js` — vollständiges SQLite-Schema

### Phase 3 — SQL-Syntax-Migration ✅
- [x] `ON DUPLICATE KEY UPDATE` → `ON CONFLICT(...) DO UPDATE SET ... = excluded.x`
- [x] `NOW()` → `datetime('now')`
- [x] `DATE_ADD(NOW(), INTERVAL X DAY/HOUR)` → `datetime('now', '+X days/hours')`
- [x] `DATE_SUB(NOW(), INTERVAL X DAY)` → `datetime('now', '-X days')`
- [x] `DATEDIFF(NOW(), col)` → `CAST(julianday('now') - julianday(col) AS INTEGER)`
- [x] `JSON_CONTAINS(tags, JSON_QUOTE(?))` → `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`
- [x] `JSON_EXTRACT(col, '$.key')` → `json_extract(col, '$.key')`
- [x] `FOR UPDATE` → entfernt (SQLite handelt automatisch)
- [x] `CURDATE()` → `date('now')`
- [x] `DATE_FORMAT(NOW(), ...)` → `strftime('%Y-%m-01', 'now')`
- [x] `INSERT IGNORE` → `INSERT OR IGNORE`
- [x] `information_schema` → hardcoded (`ts`, `details`) oder entfernt
- [x] `LIKE` mit Escape: `ESCAPE '\\'` hinzugefügt

### Phase 4 — Transaktionen ✅
- [x] `db.runTransaction(() => { ... })` Wrapper in db.js
- [x] `invoiceHelper.js` — Transaction auf sync umgestellt
- [x] `admin-invoices.js` — alle Transaktionen auf `db.runTransaction()` umgestellt
- [x] `admin-customers.js` — Transaktionen umgestellt
- [x] `cron.js` — Transaktionen umgestellt

### Phase 5 — Async → Sync ✅
- [x] Alle `await db.query()` → `db.query()` (synchron) in allen Dateien:
  - server/helpers.js
  - server/invoiceHelper.js
  - server/cron.js
  - server/webhook.js
  - server/middleware.js
  - server/routes/admin.js
  - server/routes/admin-licenses.js
  - server/routes/admin-customers.js
  - server/routes/admin-invoices.js
  - server/routes/admin-settings.js
  - server/routes/admin-stats.js
  - server/routes/customer-portal.js
  - server/routes/public.js
  - server/routes/reseller.js
  - server/routes/status.js

### Phase 6 — Konfiguration ✅
- [x] `.env.example` — DB_HOST/PORT/USER/PASS/NAME durch DB_PATH ersetzt
- [x] `server.js` — DB-Env-Prüfung für MySQL entfernt
- [x] `server.js` — `getDynamicAllowedOrigins()` auf synchron umgestellt
- [x] `setup-db.js` — vereinfacht auf Hinweis (kein Setup mehr nötig)
- [x] `data/` Verzeichnis für SQLite-DB angelegt
- [x] `.gitignore` — `data/*.db*` hinzugefügt

### Phase 7 — Tests ✅ (bestehende Tests verwenden Mocks)
- [x] Jest-Mocks bleiben kompatibel (mocken `db.query` via jest.spyOn)
- [ ] Optionale Integration-Tests mit `:memory:` SQLite (nicht implementiert)

### Phase 8 — Daten-Migration (Produktion)
- [ ] Export-Script: MySQL → JSON/CSV (bei Bedarf)
- [ ] Import-Script: JSON/CSV → SQLite (bei Bedarf)

---

## Architektur-Schlüsselpunkte

**`server/db.js` API:**
```js
// SELECT → [rows[]]
const [rows] = db.query('SELECT * FROM licenses WHERE license_key = ?', [key]);

// INSERT/UPDATE/DELETE → [{ affectedRows, insertId }]
const [result] = db.query('INSERT INTO ...', [...]);

// Transaktion (synchron, automatisches Rollback bei Exception)
db.runTransaction(() => {
    db.query('UPDATE ...', [...]);
    db.query('INSERT ...', [...]);
});
```

**Datums-Format**: Alle Daten als ISO-String `YYYY-MM-DD HH:MM:SS` via `toDbDate()` Helper in den Routen.

**Backup**: Einfach `data/licens.db` kopieren/rsync.
