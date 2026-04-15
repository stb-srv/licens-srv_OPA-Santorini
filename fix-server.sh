#!/bin/bash
# ============================================================
# fix-server.sh — OPA Santorini Lizenzserver Reparatur-Script
# Behebt: RSA Key Mismatch, fehlende DB-Spalten, Session-Probleme
#
# Ausführen:
#   bash /opt/licens-srv/fix-server.sh
# ============================================================

set -e
cd /opt/licens-srv

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "\n\033[1m🔧 OPA Santorini — Server Reparatur\033[0m\n"

# ── 1. Git Pull ────────────────────────────────────────────────────────
echo -e "${YELLOW}[1/4] Neuesten Code laden...${NC}"
git pull
echo -e "${GREEN}  ✅ git pull abgeschlossen${NC}"

# ── 2. .env laden ────────────────────────────────────────────────────
echo -e "\n${YELLOW}[2/4] RSA Public Key aus Private Key ableiten...${NC}"

if [ ! -f .env ]; then
  echo -e "${RED}  ❌ .env nicht gefunden unter /opt/licens-srv/.env${NC}"
  exit 1
fi

# Private Key aus .env extrahieren und Public Key ableiten
PRIVATE_KEY_RAW=$(grep 'RSA_PRIVATE_KEY' .env | head -1 | sed 's/RSA_PRIVATE_KEY=//;s/^"//;s/"$//')

if [ -z "$PRIVATE_KEY_RAW" ]; then
  echo -e "${YELLOW}  ⚠️  Kein RSA_PRIVATE_KEY in .env — HS256 Modus wird verwendet, kein Fix nötig${NC}"
else
  # \n in echte Newlines umwandeln
  PRIVATE_KEY=$(echo -e "$PRIVATE_KEY_RAW" | sed 's/\\n/\n/g')

  # Public Key ableiten
  PUBLIC_KEY=$(echo "$PRIVATE_KEY" | openssl pkey -pubout 2>/dev/null)

  if [ -z "$PUBLIC_KEY" ]; then
    echo -e "${RED}  ❌ Public Key konnte nicht abgeleitet werden — Private Key ungültig?${NC}"
    echo "  Bitte prüfe RSA_PRIVATE_KEY in .env"
    exit 1
  fi

  # Public Key für .env formatieren (Newlines als \n)
  PUBLIC_KEY_ONELINE=$(echo "$PUBLIC_KEY" | awk 'NF {printf "%s\\n", $0}' | sed 's/\\n$//')

  # Existiert RSA_PUBLIC_KEY bereits in .env?
  if grep -q 'RSA_PUBLIC_KEY' .env; then
    # Ersetzen
    sed -i "s|RSA_PUBLIC_KEY=.*|RSA_PUBLIC_KEY=\"${PUBLIC_KEY_ONELINE}\"|" .env
    echo -e "${GREEN}  ✅ RSA_PUBLIC_KEY in .env aktualisiert${NC}"
  else
    # Neu hinzufügen
    echo "RSA_PUBLIC_KEY=\"${PUBLIC_KEY_ONELINE}\"" >> .env
    echo -e "${GREEN}  ✅ RSA_PUBLIC_KEY zu .env hinzugefügt${NC}"
  fi
fi

# ── 3. DB Schema reparieren ───────────────────────────────────────────────
echo -e "\n${YELLOW}[3/4] Datenbank-Schema reparieren...${NC}"
node migrate-schema.js

# ── 4. Server neustarten ─────────────────────────────────────────────────
echo -e "\n${YELLOW}[4/4] Server neustarten...${NC}"
systemctl restart licens-srv.service
sleep 3

STATUS=$(systemctl is-active licens-srv.service)
if [ "$STATUS" = "active" ]; then
  echo -e "${GREEN}  ✅ licens-srv.service läuft${NC}"
else
  echo -e "${RED}  ❌ licens-srv.service Status: $STATUS${NC}"
  journalctl -u licens-srv.service -n 20 --no-pager
  exit 1
fi

# ── 5. Login testen ───────────────────────────────────────────────────
echo -e "\n${YELLOW}[5/5] Login-Test...${NC}"

# Admin-User aus DB holen
DOTENV_DB_HOST=$(grep DB_HOST .env | head -1 | sed 's/DB_HOST=//;s/"//g')
DOTENV_DB_USER=$(grep 'DB_USER' .env | head -1 | sed 's/DB_USER=//;s/"//g')
DOTENV_DB_PASS=$(grep 'DB_PASS' .env | head -1 | sed 's/DB_PASS=//;s/"//g')
DOTENV_DB_NAME=$(grep 'DB_NAME' .env | head -1 | sed 's/DB_NAME=//;s/"//g')
DOTENV_DB_PORT=$(grep 'DB_PORT' .env | head -1 | sed 's/DB_PORT=//;s/"//g')
DOTENV_DB_PORT=${DOTENV_DB_PORT:-3306}

ADMIN_USER=$(mysql -h "$DOTENV_DB_HOST" -P "$DOTENV_DB_PORT" -u "$DOTENV_DB_USER" -p"$DOTENV_DB_PASS" "$DOTENV_DB_NAME" \
  -se "SELECT username FROM admins LIMIT 1" 2>/dev/null || echo "")

if [ -z "$ADMIN_USER" ]; then
  echo -e "${YELLOW}  ⚠️  Kein Admin gefunden — Login-Test übersprungen${NC}"
else
  echo -e "  Admin gefunden: ${ADMIN_USER}"
  echo -e "  Manuell testen:\n"
  echo -e "  curl -s -X POST https://licens-prod.stb-srv.de/api/admin/login \\"
  echo -e "    -H 'Content-Type: application/json' \\"
  echo -e "    -d '{\"username\":\"${ADMIN_USER}\",\"password\":\"DEIN_PASSWORT\"}' | jq ."
fi

echo -e "\n${GREEN}\033[1m✅ Reparatur abgeschlossen!\033[0m${NC}\n"
