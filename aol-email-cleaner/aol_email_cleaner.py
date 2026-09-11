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
import email.policy
import email.utils
import html as html_module
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


def match_rule(rule, ctx):
    """Deterministic match. Returns True if the message matches this rule.

    Header-level conditions (cheap, always evaluated first):
    - from_email: exact (case-insensitive) match on the From address, or the
      Reply-To address as a fallback.
    - display_name_contains: case-insensitive substring on the From or
      Reply-To display name.
    - from_domain_in: From address domain is one of the listed domains.
    - subject_regex: case-insensitive regex on the decoded Subject.

    Content conditions (message fetched lazily, only if the header conditions
    above all passed):
    - body_contains_all: every phrase must appear in the message text.
    - body_contains_any: at least one phrase must appear.
    - max_text_chars: the message text is at most this long (near-empty
      bodies whose payload is an attachment).
    - attachment_types_any: at least one attachment has one of these MIME
      types (e.g. application/pdf).
    - attachment_name_regex: at least one attachment filename matches.
      The token {account_local} expands to the mailbox's local part.

    Every condition present on a rule must hold (AND), so e.g. the skool.com
    rule does not block all skool.com mail, and a content signature gated to
    free-mail domains never touches newsletters or real receipts.
    """
    want_email = rule.get("from_email", "").strip().lower()
    want_name = rule.get("display_name_contains", "").strip().lower()
    want_domains = [d.strip().lower() for d in rule.get("from_domain_in", [])]
    subject_re = rule.get("subject_regex", "")
    body_all = [p.lower() for p in rule.get("body_contains_all", [])]
    body_any = [p.lower() for p in rule.get("body_contains_any", [])]
    max_text = rule.get("max_text_chars")
    att_types = [t.lower() for t in rule.get("attachment_types_any", [])]
    att_name_re = rule.get("attachment_name_regex", "")

    if not (want_email or want_name or want_domains or subject_re
            or body_all or body_any or max_text is not None
            or att_types or att_name_re):
        return False

    if want_email and not (ctx["from_addr"] == want_email
                           or ctx["reply_addr"] == want_email):
        return False
    if want_name:
        haystack = ("%s %s" % (ctx["from_name"], ctx["reply_name"])).lower()
        if want_name not in haystack:
            return False
    if want_domains:
        domain = ctx["from_addr"].rsplit("@", 1)[-1]
        if domain not in want_domains:
            return False
    if subject_re and not re.search(subject_re, ctx["subject"], re.I):
        return False

    if body_all or body_any or max_text is not None:
        body = ctx["get_body"]()
        if body is None:
            return False
        if body_all and not all(p in body for p in body_all):
            return False
        if body_any and not any(p in body for p in body_any):
            return False
        if max_text is not None and len(body.strip()) > int(max_text):
            return False

    if att_types or att_name_re:
        atts = ctx["get_attachments"]()
        if atts is None:
            return False
        if att_types and not any(ct in att_types for ct, _fn in atts):
            return False
        if att_name_re and not any(re.search(att_name_re, fn, re.I)
                                   for _ct, fn in atts if fn):
            return False
    return True


def message_attachments(msg):
    """[(content_type, filename)] for every non-multipart part that carries
    a filename or is not a plain text/html body part."""
    out = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        fn = part.get_filename() or ""
        ctype = part.get_content_type().lower()
        if fn or ctype not in ("text/plain", "text/html"):
            out.append((ctype, fn))
    return out


def prepare_rules(rules, account):
    """Expand {account_local} in regex fields to the mailbox local part."""
    local = re.escape((account or "").split("@")[0])
    prepared = []
    for r in rules:
        r = dict(r)
        for key in ("subject_regex", "attachment_name_regex"):
            if r.get(key):
                r[key] = r[key].replace("{account_local}", local)
        prepared.append(r)
    return prepared


def html_to_text(html):
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", html)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html_module.unescape(text)
    return re.sub(r"\s+", " ", text)


