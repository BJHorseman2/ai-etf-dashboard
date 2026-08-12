# AOL Email Cleaner

Deterministic, rule-based cleaner for an AOL inbox. Every 4 hours it scans the
Inbox over IMAP/SSL (`imap.aol.com:993`) and moves messages that match known
unwanted-sender rules into the AOL **Spam** folder. No LLM is involved in
deciding what is junk — matching is exact addresses and explicit display-name
substrings only.

## Option A: run in the cloud via GitHub Actions (no Mac needed)

The workflow `.github/workflows/aol-email-cleanup.yml` runs the cleaner on
GitHub's servers every 4 hours. One-time setup, all doable from a phone:

1. Generate an AOL **app password** (see iPhone steps below).
2. In this repo: **Settings → Secrets and variables → Actions → New
   repository secret**, add:
   - `AOL_EMAIL` — your full AOL address
   - `AOL_APP_PASSWORD` — the app password
3. Run the workflow manually once in `dry-run` mode (Actions tab → AOL email
   cleanup → Run workflow) to see what would move. Scheduled runs only start
   once this workflow file is on the `main` branch.

Secrets are encrypted by GitHub and never appear in logs. Scheduled runs log
only rule names and counts (no senders/subjects), since Actions logs on a
public repo are visible.

## Option B: install on a Mac (one command)

```bash
git clone https://github.com/BJHorseman2/ai-etf-dashboard.git /tmp/aol-setup \
  && bash /tmp/aol-setup/aol-email-cleaner/install.sh
```

(If the repo is already cloned, just run `bash aol-email-cleaner/install.sh`.)

The installer:

1. Copies the cleaner to `~/Library/Application Support/aol-email-cleaner/`.
2. Asks for your AOL address and an **app password** (hidden input) and stores
   the password only in the **macOS Keychain** (service `aol-email-cleaner`).
   It never touches disk, source, logs, or shell history.
3. Runs a **dry run** and prints every message that would be moved (rule,
   sender email, display name, subject). Nothing moves.
4. Asks: **"Approve these rules and enable cleanup?"** Only on *yes* does it
   enable moving and install the launchd job.

## Generating an AOL app password (iPhone)

1. In Safari on the iPhone, go to <https://login.aol.com> and sign in.
2. Tap your profile icon → **Account info** → **Security** (AOL Account
   Security). Verify with Face ID/password if prompted.
3. Scroll to **App passwords** (sometimes "Generate app password" / "Other
   ways to sign in") → **Generate app password**.
4. Name it `Mac email cleaner` and tap **Generate**.
5. You get a 16-character password — that's what the installer asks for.
   It's shown once; if lost, just generate a new one.

## Scheduling

A launchd LaunchAgent (`~/Library/LaunchAgents/com.aol-email-cleaner.plist`)
runs the cleaner every 4 hours (`StartInterval` 14400) and once at
login/reboot (`RunAtLoad`), so it survives reboots. launchd also catches up
after sleep.

## Rules

Rules live in [`rules.json`](rules.json). Two matchers, both deterministic:

- `from_email` — exact, case-insensitive match on the actual From address
  (Reply-To is accepted as a fallback).
- `display_name_contains` — case-insensitive substring on the From/Reply-To
  display name.
- If a rule has **both**, both must match. That's how
  `noreply@skool.com` is only caught when the display name contains
  "AI Automation Agency" — skool.com is not blocked globally.

Before every scheduled run the cleaner re-downloads `rules.json` from this
repo (`rules_url` in config), falling back to the local copy on any failure.
So a rule change pushed to GitHub `main` takes effect on the Mac within 4
hours — no Mac access needed. To add a sender remotely, edit `rules.json`
here and merge to `main`.

## Safety properties

- Dry run first; the mover refuses to run until `enabled: true` is set by the
  approval step.
- Matches are **moved to "Agent Review"**, never deleted.
- Messages are not reprocessed: the cleaner tracks the last-seen IMAP UID (and
  resets correctly if UIDVALIDITY changes).
- Logs to `~/Library/Logs/aol-email-cleaner.log`; credentials are never
  logged or printed.
- Notifications (optional `notify_command` in config, message on stdin) fire
  only when mail was moved, an error occurred, or authentication failed.

## Files on the Mac

| Path | Purpose |
|---|---|
| `~/Library/Application Support/aol-email-cleaner/aol_email_cleaner.py` | the cleaner |
| `.../rules.json` | rules (auto-refreshed from this repo) |
| `.../config.json` | account, enabled flag, rules_url — no secrets |
| `.../state.json` | last-seen UID (no reprocessing) |
| `~/Library/LaunchAgents/com.aol-email-cleaner.plist` | 4-hour schedule |
| `~/Library/Logs/aol-email-cleaner.log` | action log |
| macOS Keychain, service `aol-email-cleaner` | the app password |

## Manual commands

```bash
PY="$HOME/Library/Application Support/aol-email-cleaner/aol_email_cleaner.py"
python3 "$PY" --dry-run   # report only
python3 "$PY" --run       # one real run now
python3 "$PY" --test      # offline rule-matching self-test
launchctl bootout gui/$(id -u)/com.aol-email-cleaner   # pause the schedule
```
