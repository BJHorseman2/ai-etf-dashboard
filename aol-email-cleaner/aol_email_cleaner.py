#!/usr/bin/env python3
"""AOL inbox cleaner.

Deterministic rule-based cleaner: connects to AOL over IMAP/SSL, scans the
Inbox for messages matching rules in rules.json, and moves matches to the
"Agent Review" folder (or reports them in dry-run mode). No LLM decisions.

Credentials come from the macOS Keychain (service: aol-email-cleaner) via the
`security` CLI, with an AOL_APP_PASSWORD environment variable fallback for
non-Mac testing. The password is never logged or printed.

Usage:
  aol_email_cleaner.py --dry-run          # report matches, move nothing
  aol_email_cleaner.py --run              # move matches (requires enabled=true)
  aol_email_cleaner.py --test             # offline self-test of rule matching
"""

import argparse
import email
import email.header
import email.utils
import imaplib
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request

APP_DIR = os.environ.get(
    "AOL_CLEANER_DIR",
    os.path.expanduser("~/Library/Application Support/aol-email-cleaner"),
)
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
RULES_PATH = os.path.join(APP_DIR, "rules.json")
STATE_PATH = os.path.join(APP_DIR, "state.json")
LOG_PATH = os.environ.get(
    "AOL_CLEANER_LOG",
    os.path.expanduser("~/Library/Logs/aol-email-cleaner.log"),
)
KEYCHAIN_SERVICE = "aol-email-cleaner"
IMAP_HOST = "imap.aol.com"
IMAP_PORT = 993
MAX_LOG_BYTES = 1_000_000


def log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > MAX_LOG_BYTES:
            shutil.move(LOG_PATH, LOG_PATH + ".old")
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def load_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def get_password(account):
    """Fetch the app password from macOS Keychain, env var fallback."""
    env_pw = os.environ.get("AOL_APP_PASSWORD")
    if env_pw:
        return env_pw
    try:
        out = subprocess.run(
            ["security", "find-generic-password",
             "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
            capture_output=True, text=True, timeout=30,
        )
        if out.returncode == 0:
            return out.stdout.rstrip("\n")
    except (OSError, subprocess.TimeoutExpired):
        pass
    return None


def refresh_rules(config):
    """Best-effort fetch of the latest rules.json from the repo.

    Falls back silently to the local copy on any failure, so a network or
    repo problem can never break a scheduled run.
    """
    url = config.get("rules_url")
    if not url:
        return
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if isinstance(data, dict) and isinstance(data.get("rules"), list):
            save_json(RULES_PATH, data)
            log("rules: refreshed from remote (%d rules)" % len(data["rules"]))
    except Exception as e:
        log("rules: remote refresh skipped (%s); using local copy" % type(e).__name__)


def decode_header_str(value):
    if not value:
        return ""
    try:
        parts = email.header.decode_header(value)
        out = []
        for text, enc in parts:
            if isinstance(text, bytes):
                out.append(text.decode(enc or "utf-8", errors="replace"))
            else:
                out.append(text)
        return "".join(out)
    except Exception:
        return str(value)


def parse_addr(header_value):
    """Return (display_name, email_address) lowered-address from a header."""
    decoded = decode_header_str(header_value)
    name, addr = email.utils.parseaddr(decoded)
    return name.strip(), addr.strip().lower()


def match_rule(rule, from_name, from_addr, reply_name, reply_addr):
    """Deterministic match. Returns True if the message matches this rule.

    - from_email: exact (case-insensitive) match on the From address, or the
      Reply-To address as a fallback.
    - display_name_contains: case-insensitive substring on the From or
      Reply-To display name.
    - When both fields are present, BOTH must match (e.g. the skool.com rule
      must not block all skool.com mail).
    """
    want_email = rule.get("from_email", "").strip().lower()
    want_name = rule.get("display_name_contains", "").strip().lower()

    email_ok = True
    if want_email:
        email_ok = from_addr == want_email or reply_addr == want_email

    name_ok = True
    if want_name:
        haystack = ("%s %s" % (from_name, reply_name)).lower()
        name_ok = want_name in haystack

    if not want_email and not want_name:
        return False
    return email_ok and name_ok


def find_matching_rule(rules, msg_headers):
    from_name, from_addr = parse_addr(msg_headers.get("From", ""))
    reply_name, reply_addr = parse_addr(msg_headers.get("Reply-To", ""))
    for rule in rules:
        if match_rule(rule, from_name, from_addr, reply_name, reply_addr):
            return rule
    return None


def imap_connect(account, password):
    ctx = ssl.create_default_context()
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, ssl_context=ctx)
    conn.login(account, password)
    return conn


