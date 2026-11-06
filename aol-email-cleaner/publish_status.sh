#!/usr/bin/env bash
# Fold one run's stats (JSON written by aol_email_cleaner.py via
# AOL_CLEANER_STATS) into aol-email-cleaner/status.json and push the result.
# Bookkeeping only: retries around concurrent pushes and never fails the
# caller — the mail cleaning itself already happened.
#
# Usage: publish_status.sh <stats.json>
set -u
STATS_FILE="${1:?stats file}"
cd "$(dirname "$0")/.."

python3 - "$STATS_FILE" << 'EOF'
import json, sys
stats_path = sys.argv[1]
status_path = "aol-email-cleaner/status.json"
try:
    stats = json.load(open(stats_path))
except Exception:
    stats = {"time": None, "mode": "run", "ok": False,
             "error": "run produced no stats (crashed early)"}
try:
    status = json.load(open(status_path))
except Exception:
    status = {}
status.setdefault("total_moved", 0)
status.setdefault("totals_by_rule", {})
status.setdefault("history", [])
status["last_run"] = stats.get("time")
status["last_mode"] = stats.get("mode")
status["last_ok"] = stats.get("ok", False)
status["last_error"] = stats.get("error")
status["last_scanned"] = stats.get("scanned", 0)
status["last_moved"] = stats.get("moved", 0)
status["total_moved"] += stats.get("moved", 0)
for rule, n in (stats.get("by_rule") or {}).items():
    status["totals_by_rule"][rule] = status["totals_by_rule"].get(rule, 0) + n
status["history"].append({
    "t": stats.get("time"), "moved": stats.get("moved", 0),
    "scanned": stats.get("scanned", 0), "ok": stats.get("ok", False)})
status["history"] = status["history"][-400:]
json.dump(status, open(status_path, "w"), indent=2)
EOF

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add aol-email-cleaner/status.json
if git diff --cached --quiet; then
  exit 0
fi
git commit -q -m "Update cleaner status [skip-clean]"
for i in 1 2 3 4; do
  git push -q && exit 0
  git pull -q --rebase -X theirs || git rebase --abort
  sleep 5
done
echo "::warning::status push failed after retries (bookkeeping only)"
exit 0
