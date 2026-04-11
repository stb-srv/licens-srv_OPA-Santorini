#!/bin/bash
set -e

# ============================================================
#  OPA! Santorini — License Server Deploy Script v2.0
#  Ubuntu 22.04 / 24.04 / 25.04 | Als root oder mit sudo
#  Nutzung: bash deploy.sh
# ============================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

APP_DIR="/opt/licens-srv"
APP_USER="licens-srv"
REPO="https://github.com/stb-srv/licens-srv_OPA-Santorini.git"
SERVICE_NAME="licens-srv"
PORT=4000

echo -e ""
echo -e "${BOLD}${CYAN}🏛️  OPA! Santorini — License Server Deploy v2.0${NC}"
echo -e "${CYAN}$(printf '═%.0s' {1..55})${NC}\n"

# ── Root-Check ─────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}✗ Bitte als root oder mit sudo ausführen!${NC}"
    exit 1
fi

# ── 1. System-Pakete & Node.js 22 ─────────────────────────────────────────
echo -e "${BOLD}[1/8] System updaten & Node.js 22 installieren...${NC}"
apt-get update -qq
apt-get install -y -qq curl git openssl

if ! command -v node &>/dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - &>/dev/null
    apt-get install -y -qq nodejs
fi
echo -e "  ${GREEN}✓ Node.js $(node -v) bereit${NC}"

# ── 2. App-User ─────────────────────────────────────────────────────────────
echo -e "\n${BOLD}[2/8] App-User '${APP_USER}' prüfen...${NC}"
if ! id "$APP_USER" &>/dev/null; then
    useradd --system --shell /bin/bash --create-home "$APP_USER"
    echo -e "  ${GREEN}✓ User erstellt${NC}"
else
    echo -e "  ${GREEN}✓ User existiert bereits${NC}"
fi

# ── 3. Repo klonen / updaten ───────────────────────────────────────────────
echo -e "\n${BOLD}[3/8] Repository klonen / updaten...${NC}"
git config --global --add safe.directory "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
    chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
    sudo -u "$APP_USER" git config --global --add safe.directory "$APP_DIR"
    cd "$APP_DIR"
    # Konfliktfrei updaten: fetch + hard reset (kein stash, kein merge)
    sudo -u "$APP_USER" git fetch origin main
    sudo -u "$APP_USER" git reset --hard origin/main
else
    git clone "$REPO" "$APP_DIR"
    chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
fi
echo -e "  ${GREEN}✓ Repository aktuell${NC}"

# ── 4. .env generieren (nur wenn noch nicht vorhanden) ──────────────────────
echo -e "\n${BOLD}[4/8] .env konfigurieren & Secrets generieren...${NC}"

if [ ! -f "$APP_DIR/.env" ]; then
    echo -e "  ${CYAN}→ Generiere kryptografische Secrets...${NC}"

    # Zufällige Secrets generieren
    ADMIN_SECRET=$(openssl rand -hex 48)
    HMAC_SECRET=$(openssl rand -hex 48)

    # RSA-2048 Schlüsselpaar generieren
    echo -e "  ${CYAN}→ Generiere RSA-2048 Schlüsselpaar...${NC}"
    TEMP_KEY=$(mktemp)
    TEMP_PUB=$(mktemp)
    openssl genrsa -out "$TEMP_KEY" 2048 2>/dev/null
    openssl rsa -in "$TEMP_KEY" -pubout -out "$TEMP_PUB" 2>/dev/null

    # Private Key für .env inline (Newlines als \n)
    RSA_PRIVATE_KEY_INLINE=$(cat "$TEMP_KEY" | awk 'NF {printf "%s\\n", $0}' | sed 's/\\n$//')

    # Public Key als Datei speichern (für CMS)
    cp "$TEMP_PUB" "$APP_DIR/public.pem"
    chown "$APP_USER":"$APP_USER" "$APP_DIR/public.pem"
    chmod 644 "$APP_DIR/public.pem"

    # Private Key sicher ablegen
    cp "$TEMP_KEY" "$APP_DIR/private.pem"
    chown "$APP_USER":"$APP_USER" "$APP_DIR/private.pem"
    chmod 600 "$APP_DIR/private.pem"

    rm -f "$TEMP_KEY" "$TEMP_PUB"

    # .env schreiben
    cat > "$APP_DIR/.env" <<EOF
PORT=${PORT}

# Admin JWT Secret (automatisch generiert)
ADMIN_SECRET=${ADMIN_SECRET}

# HMAC Signing Secret (automatisch generiert)
HMAC_SECRET=${HMAC_SECRET}

# RSA-2048 Private Key fuer signierte License Tokens (RS256)
RSA_PRIVATE_KEY="${RSA_PRIVATE_KEY_INLINE}"