def ensure_folder(conn, folder):
    typ, data = conn.list()
    existing = set()
    if typ == "OK":
        for line in data or []:
            if not line:
                continue
            if isinstance(line, bytes):
                line = line.decode("utf-8", errors="replace")
            m = re.search(r' (?:"([^"]*)"|(\S+))$', line)
            if m:
                existing.add(m.group(1) or m.group(2))
    if folder not in existing:
        conn.create(folder)
        conn.subscribe(folder)
        log('folder: created "%s"' % folder)


def fetch_headers(conn, uid):
    typ, data = conn.uid(
        "FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (FROM REPLY-TO SUBJECT DATE)])"
    )
    if typ != "OK" or not data or data[0] is None:
        return None
    raw = b""
    for part in data:
        if isinstance(part, tuple):
            raw = part[1]
            break
    return email.message_from_bytes(raw)


def scan(conn, rules, state, lookback_days):
    """Yield (uid, rule, info) for inbox messages matching a rule."""
    typ, _ = conn.select("INBOX")
    if typ != "OK":
        raise RuntimeError("could not select INBOX")

    typ, data = conn.response("UIDVALIDITY")
    uidvalidity = data[0].decode() if data and data[0] else ""
    if state.get("uidvalidity") != uidvalidity:
        state["uidvalidity"] = uidvalidity
        state["last_uid"] = 0

    last_uid = int(state.get("last_uid", 0))
    if last_uid > 0:
        typ, data = conn.uid("SEARCH", None, "UID %d:*" % (last_uid + 1))
    else:
        since = time.strftime(
            "%d-%b-%Y", time.localtime(time.time() - lookback_days * 86400)
        )
        typ, data = conn.uid("SEARCH", None, "SINCE", since)
    if typ != "OK":
        raise RuntimeError("IMAP SEARCH failed")

    uids = [u for u in (data[0].split() if data and data[0] else []) if u]
    matches = []
    highest = last_uid
    for uid in uids:
        uid_int = int(uid)
        if uid_int <= last_uid:
            continue  # "UID n:*" can echo back the last-seen UID
        highest = max(highest, uid_int)
        headers = fetch_headers(conn, uid)
        if headers is None:
            continue
        rule = find_matching_rule(rules, headers)
        if rule:
            from_name, from_addr = parse_addr(headers.get("From", ""))
            matches.append((uid, rule, {
                "from_name": from_name,
                "from_addr": from_addr,
                "subject": decode_header_str(headers.get("Subject", "")).strip(),
                "date": decode_header_str(headers.get("Date", "")).strip(),
            }))
    return matches, highest, len(uids)


def move_messages(conn, matches, folder):
    moved = []
    for uid, rule, info in matches:
        typ, _ = conn.uid("COPY", uid, '"%s"' % folder)
        if typ != "OK":
            log("ERROR: COPY failed for uid %s" % uid.decode())
            continue
        conn.uid("STORE", uid, "+FLAGS", r"(\Deleted)")
        moved.append((uid, rule, info))
    if moved:
        try:
            conn.uid("EXPUNGE", b",".join(u for u, _, _ in moved))
        except imaplib.IMAP4.error:
            conn.expunge()
    return moved


def format_report(matches, dry_run, folder):
    lines = []
    verb = "WOULD MOVE" if dry_run else "MOVED"
    for _, rule, info in matches:
        lines.append(
            "%s -> %s\n  rule:    %s\n  from:    %s <%s>\n  subject: %s\n  date:    %s"
            % (verb, folder, rule.get("label", rule.get("id", "?")),
               info["from_name"] or "(no display name)", info["from_addr"],
               info["subject"] or "(no subject)", info["date"]))
    return "\n".join(lines)


def write_stats(data):
    """Write run stats JSON for the dashboard (path via AOL_CLEANER_STATS)."""
    path = os.environ.get("AOL_CLEANER_STATS")
    if path:
        try:
            save_json(path, data)
        except OSError:
            pass


