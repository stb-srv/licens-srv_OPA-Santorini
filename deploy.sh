#!/bin/bash
set -e

# ============================================================
#  OPA Santorini - License Server Deploy Script
#  Ubuntu 25.04 | Run as root or with sudo
#  Usage: bash deploy.sh
# ============================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

APP_DIR="/opt/licens-srv"
APP_USER="licens-srv"
REPO="https://github.com/stb-srv/licens-srv_OPA-Santorini.git"
SERVICE_NAME="licens-srv"
PORT=4000

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  OPA License Server - Auto Deploy${NC}"
echo -e "${GREEN}========================================${NC}"

# ── 1. System Update & Node.js 22 installieren ──────────────
echo -e "\n${YELLOW}[1/7] System updaten & Node.js 22 installieren...${NC}"
apt-get update -qq
apt-get install -y -qq curl git

if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
fi
echo -e "${GREEN}  Node.js $(node -v) bereit${NC}"

# ── 2. App-User erstellen ────────────────────────────────────
echo -e "\n${YELLOW}[2/7] App-User '${APP_USER}' erstellen...${NC}"
if ! id "$APP_USER" &>/dev/null; then
    useradd --system --shell /bin/bash --create-home "$APP_USER"
    echo -e "${GREEN}  User erstellt${NC}"
else
    echo -e "${GREEN}  User existiert bereits${NC}"
fi

# ── 3. Repo klonen oder updaten ──────────────────────────────
echo -e "\n${YELLOW}[3/7] Repository klonen / updaten...${NC}"

# Fix: safe.directory global für root setzen damit git nicht meckert
git config --global --add safe.directory "$APP_DIR"

if [ -d "$APP_DIR/.git" ]; then
    # Ownership fix: sicherstellen dass alles dem App-User gehört
    chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
    # safe.directory auch für den App-User setzen
    sudo -u "$APP_USER" git config --global --add safe.directory "$APP_DIR"
    cd "$APP_DIR"
    sudo -u "$APP_USER" git pull origin main
else
    git clone "$REPO" "$APP_DIR"
    chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
fi
echo -e "${GREEN}  Repository aktuell${NC}"

# ── 4. .env erstellen (falls nicht vorhanden) ────────────────
echo -e "\n${YELLOW}[4/7] .env konfigurieren...${NC}"
if [ ! -f "$APP_DIR/.env" ]; then
    GENERATED_SECRET=$(openssl rand -hex 48)
    cat > "$APP_DIR/.env" <<EOF
PORT=${PORT}
ADMIN_SECRET=${GENERATED_SECRET}
EOF
    chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
    chmod 600 "$APP_DIR/.env"
    echo -e "${GREEN}  .env erstellt mit zufälligem ADMIN_SECRET${NC}"
    echo -e "${YELLOW}  ADMIN_SECRET: ${GENERATED_SECRET}${NC}"
else
    echo -e "${GREEN}  .env existiert bereits - wird nicht überschrieben${NC}"
fi

# ── 5. npm install ───────────────────────────────────────────
echo -e "\n${YELLOW}[5/7] Dependencies installieren...${NC}"
cd "$APP_DIR"
sudo -u "$APP_USER" npm install --omit=dev
echo -e "${GREEN}  Dependencies installiert${NC}"

# ── 6. Systemd Service einrichten ───────────────────────────
echo -e "\n${YELLOW}[6/7] Systemd Service einrichten...${NC}"
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=OPA Santorini License Server
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
echo -e "${GREEN}  Service gestartet & autostart aktiviert${NC}"

# ── 7. Admin-Account erstellen ───────────────────────────────
echo -e "\n${YELLOW}[7/7] Admin-Account einrichten...${NC}"
echo -e "${YELLOW}  Bitte Zugangsdaten eingeben:${NC}"
cd "$APP_DIR"
sudo -u "$APP_USER" node setup-admin.js

# ── Fertig ───────────────────────────────────────────────────
echo -e "\n${GREEN}========================================${NC}"
echo -e "${GREEN}  Deploy erfolgreich abgeschlossen!${NC}"
echo -e "${GREEN}========================================${NC}"
echo -e "  Server läuft auf Port: ${YELLOW}${PORT}${NC}"
echo -e "  Logs: ${YELLOW}journalctl -fu ${SERVICE_NAME}${NC}"
echo -e "  Status: ${YELLOW}systemctl status ${SERVICE_NAME}${NC}"
echo -e "  Stoppen: ${YELLOW}systemctl stop ${SERVICE_NAME}${NC}"
echo -e "\n${YELLOW}  WICHTIG: Stelle sicher dass Port ${PORT} in der Firewall freigegeben ist:${NC}"
echo -e "  ${YELLOW}ufw allow ${PORT}${NC}\n"
