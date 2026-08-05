#!/bin/bash
# One-command setup for running Expense Tracker permanently on a Mac.
# - Installs dependencies
# - Creates .env with a fresh encryption key (first run only)
# - Installs a LaunchAgent so the server starts at login and restarts if it crashes
#
# Usage:  bash deploy/install-on-mac.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.expense-tracker.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$APP_DIR/data"

cd "$APP_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it first:"
  echo "  brew install node    (or download from https://nodejs.org)"
  exit 1
fi
NODE_BIN="$(command -v node)"
echo "Using node: $NODE_BIN ($(node --version))"

echo "Installing dependencies…"
npm install --omit=dev

if [ ! -f .env ]; then
  echo "Creating .env with a fresh encryption key…"
  KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  cat > .env <<EOF
PORT=3000
ENCRYPTION_KEY=$KEY
# Add Plaid keys here to link real banks (see README):
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox
# Set to true if you serve over HTTPS (e.g. tailscale serve):
SECURE_COOKIES=false
EOF
  chmod 600 .env
else
  echo ".env already exists — keeping it."
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

echo "Installing LaunchAgent…"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$APP_DIR/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/server-error.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

sleep 2
if curl -sf http://localhost:3000/api/auth/status >/dev/null; then
  echo ""
  echo "✅ Expense Tracker is running and will start automatically at login."
  echo ""
  echo "On this Mac:        http://localhost:3000"
  if command -v tailscale >/dev/null 2>&1 || [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
    TS="${TAILSCALE_BIN:-$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)}"
    TS_IP="$("$TS" ip -4 2>/dev/null | head -1 || true)"
    [ -n "$TS_IP" ] && echo "On your iPhone:     http://$TS_IP:3000   (via Tailscale, from anywhere)"
    echo ""
    echo "Optional — HTTPS with a trusted certificate (recommended):"
    echo "  \"$TS\" serve --bg 3000"
    echo "  then set SECURE_COOKIES=true in .env and reload:"
    echo "  launchctl unload \"$PLIST\" && launchctl load \"$PLIST\""
    echo "  Your iPhone URL becomes https://<this-mac>.<tailnet>.ts.net"
  fi
  echo ""
  echo "iPhone: open the URL in Safari → Share → Add to Home Screen."
else
  echo "⚠️  Server did not respond — check $LOG_DIR/server-error.log"
  exit 1
fi
