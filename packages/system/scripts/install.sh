#!/usr/bin/env bash
set -e

INSTALL_DIR=/opt/unguibus
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

echo "Installing unguibus to $INSTALL_DIR..."

mkdir -p "$INSTALL_DIR"
cp -r "$PROJECT_DIR"/. "$INSTALL_DIR/"

npm install --prefix "$INSTALL_DIR"
npm run build -w @unguibus/system

cp "$INSTALL_DIR/packages/system/systemd/unguibus.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now unguibus.service

echo "Done. unguibus running on http://127.0.0.1:3000"
echo "Check status: systemctl status unguibus"
echo "Logs: journalctl -u unguibus -f"