def message_text(msg):
    """Lower-cased plain text of all text/plain and text/html parts."""
    chunks = []
    for part in msg.walk():
        ctype = part.get_content_type()
        if ctype not in ("text/plain", "text/html"):
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        charset = part.get_content_charset() or "utf-8"
        try:
            text = payload.decode(charset, errors="replace")
        except LookupError:
            text = payload.decode("utf-8", errors="replace")
        chunks.append(html_to_text(text) if ctype == "text/html" else text)
    return re.sub(r"\s+", " ", " ".join(chunks)).lower()


def find_matching_rule(rules, msg_headers, get_msg=lambda: None, get_body=None):
    """get_msg lazily returns the parsed full message (or None); get_body may
    override the text source (used by tests)."""
    from_name, from_addr = parse_addr(msg_headers.get("From", ""))
    reply_name, reply_addr = parse_addr(msg_headers.get("Reply-To", ""))
    cache = {}

    def cached_msg():
        if "msg" not in cache:
            cache["msg"] = get_msg()
        return cache["msg"]

    def cached_body():
        if "body" not in cache:
            if get_body is not None:
                cache["body"] = get_body()
            else:
                m = cached_msg()
                cache["body"] = message_text(m) if m is not None else None
        return cache["body"]

    def cached_attachments():
        if "atts" not in cache:
            m = cached_msg()
            cache["atts"] = message_attachments(m) if m is not None else None
        return cache["atts"]

    ctx = {
        "from_name": from_name, "from_addr": from_addr,
        "reply_name": reply_name, "reply_addr": reply_addr,
        "subject": decode_header_str(msg_headers.get("Subject", "")).strip(),
        "get_body": cached_body,
        "get_attachments": cached_attachments,
    }
    for rule in rules:
        if match_rule(rule, ctx):
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


BODY_FETCH_LIMIT = 200_000  # bytes; enough for any HTML invoice template


def fetch_message(conn, uid):
    """Fetch (a bounded prefix of) the full message, parsed, or None."""
    try:
        typ, data = conn.uid("FETCH", uid, "(BODY.PEEK[]<0.%d>)" % BODY_FETCH_LIMIT)
    except imaplib.IMAP4.error:
        return None
    if typ != "OK" or not data or data[0] is None:
        return None
    for part in data:
        if isinstance(part, tuple):
            try:
                return email.message_from_bytes(part[1])
            except Exception:
                return None
    return None


def fetch_body_text(conn, uid):
    """Lower-cased text of the message, or None. Only called for messages
    whose header-level conditions already matched a content rule."""
    msg = fetch_message(conn, uid)
    return message_text(msg) if msg is not None else None


def content_rule_terms(rules):
    """Union of gate domains and body phrases across content rules, for
    diagnostics."""
    domains, phrases = set(), set()
    for r in rules:
        if r.get("body_contains_all") or r.get("body_contains_any"):
            domains.update(d.lower() for d in r.get("from_domain_in", []))
            phrases.update(p.lower() for p in r.get("body_contains_all", []))
            phrases.update(p.lower() for p in r.get("body_contains_any", []))
    return domains, sorted(phrases)


def diagnose_message(conn, uid, headers, phrases):
    """Describe what a content rule would see in this message."""
    msg = fetch_message(conn, uid)
    if msg is None:
        return "  (fetch failed)"
    parts = []
    for p in msg.walk():
        if p.is_multipart():
            continue
        fn = p.get_filename() or ""
        parts.append(p.get_content_type() + ((" [%s]" % fn) if fn else ""))
    text = message_text(msg)
    hits = [ph for ph in phrases if ph in text]
    misses = [ph for ph in phrases if ph not in text]
    return ("  parts:   %s\n  text:    %d chars, starts: %r\n  hits:    %s\n  misses:  %s"
            % (", ".join(parts) or "(none)", len(text), text[:100],
               ", ".join(hits) or "-", ", ".join(misses) or "-"))


