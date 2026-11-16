#!/usr/bin/env python3
"""
FreeAgent API helper for the expense-import skill.

Deterministic I/O only. No judgement lives here; Claude decides vendor,
category and amount, then calls this to talk to FreeAgent.

Stdlib only, so it runs anywhere Python 3.8+ is present with no install step.

Auth model: OAuth 2.0 authorisation-code flow.
  - One-time:  auth-url  ->  approve in browser  ->  exchange  ->  store refresh token
  - Ongoing:   the access token is cached and refreshed automatically

Environment (read from the process env; populate via .env or `op`):
  FREEAGENT_CLIENT_ID       OAuth identifier from dev.freeagent.com
  FREEAGENT_CLIENT_SECRET   OAuth secret
  FREEAGENT_REFRESH_TOKEN   long-lived refresh token (printed by `exchange`)
  FREEAGENT_REDIRECT_URI    must match a redirect URI registered on the app
                            default: http://localhost:8923/callback
  FREEAGENT_BASE_URL        default: https://api.freeagent.com
                            sandbox: https://api.sandbox.freeagent.com
  FREEAGENT_TOKEN_CACHE     default: ~/.config/freeagent/token.json

Subcommands:
  auth-url                       print the URL to approve the app
  exchange CODE                  swap an auth code for tokens; prints refresh token
  whoami                         print the current user's URL (the expense claimant)
  categories                     list accounting categories (url + description)
  projects                       list active projects (url + name + currency)
  find-expense REF               print matching expense url(s) by receipt_reference
  create-expense                 read one expense JSON object from stdin, create it
  delete-expense ID              delete an expense by numeric id (duplicate cleanup)
"""

import base64
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

DEFAULT_BASE = "https://api.freeagent.com"
DEFAULT_REDIRECT = "http://localhost:8923/callback"
TOKEN_LEEWAY = 120  # refresh this many seconds before stated expiry
JSON_TYPE = "application/json"


def base_url():
    return os.environ.get("FREEAGENT_BASE_URL", DEFAULT_BASE).rstrip("/")


def redirect_uri():
    return os.environ.get("FREEAGENT_REDIRECT_URI", DEFAULT_REDIRECT)


def cache_path():
    p = os.environ.get("FREEAGENT_TOKEN_CACHE")
    if p:
        return Path(p)
    return Path.home() / ".config" / "freeagent" / "token.json"


def _require(name):
    val = os.environ.get(name)
    if not val:
        sys.exit(f"error: {name} is not set")
    return val


def _basic_auth_header():
    cid = _require("FREEAGENT_CLIENT_ID")
    secret = _require("FREEAGENT_CLIENT_SECRET")
    raw = f"{cid}:{secret}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def _post_form(path, fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(base_url() + path, data=data, method="POST")
    req.add_header("Authorization", _basic_auth_header())
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Accept", JSON_TYPE)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


# ---------- token lifecycle ----------

def _read_cache():
    p = cache_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def _write_cache(token, expires_at, refresh=None):
    p = cache_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({
        "access_token": token,
        "expires_at": expires_at,
        # keep the refresh token alongside so it survives without a .env entry
        "refresh_token": refresh or _read_cache().get("refresh_token"),
    }))
    try:
        p.chmod(0o600)
    except OSError:
        pass


def _refresh_access_token():
    refresh = os.environ.get("FREEAGENT_REFRESH_TOKEN") or _read_cache().get("refresh_token")
    if not refresh:
        sys.exit("error: no refresh token — run auth-url + exchange, or set FREEAGENT_REFRESH_TOKEN")
    body = _post_form(
        "/v2/token_endpoint",
        {"grant_type": "refresh_token", "refresh_token": refresh},
    )
    token = body["access_token"]
    expires_at = int(time.time()) + int(body.get("expires_in", 3600))
    _write_cache(token, expires_at)
    return token


