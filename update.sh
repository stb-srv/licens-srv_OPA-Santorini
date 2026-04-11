#!/bin/bash
# ============================================================
# OPA! Santorini License Server — Auto-Update Script
# ============================================================
# Dieses Script:
#  1. Erstellt ein Backup der db.json (falls vorhanden)
#  2. Pullt die neuesten Änderungen von GitHub
#  3. Installiert neue Dependencies
#  4. Führt die Migration durch
#  5. Startet den Server neu (pm2 oder node)
#
# Nutzung:
#   bash update.sh
# ============================================================

set -e

# Farben
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
BOLD="\033[1m"
NC="\033[0m"

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
PM2_APP_NAME="opa-license-server"

echo ""
echo -e "${BOLD}${CYAN}🏛️  OPA! Santorini License Server — Update Script${NC}"
echo -e "${CYAN}$(printf '═%.0s' {1..55})${NC}"
echo -e "${CYAN}📁 Projektverzeichnis: $PROJECT_DIR${NC}"
echo ""

# ── Schritt 1: Backup erstellen ───────────────────────────────────────────────
echo -e "${BOLD}📦 Schritt 1/5: Backup erstellen...${NC}"
mkdir -p "$BACKUP_DIR"

if [ -f "$PROJECT_DIR/db.json" ]; then
    cp "$PROJECT_DIR/db.json" "$BACKUP_DIR/db_$TIMESTAMP.json"
    echo -e "  ${GREEN}✓ db.json gesichert → backups/db_$TIMESTAMP.json${NC}"
else
    echo -e "  ${YELLOW}⚠️  Keine db.json gefunden – kein Backup nötig${NC}"
fi

# Alte Backups aufräumen (nur die letzten 10 behalten)
cd "$BACKUP_DIR" && ls -t db_*.json 2>/dev/null | tail -n +11 | xargs -r rm --
echo -e "  ${GREEN}✓ Backups bereinigt (max. 10)${NC}"

# ── Schritt 2: Git Pull ────────────────────────────────────────────────────────
echo -e "\n${BOLD}📥 Schritt 2/5: Neueste Version von GitHub holen...${NC}"
cd "$PROJECT_DIR"

# Lokale Änderungen an server.js und package.json stashen
if git diff --quiet HEAD -- server.js package.json setup-db.js migrate.js 2>/dev/null; then
    echo -e "  ${GREEN}✓ Keine lokalen Änderungen${NC}"
else
    echo -e "  ${YELLOW}⚠️  Lokale Änderungen gefunden – werden gestasht${NC}"
    git stash push -m "auto-stash-before-update-$TIMESTAMP" -- server.js package.json setup-db.js migrate.js 2>/dev/null || true
fi

CURRENT_SHA=$(git rev-parse HEAD 2>/dev/null || echo 'unbekannt')
git pull origin main --ff-only
NEW_SHA=$(git rev-parse HEAD 2>/dev/null || echo 'unbekannt')

if [ "$CURRENT_SHA" = "$NEW_SHA" ]; then
    echo -e "  ${YELLOW}⚠️  Bereits auf dem neuesten Stand ($NEW_SHA)${NC}"
else
    echo -e "  ${GREEN}✓ Update: $CURRENT_SHA → $NEW_SHA${NC}"
fi

# ── Schritt 3: Dependencies installieren ──────────────────────────────────────
echo -e "\n${BOLD}📦 Schritt 3/5: Dependencies installieren...${NC}"
cd "$PROJECT_DIR"
npm install --omit=dev --silent
echo -e "  ${GREEN}✓ npm install abgeschlossen${NC}"

# ── Schritt 4: Migration durchführen ──────────────────────────────────────────
echo -e "\n${BOLD}🔄 Schritt 4/5: Daten migrieren...${NC}"
cd "$PROJECT_DIR"
node migrate.js

# ── Schritt 5: Server neu starten ─────────────────────────────────────────────
echo -e "\n${BOLD}🚀 Schritt 5/5: Server neu starten...${NC}"
cd "$PROJECT_DIR"

if command -v pm2 &>/dev/null; then
    if pm2 describe "$PM2_APP_NAME" &>/dev/null; then
        pm2 restart "$PM2_APP_NAME"
        echo -e "  ${GREEN}✓ PM2: '$PM2_APP_NAME' neu gestartet${NC}"
        pm2 status "$PM2_APP_NAME"
    else
        pm2 start server.js --name "$PM2_APP_NAME" --interpreter node
        echo -e "  ${GREEN}✓ PM2: '$PM2_APP_NAME' neu gestartet (erstmalig)${NC}"
    fi
elif systemctl is-active --quiet "$PM2_APP_NAME" 2>/dev/null; then
    systemctl restart "$PM2_APP_NAME"
    echo -e "  ${GREEN}✓ systemd: '$PM2_APP_NAME' neu gestartet${NC}"
else
    echo -e "  ${YELLOW}⚠️  Kein PM2/systemd gefunden – bitte manuell starten: npm start${NC}"
fi

echo ""
echo -e "${CYAN}$(printf '═%.0s' {1..55})${NC}"
echo -e "${GREEN}${BOLD}✅ Update abgeschlossen! OPA! Santorini License Server läuft.${NC}"
echo -e "${CYAN}   Backup gespeichert in: $BACKUP_DIR${NC}"
echo ""