def scan(conn, rules, state, lookback_days, diag=None):
    """Return (matches, highest_uid, examined_count).

    matches: list of (uid, rule, info) for inbox messages matching a rule.
    diag:    if a list is given, append a diagnostic line per recent message
             from a content-rule gate domain (dry-run troubleshooting)."""
    diag_domains, diag_phrases = content_rule_terms(rules) if diag is not None else (set(), [])
    diag_cutoff = time.time() - int(os.environ.get("AOL_CLEANER_DIAG_DAYS", "4")) * 86400
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
        rule = find_matching_rule(
            rules, headers, get_msg=lambda u=uid: fetch_message(conn, u))
        if diag is not None:
            d_name, d_addr = parse_addr(headers.get("From", ""))
            d_dt = email.utils.parsedate_to_datetime(headers.get("Date", "")) \
                if headers.get("Date") else None
            recent = d_dt is None or d_dt.timestamp() >= diag_cutoff
            if recent and d_addr.rsplit("@", 1)[-1] in diag_domains:
                diag.append("%s <%s>\n  subject: %s\n  matched: %s\n%s" % (
                    d_name, d_addr,
                    decode_header_str(headers.get("Subject", "")).strip()[:90],
                    rule.get("id") if rule else "-",
                    diagnose_message(conn, uid, headers, diag_phrases)))
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
    rules = prepare_rules(ruleset["rules"], account)
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
        diag = [] if (dry_run and os.environ.get("AOL_CLEANER_DIAG") == "1") else None
        matches, highest_uid, scanned = scan(conn, rules, state, lookback, diag=diag)
        log("scan: %d message(s) examined, %d match(es)" % (scanned, len(matches)))

        if dry_run:
            report = format_report(matches, dry_run=True, folder=folder)
            if not matches:
                report = "No matching messages in the last %d days." % lookback
            if diag is not None:
                report += ("\n\n===== CONTENT-RULE DIAGNOSTICS (%d recent free-mail messages) =====\n"
                           % len(diag)) + "\n\n".join(diag)
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
    ("Bloomingdale's Loyallist <bloomingdalesloyallist@loyallist.bloomingdales.com>", "", "bloomingdales-loyallist"),
    ("Rye Recreation <info@communitypass.net>", "", "rye-recreation"),
    ("libertyroofingupgrade <hello@smartcartnow.net>", "", "smartcartnow-spam"),
    ("ReliefMDBetterLiving <hello@smartcartnow.net>", "", "smartcartnow-spam"),
    ("IndigoMastercardOffer <visible@visiblecreditline.net>", "", "indigo-mastercard-spam"),
    ("The Capitol Theatre <thecapitoltheatre@engage.ticketmaster.com>", "", "capitol-theatre"),
    ("events_at_mail_stubhub_com_kbfhk86xk4_18b287e2 <events_at_mail_stubhub_com_kbfhk86xk4_18b287e2@privaterelay.appleid.com>", "", "stubhub-events"),
    ("Yorkville Tennis Club LLC <confirm@mindbodyonline.com>", "", "yorkville-tennis"),
    ("Acme Markets <acmemarkets@p.acmemarkets.com>", "", "acme-markets-address"),
    ("Acme Markets <deals@other.acmemarkets.com>", "", "acme-markets-name"),
    ("Robert Guest at The Economist <newsletters_at_e_economist_com_bdthcywf5s_2f0f01cb@privaterelay.appleid.com>", "", "economist-today"),
    ("Anonymous Sender <newsletters_at_e_economist_com_bdthcywf5s_2f0f01cb@privaterelay.appleid.com>", "", "economist-relay"),
    ("Reddit <noreply_at_redditmail_com_zrjbnry8sg_c9f7a9cf@privaterelay.appleid.com>", "", "reddit"),
    ("NFL Preseason <NFL@email.nfl.com>", "", "nfl"),
    ("Elevate NY <elevate.ny@loyalty-plus.com>", "", "elevate-ny"),
    ("American Collectors Insurance <info@americancollectors.com>", "", "american-collectors-address"),
    ("Facebook <reminders@facebookmail.com>", "", "facebook-reminders"),
    ("Facebook <security@facebookmail.com>", "", None),
    ("Appointment Trader <community@appointment-trader.com>", "", "appointment-trader-address"),
    ("Vehicle Protections U S A Affiliates <hello@buyexpresshub.com>", "", "buyexpresshub-spam"),
    (".H.G.VPromo. <reminder@bestbuybasket.info>", "", "bestbuybasket-spam"),
    ("Joshua Kliniske <hajiagas7@gmail.com>", "", "geeksquad-scam-1"),
    ("Offeredge <kaniadaliya521@gmail.com>", "", "geeksquad-scam-2"),
    ("msbb224 <Xavrunqelomizatrekivo@rfhsolid.com>", "", "rfhsolid-spam"),
    ("KeepsHairGrowthSecret <Modern@moderncarthub.com>", "", "moderncarthub-spam"),
    ("SPHomeWarranty <market@buymoremarket.com>", "", "buymoremarket-spam"),
    ("libertyroofingupgrade <noreply@saveeveryday.info>", "", "saveeveryday-spam"),
    ("libertyroofingupgrade <whatever@next-new-domain.example>", "", "libertyroofing-name"),
    ("Your’s_AutoInsurance. <anything@rotating.example>", "", "yours-autoinsurance-name"),
    ("Your's_AutoInsurance. <anything@rotating.example>", "", "yours-autoinsurance-name"),
    ("Mikayla Parisian <keirbrbnrshdbbdbd@gmail.com>", "", "geeksquad-scam-3"),
    # other towns / businesses on shared platforms must NOT match
    ("Scarsdale Parks Dept <info@communitypass.net>", "", None),
    ("Some Yoga Studio <confirm@mindbodyonline.com>", "", None),
    # innocents must not match
    ("Mom <mom@example.com>", "", None),
    ("Chase <no.reply.alerts@chase.com>", "", None),
    ("Substack <no-reply@substack.com>", "", None),
]