def access_token():
    cache = _read_cache()
    if cache.get("access_token") and cache.get("expires_at", 0) - TOKEN_LEEWAY > time.time():
        return cache["access_token"]
    return _refresh_access_token()


# ---------- authenticated API calls ----------

def api(method, path, payload=None, params=None):
    url = base_url() + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + access_token())
    req.add_header("Accept", JSON_TYPE)
    if data is not None:
        req.add_header("Content-Type", JSON_TYPE)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        sys.exit(f"error: {method} {path} -> {e.code} {e.reason}\n{detail}")


# ---------- subcommands ----------

def cmd_auth_url(_args):
    cid = _require("FREEAGENT_CLIENT_ID")
    q = urllib.parse.urlencode(
        {
            "client_id": cid,
            "response_type": "code",
            "redirect_uri": redirect_uri(),
        }
    )
    print(f"{base_url()}/v2/approve_app?{q}")
    print(
        "\nApprove in a browser. You will be redirected to your redirect URI "
        "with ?code=... in the address bar. Pass that code to:  "
        "freeagent.py exchange CODE",
        file=sys.stderr,
    )


def cmd_exchange(args):
    if not args:
        sys.exit("usage: freeagent.py exchange CODE")
    body = _post_form(
        "/v2/token_endpoint",
        {
            "grant_type": "authorization_code",
            "code": args[0],
            "redirect_uri": redirect_uri(),
        },
    )
    expires_at = int(time.time()) + int(body.get("expires_in", 3600))
    _write_cache(body["access_token"], expires_at, body.get("refresh_token"))
    print("Refresh token cached. (Optionally also store as FREEAGENT_REFRESH_TOKEN in .env.)")


def cmd_whoami(_args):
    data = api("GET", "/v2/users/me")
    print(data.get("user", {}).get("url", json.dumps(data)))


def cmd_categories(_args):
    data = api("GET", "/v2/categories")
    # categories come grouped; flatten anything that looks like {url, description}
    for group, items in data.items():
        if not isinstance(items, list):
            continue
        for it in items:
            url = it.get("url", "")
            desc = it.get("description", "")
            nominal = it.get("nominal_code", "")
            print(f"{url}\t{nominal}\t{desc}\t[{group}]")


def cmd_projects(_args):
    data = api("GET", "/v2/projects", params={"view": "active"})
    for p in data.get("projects", []):
        print(f"{p.get('url','')}\t{p.get('name','')}\t{p.get('currency','')}\t{p.get('status','')}")


def cmd_find_expense(args):
    if not args:
        sys.exit("usage: freeagent.py find-expense REF")
    ref = args[0]
    # per_page caps at 100 (default is 25); widen the dedup window accordingly
    data = api("GET", "/v2/expenses", params={"view": "recent", "per_page": 100})
    hits = [
        e["url"]
        for e in data.get("expenses", [])
        if e.get("receipt_reference") == ref
    ]
    for h in hits:
        print(h)
    # exit non-zero when nothing matched, so callers can branch on it
    sys.exit(0 if hits else 1)


def cmd_create_expense(_args):
    try:
        expense = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        sys.exit(f"error: stdin is not valid JSON: {e}")
    if "expense" not in expense:
        expense = {"expense": expense}
    result = api("POST", "/v2/expenses", payload=expense)
    print(result.get("expense", {}).get("url", json.dumps(result)))


def cmd_delete_expense(args):
    if not args or not args[0].isdigit():
        sys.exit("usage: freeagent.py delete-expense ID")
    api("DELETE", f"/v2/expenses/{args[0]}")
    print(f"deleted https://api.freeagent.com/v2/expenses/{args[0]}")


COMMANDS = {
    "auth-url": cmd_auth_url,
    "exchange": cmd_exchange,
    "whoami": cmd_whoami,
    "categories": cmd_categories,
    "projects": cmd_projects,
    "find-expense": cmd_find_expense,
    "create-expense": cmd_create_expense,
    "delete-expense": cmd_delete_expense,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    COMMANDS[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
