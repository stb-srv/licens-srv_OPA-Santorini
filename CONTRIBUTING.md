# 🤝 Mitwirken (Contributing)

Vielen Dank, dass du am **OPA! Santorini License Server** mitarbeiten möchtest! Hier sind einige Richtlinien, um den Prozess reibungslos zu gestalten.

## 🚀 Entwicklung starten

1. **Repository klonen**
   ```bash
   git clone https://github.com/stb-srv/licens-srv_OPA-Santorini.git
   cd licens-srv_OPA-Santorini
   ```

2. **Abhängigkeiten installieren**
   ```bash
   npm install
   ```

3. **Umgebung konfigurieren**
   Kopiere die `.env.example` nach `.env` und fülle die Werte aus.
   ```bash
   cp .env.example .env
   ```

4. **Datenbank initialisieren**
   Stelle sicher, dass MySQL läuft und eine Datenbank existiert, dann führe die Migrationen aus:
   ```bash
   node server/migrate.js
   ```

5. **Starten**
   ```bash
   npm run dev
   ```

## 🛠️ Code-Style & Architektur
- Wir nutzen **ES-Module** (`import/export`).
- Alle Routen sollten den `asyncHandler` aus `middleware.js` nutzen, um Fehler zentral abzufangen.
- Business-Logik gehört in die entsprechenden Files unter `server/`, Routen definieren nur das Interface.
- Neue Tabellen/Spalten müssen zwingend über ein neues Skript in `server/migrations/` hinzugefügt werden (idempotent!).

## 🔐 Sicherheit
- Checke niemals sensible Daten (`.env`, `db.json`, private Keys) in Git ein.
- Nutze für neue Features immer parametrisierte SQL-Queries.
- Prüfe Berechtigungen mit `requireAuth` und optional `requireSuperAdmin`.

## 📬 Pull Requests
1. Erstelle einen Feature-Branch (`feature/mein-feature`).
2. Committe deine Änderungen mit aussagekräftigen Nachrichten.
3. Pushe den Branch und erstelle einen Pull Request gegen `main`.