SCAM_BODY = """<html><body><table><tr><td><b>GEEK</b> SQUAD</td></tr></table>
DATE: 10 Sep 2026 HELP DESK:+1 (816) 216-8408
<p>Dear msbb224@aol.com,</p><p>We hope you&rsquo;ve been enjoying our services.
We have renewed your Geek Squad subscription.</p><b>Billing Summary:</b>
Invoice Id: OQ-R2PE-L3BT2WFQRLNAPQ Transaction Id: 846821
<table><tr><td>Personal Subscription Plan</td><td>Internet Security Plan</td>
<td>Auto Debit</td><td>$234.99</td><td>Successful</td></tr></table>
<p>If you did not authorize this transaction, you have 12 hours to initiate a
cancellation ... HELP DESK:+1 (816) 216-8408</p>
<small>Copyright, 2024 Windows Defender. All Rights Reserved.</small></body></html>"""

# (From header, Subject, raw body, expected rule id or None)
BODY_TEST_CASES = [
    # the rotating-identity scam: new name, new gmail address, same template
    ("Jayne Mann <qzv81hd@gmail.com>", "Re: Thank You for Your Order UCTVDI06OHE8P32",
     SCAM_BODY, "fake-invoice-scam-content"),
    ("Jordan Flores <lkj3h2g@outlook.com>", "Re: Thank You for Your Order PZEF7K13F3",
     SCAM_BODY, "fake-invoice-scam-content"),
    # identical body from a corporate domain is outside the free-mail gate
    ("Best Buy <receipts@emailinfo.bestbuy.com>", "Your Geek Squad renewal",
     SCAM_BODY, None),
    # a real person on gmail mentioning one of the phrases must not match
    ("Old Friend <friend@gmail.com>", "trip costs",
     "<p>Hey! Billing summary for the trip is attached. Lunch Friday?</p>", None),
    # a genuine-looking receipt lacking the scam hooks must not match
    ("Some Store <orders@gmail.com>", "Your order",
     "<p>Thanks for your order. Billing Summary: $20. Questions? Reply here.</p>", None),
]


def _mime(from_h, subject, text, pdf_name=None, html=None):
    """Build a realistic multipart message for tests."""
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.mime.application import MIMEApplication
    m = MIMEMultipart("mixed")
    m["From"], m["Subject"] = from_h, subject
    if html:
        alt = MIMEMultipart("alternative")
        alt.attach(MIMEText(text, "plain"))
        alt.attach(MIMEText(html, "html"))
        m.attach(alt)
    else:
        m.attach(MIMEText(text, "plain"))
    if pdf_name:
        pdf = MIMEApplication(b"%PDF-1.4 x", "pdf", Name=pdf_name)
        pdf.add_header("Content-Disposition", "attachment", filename=pdf_name)
        m.attach(pdf)
    return email.message_from_bytes(m.as_bytes())