# MySQL Datenbank
DB_HOST=10.35.46.188
DB_PORT=3306
DB_NAME=k220163_opa
DB_USER=k220163_opa
DB_PASS=BITTE_HIER_DEIN_DB_PASSWORT_EINTRAGEN

# CORS: erlaubte Origins (kommagetrennt)
CORS_ORIGINS=

# SMTP Konfiguration (optional, kann auch im Admin-Panel gesetzt werden)
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# Webhook (optional)
WEBHOOK_URL=
WEBHOOK_SECRET=
EOF

    chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"

    echo -e "  ${GREEN}✓ .env erstellt mit generierten Secrets${NC}"
    echo -e "  ${GREEN}✓ RSA Private Key: $APP_DIR/private.pem${NC}"
    echo -e "  ${GREEN}✓ RSA Public Key:  $APP_DIR/public.pem ${CYAN}(für CMS)${NC}"
    echo ""
    echo -e "  ${RED}${BOLD}❗ WICHTIG: DB-Passwort noch nicht gesetzt!${NC}"
    echo -e "  ${YELLOW}  Bitte jetzt eingeben: ${NC}"
    echo ""

    # DB-Passwort interaktiv abfragen
    read -s -p "  MySQL Passwort für '$APP_USER'@'10.35.46.188': " DB_PASS_INPUT
    echo ""

    if [ -n "$DB_PASS_INPUT" ]; then
        sed -i "s/BITTE_HIER_DEIN_DB_PASSWORT_EINTRAGEN/${DB_PASS_INPUT}/" "$APP_DIR/.env"
        echo -e "  ${GREEN}✓ DB-Passwort gesetzt${NC}"
    else
        echo -e "  ${YELLOW}⚠️  Kein Passwort eingegeben – bitte später in .env nachtragen: DB_PASS=...${NC}"
    fi

else
    echo -e "  ${GREEN}✓ .env existiert bereits – wird nicht überschrieben${NC}"
fi

# ── 5. npm install ─────────────────────────────────────────────────────────────
echo -e "\n${BOLD}[5/8] Dependencies installieren...${NC}"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev --silent
echo -e "  ${GREEN}✓ Dependencies installiert${NC}"

# ── 6. Datenbank-Schema + Migration ──────────────────────────────────────────
echo -e "\n${BOLD}[6/8] Datenbank-Schema & Migration...${NC}"
cd "$APP_DIR"
sudo -u "$APP_USER" node migrate.js

# ── 7. Systemd Service ─────────────────────────────────────────────────────────
echo -e "\n${BOLD}[7/8] Systemd Service einrichten...${NC}"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=OPA! Santorini License Server
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo -e "  ${GREEN}✓ Service läuft & Autostart aktiviert${NC}"
else
    echo -e "  ${RED}✗ Service gestartet aber möglicherweise Fehler – bitte prüfen:${NC}"
    echo -e "  ${YELLOW}  journalctl -fu ${SERVICE_NAME}${NC}"
fi

# ── 8. Zusammenfassung ─────────────────────────────────────────────────────────
echo -e "\n${BOLD}[8/8] Admin-Account prüfen...${NC}"
cd "$APP_DIR"
# Nur ausführen wenn setup-admin.js existiert
if [ -f "$APP_DIR/setup-admin.js" ]; then
    sudo -u "$APP_USER" node setup-admin.js
else
    echo -e "  ${CYAN}→ Admin wird automatisch durch migrate.js erstellt (admin / admin123)${NC}"
    echo -e "  ${RED}❗ Bitte sofort Passwort ändern!${NC}"
fi

echo ""
echo -e "${CYAN}$(printf '═%.0s' {1..55})${NC}"
echo -e "${GREEN}${BOLD}✅ Deploy abgeschlossen!${NC}"
echo ""
echo -e "  🏛️  Server läuft auf Port:   ${YELLOW}${PORT}${NC}"
echo -e "  🔑 RSA Public Key (für CMS): ${YELLOW}$APP_DIR/public.pem${NC}"
echo -e "  📝 Logs:                    ${YELLOW}journalctl -fu ${SERVICE_NAME}${NC}"
echo -e "  📊 Status:                  ${YELLOW}systemctl status ${SERVICE_NAME}${NC}"
echo ""
echo -e "  ${YELLOW}${BOLD}Nächste Schritte:${NC}"
echo -e "  ${YELLOW}1. Firewall: ufw allow ${PORT}${NC}"
echo -e "  ${YELLOW}2. Admin-Passwort ändern (Standard: admin123)${NC}"
echo -e "  ${YELLOW}3. RSA Public Key ins CMS kopieren: cat $APP_DIR/public.pem${NC}"
echo -e "  ${YELLOW}4. CORS_ORIGINS in .env setzen für Produktivbetrieb${NC}"
echo ""