def notify(config, message):
    """Send a notification via the configured command (message on stdin)."""
    cmd = config.get("notify_command")
    if not cmd:
        return
    try:
        subprocess.run(cmd, shell=True, input=message.encode(),
                       timeout=60, capture_output=True)
    except (OSError, subprocess.TimeoutExpired) as e:
        log("notify: failed (%s)" % type(e).__name__)


def run(dry_run):
    config = load_json(CONFIG_PATH, {})
    account = config.get("account") or os.environ.get("AOL_ACCOUNT")
    if not account:
        log("ERROR: no account configured (config.json 'account')")
        return 2
    enabled = config.get("enabled") or os.environ.get("AOL_CLEANER_ENABLED") == "1"
    if not dry_run and not enabled:
        log("cleanup not enabled yet (config 'enabled' is false); refusing to move mail")
        return 2

    refresh_rules(config)
    ruleset = load_json(RULES_PATH)
    if not ruleset or not isinstance(ruleset.get("rules"), list):
        log("ERROR: rules.json missing or invalid at %s" % RULES_PATH)
        notify(config, "AOL cleaner ERROR: rules.json missing or invalid")
        return 2
    rules = ruleset["rules"]
    folder = ruleset.get("target_folder", "Agent Review")

    password = get_password(account)
    if not password:
        log("ERROR: no app password in Keychain (service %r, account %r)"
            % (KEYCHAIN_SERVICE, account))
        notify(config, "AOL cleaner ERROR: app password missing from Keychain")
        return 2

    state = load_json(STATE_PATH, {}) if not dry_run else {}
    lookback = int(os.environ.get("AOL_CLEANER_LOOKBACK",
                                  config.get("lookback_days", 30)))

    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    mode = "dry-run" if dry_run else "run"

    try:
        conn = imap_connect(account, password)
    except imaplib.IMAP4.error as e:
        log("ERROR: IMAP authentication failed: %s" % e)
        notify(config, "AOL cleaner: AUTHENTICATION FAILED — the app password "
                       "may have been revoked. A new one is needed.")
        write_stats({"time": now_iso, "mode": mode, "ok": False,
                     "error": "authentication failed"})
        return 1
    except (OSError, ssl.SSLError) as e:
        log("ERROR: could not connect to %s: %s" % (IMAP_HOST, e))
        notify(config, "AOL cleaner ERROR: could not connect to AOL IMAP (%s)" % e)
        write_stats({"time": now_iso, "mode": mode, "ok": False,
                     "error": "connection failed"})
        return 1

    try:
        if not dry_run:
            ensure_folder(conn, folder)
        matches, highest_uid, scanned = scan(conn, rules, state, lookback)
        log("scan: %d message(s) examined, %d match(es)" % (scanned, len(matches)))

        if dry_run:
            report = format_report(matches, dry_run=True, folder=folder)
            if not matches:
                report = "No matching messages in the last %d days." % lookback
            by_rule = {}
            for _, rule, _info in matches:
                label = rule.get("label", rule.get("id", "?"))
                by_rule[label] = by_rule.get(label, 0) + 1
            write_stats({"time": now_iso, "mode": mode, "ok": True,
                         "scanned": scanned, "matched": len(matches),
                         "moved": 0, "by_rule": by_rule})
            report_path = os.environ.get("AOL_CLEANER_REPORT")
            if report_path:
                # write details to a file (e.g. a CI artifact) and keep
                # stdout — which may be publicly visible — to counts only
                with open(report_path, "w") as f:
                    f.write(report + "\n")
                print("dry run: %d match(es); details written to report file"
                      % len(matches))
            else:
                print("\n===== DRY RUN REPORT =====")
                print(report)
                print("==========================")
            return 0

        moved = move_messages(conn, matches, folder)
        state["last_uid"] = highest_uid
        save_json(STATE_PATH, state)

        quiet = os.environ.get("AOL_CLEANER_QUIET") == "1"
        for _, rule, info in moved:
            if quiet:
                # public CI logs: rule label only, no sender/subject details
                log("moved: [%s] 1 message" % rule.get("label"))
            else:
                log('moved: [%s] %s <%s> — "%s"'
                    % (rule.get("label"), info["from_name"], info["from_addr"],
                       info["subject"]))
        by_rule = {}
        for _, rule, _info in moved:
            label = rule.get("label", rule.get("id", "?"))
            by_rule[label] = by_rule.get(label, 0) + 1
        write_stats({"time": now_iso, "mode": mode, "ok": True,
                     "scanned": scanned, "matched": len(matches),
                     "moved": len(moved), "by_rule": by_rule})
        if moved:
            notify(config, "AOL cleaner: moved %d message(s) to \"%s\":\n\n%s"
                   % (len(moved), folder, format_report(moved, dry_run=False, folder=folder)))
        return 0
    except Exception as e:
        log("ERROR: run failed: %s: %s" % (type(e).__name__, e))
        notify(config, "AOL cleaner ERROR: %s: %s" % (type(e).__name__, e))
        write_stats({"time": now_iso, "mode": mode, "ok": False,
                     "error": "%s: %s" % (type(e).__name__, e)})
        return 1
    finally:
        try:
            conn.logout()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Offline self-test of the matching logic (no network, no credentials).