# (message, expected rule id or None) — full-message (attachment) tests,
# evaluated with the mailbox local part fixed to "msbb224".
def MIME_TEST_CASES():
    return [
        # the PDF-invoice scam family: random gmail identity, code-only body
        (_mime("Jayne Mann <failasufmiftachul8946@gmail.com>",
               "Re: Thank You for Your Order UCTVDI06OHE8P32", "UCTVDI06OHE8P32",
               pdf_name="20260910_msbb224_OQ-R2PE-L3BT.pdf"), "fake-invoice-pdf-named-for-account"),
        # same family, different subject wording -> still caught by the filename
        (_mime("Mikayla Parisian <keirbrbnrshdb@gmail.com>",
               "This invoice 735PM includes", "9B33TU",
               pdf_name="20260831_msbb224_JMDA0202F.pdf"), "fake-invoice-pdf-named-for-account"),
        # order-subject variant with a differently named PDF
        (_mime("Brandon Johnson <faisallinggar8636@gmail.com>",
               "Thank You for Your Order V3FPNKA4WL05LZ8", "V3FPNKA4WL05LZ8",
               pdf_name="invoice.pdf"), "fake-invoice-pdf-order-subject"),
        # family member on gmail with a real note and a PDF: must NOT match
        (_mime("Allison Baumrind <abaumrind09@gmail.com>", "Re: Welcome to Math AIS!",
               "Hi Nicole, thank you for reaching out! Attached is the form we talked "
               "about, let me know if anything else is needed for Mollie's schedule.",
               pdf_name="20260910_schedule_final.pdf"), None),
        # a friend forwarding a genuine receipt with a long body: must NOT match
        (_mime("Friend <friend@gmail.com>", "Re: Thank you for your order",
               "Here's the receipt for the thing you asked me to grab; "
               "let me know if the size is right and I'll return it otherwise.",
               pdf_name="receipt.pdf"), None),
        # code-only body but no attachment at all: must NOT match
        (_mime("Someone <someone@gmail.com>", "Re: Thank You for Your Order ABC123", "ABC123"), None),
    ]


def self_test():
    here = os.path.dirname(os.path.abspath(__file__))
    ruleset = load_json(os.path.join(here, "rules.json")) or load_json(RULES_PATH)
    rules = prepare_rules(ruleset["rules"], "msbb224@aol.com")
    failures = 0
    for msg, expected in MIME_TEST_CASES():
        rule = find_matching_rule(rules, msg, get_msg=lambda m=msg: m)
        got = rule["id"] if rule else None
        status = "PASS" if got == expected else "FAIL"
        if got != expected:
            failures += 1
        print("%s  From=%-55s expected=%-28s got=%s  [mime]" % (status, msg["From"], expected, got))
    for from_h, reply_h, expected in TEST_CASES:
        rule = find_matching_rule(rules, {"From": from_h, "Reply-To": reply_h})
        got = rule["id"] if rule else None
        status = "PASS" if got == expected else "FAIL"
        if got != expected:
            failures += 1
        print("%s  From=%-55s expected=%-28s got=%s" % (status, from_h, expected, got))
    for from_h, subject, body, expected in BODY_TEST_CASES:
        msg = email.message_from_string(body, policy=email.policy.default)
        msg.set_type("text/html")
        text = message_text(msg)
        rule = find_matching_rule(rules, {"From": from_h, "Subject": subject},
                                  get_body=lambda t=text: t)
        got = rule["id"] if rule else None
        status = "PASS" if got == expected else "FAIL"
        if got != expected:
            failures += 1
        print("%s  From=%-55s expected=%-28s got=%s  [body]" % (status, from_h, expected, got))
    total = len(TEST_CASES) + len(BODY_TEST_CASES) + len(MIME_TEST_CASES())
    print("\n%d/%d passed" % (total - failures, total))
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
