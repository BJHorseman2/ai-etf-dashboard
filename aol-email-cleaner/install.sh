#!/bin/bash
# One-command installer for the AOL email cleaner (macOS).
#
#   1. Copies the cleaner into ~/Library/Application Support/aol-email-cleaner
#   2. Prompts (hidden input) for the AOL address + app password and stores the
#      password ONLY in the macOS Keychain — never on disk, never in history
#   3. Runs a DRY RUN and shows what would be moved
#   4. Asks "Approve these rules and enable cleanup?" — only on "yes" does it
#      enable the mover and install a launchd LaunchAgent (every 4 h, survives
#      reboots via RunAtLoad)
#
# Re-running is safe/idempotent: it updates the code, keeps Keychain + state.

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
    echo "This installer is for macOS." >&2
    exit 1
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$HOME/Library/Application Support/aol-email-cleaner"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.aol-email-cleaner.plist"
LABEL="com.aol-email-cleaner"
SERVICE="aol-email-cleaner"
PYTHON="$(command -v python3)"

if [[ -z "$PYTHON" ]]; then
    echo "python3 not found. Install Xcode Command Line Tools: xcode-select --install" >&2
    exit 1
fi

mkdir -p "$APP_DIR" "$HOME/Library/Logs"
cp "$SRC_DIR/aol_email_cleaner.py" "$APP_DIR/"
# Never clobber a locally-updated rules file; the cleaner refreshes it from
# the repo on each run anyway.
if [[ ! -f "$APP_DIR/rules.json" ]]; then
    cp "$SRC_DIR/rules.json" "$APP_DIR/"
fi

# ---- account + credential ---------------------------------------------------
CONFIG="$APP_DIR/config.json"
EXISTING_ACCOUNT=""
if [[ -f "$CONFIG" ]]; then
    EXISTING_ACCOUNT="$("$PYTHON" -c 'import json,sys;print(json.load(open(sys.argv[1])).get("account",""))' "$CONFIG" 2>/dev/null || true)"
fi

if [[ -n "$EXISTING_ACCOUNT" ]]; then
    ACCOUNT="$EXISTING_ACCOUNT"
    echo "Using configured AOL account: $ACCOUNT"
else
    read -r -p "AOL email address: " ACCOUNT
fi

if ! security find-generic-password -s "$SERVICE" -a "$ACCOUNT" >/dev/null 2>&1; then
    echo
    echo "An AOL APP password is needed (not your normal AOL password)."
    echo "Generate one on your iPhone: aol.com sign-in -> Account Security ->"
    echo "App passwords -> Generate app password -> name it 'Mac email cleaner'."
    echo
    read -r -s -p "Paste the app password (input hidden): " APP_PW
    echo
    if [[ -z "$APP_PW" ]]; then
        echo "No password entered; aborting." >&2
        exit 1
    fi
    security add-generic-password -U -s "$SERVICE" -a "$ACCOUNT" -w "$APP_PW"
    unset APP_PW
    echo "App password stored in macOS Keychain (service: $SERVICE)."
else
    echo "App password already present in Keychain."
fi

# ---- config (no secrets in this file) --------------------------------------
"$PYTHON" - "$CONFIG" "$ACCOUNT" <<'EOF'
import json, sys
path, account = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(path))
except Exception:
    cfg = {}
cfg.setdefault("enabled", False)
cfg["account"] = account
cfg.setdefault("lookback_days", 30)
cfg.setdefault("rules_url",
    "https://raw.githubusercontent.com/BJHorseman2/ai-etf-dashboard/main/aol-email-cleaner/rules.json")
cfg.setdefault("notify_command", None)
json.dump(cfg, open(path, "w"), indent=2)
EOF

# ---- dry run ----------------------------------------------------------------
echo
echo "Running DRY RUN against your Inbox (nothing will be moved)..."
echo
"$PYTHON" "$APP_DIR/aol_email_cleaner.py" --dry-run

# ---- approval gate ----------------------------------------------------------
echo
read -r -p "Approve these rules and enable cleanup? [y/N] " ANSWER
if [[ ! "$ANSWER" =~ ^[Yy] ]]; then
    echo "Not enabled. Cleanup stays OFF; re-run this installer to try again."
    exit 0
fi

"$PYTHON" -c 'import json,sys; p=sys.argv[1]; c=json.load(open(p)); c["enabled"]=True; json.dump(c,open(p,"w"),indent=2)' "$CONFIG"

# ---- launchd agent ----------------------------------------------------------
sed -e "s|__PYTHON__|$PYTHON|g" \
    -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$SRC_DIR/com.aol-email-cleaner.plist.template" > "$LAUNCH_AGENT"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"

echo
echo "Enabled. The cleaner runs now and then every 4 hours (survives reboots)."
echo "Matched mail is moved to the AOL folder 'Agent Review' (never deleted)."
echo "Log: ~/Library/Logs/aol-email-cleaner.log"