TEST_CASES = [
    # (From header, Reply-To header, expected rule id or None)
    ("Fast5GInternet <shop@dailycartstore.info>", "", "fast5g-internet"),
    ("Scott Galloway <profgmedia@substack.com>", "", "profg-media-substack"),
    ("AI Automation Agency Hub <noreply@skool.com>", "", "ai-automation-agency-skool"),
    # skool.com WITHOUT the AI Automation Agency name must NOT match
    ("Some Other Community <noreply@skool.com>", "", None),
    ("The Economist Today <newsletters@e.economist.com>", "", "economist-today"),
    ("NBA Top Shot <no-reply@nbatopshot.com>", "", "nba-top-shot"),
    ("Manifold <no-reply@manifold.markets>", "", "manifold"),
    ("The Prof G Pod <podcast@profgmedia.com>", "", "prof-g-pod"),
    ("HorsepowerDuck <hp@duck.example>", "", "horsepowerduck"),
    ("H0rsep0werDuck <hp0@duck.example>", "", "h0rsep0werduck"),
    ("Costa Dentistry <office@costadentistry.com>", "", "costa-dentistry"),
    ("YCharts <team@ycharts.com>", "", "ycharts"),
    # match via Reply-To address
    ("Random Display <bounce@mailer.example>", "Shop <shop@dailycartstore.info>", "fast5g-internet"),
    ("YourInsuranceTeamataflac <westlanehomes@westlanehomes.in>", "", "fake-aflac-address"),
    ("YourInsuranceTeam-Aflac <random123@other-domain.example>", "", "yourinsuranceteam-name"),
    ("Discord <noreply@discord.com>", "", "discord"),
    ("Yutori <notifications_at_yutori_com_x@privaterelay.appleid.com>", "", "yutori"),
    ("Lend ing F0R BAD Cred it <pldaxswkqetmvra@wish-montenegro.com>", "", "loan-spam-address"),
    ("Lend ing F0R BAD Cred it <zznewrandom@other-spam-domain.example>", "", "loan-spam-name"),
    ("ProductReportCard.com <support@productreportcard.com>", "", "productreportcard-address"),
    ("ProductReportCard.com <bulk@some-esp.example>", "", "productreportcard-name"),
    # innocents must not match
    ("Mom <mom@example.com>", "", None),
    ("Chase <no.reply.alerts@chase.com>", "", None),
    ("Substack <no-reply@substack.com>", "", None),
]


def self_test():
    here = os.path.dirname(os.path.abspath(__file__))
    ruleset = load_json(os.path.join(here, "rules.json")) or load_json(RULES_PATH)
    rules = ruleset["rules"]
    failures = 0
    for from_h, reply_h, expected in TEST_CASES:
        rule = find_matching_rule(rules, {"From": from_h, "Reply-To": reply_h})
        got = rule["id"] if rule else None
        status = "PASS" if got == expected else "FAIL"
        if got != expected:
            failures += 1
        print("%s  From=%-55s expected=%-28s got=%s" % (status, from_h, expected, got))
    print("\n%d/%d passed" % (len(TEST_CASES) - failures, len(TEST_CASES)))
    return 0 if failures == 0 else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true",
                      help="report matches without moving anything")
    mode.add_argument("--run", action="store_true",
                      help="move matching messages to the review folder")
    mode.add_argument("--test", action="store_true",
                      help="offline self-test of rule matching")
    args = ap.parse_args()
    if args.test:
        sys.exit(self_test())
    sys.exit(run(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
