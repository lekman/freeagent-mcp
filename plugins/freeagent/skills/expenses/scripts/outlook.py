#!/usr/bin/env python3
"""
Microsoft Graph helper for the expense-import skill.

The mailbox WRITE path for the skill: archives and labels Outlook messages,
and fetches attachments. The managed Microsoft 365 MCP connector is read-only
by design and remains the read path. Deterministic I/O only; Claude decides
which messages to touch and this script talks to Graph.

Stdlib only, so it runs anywhere Python 3.8+ is present with no install step.

Auth model: OAuth 2.0 device-code flow (public client, no secret).
  - One-time:  login  ->  enter the printed code at microsoft.com/devicelogin
  - Ongoing:   access token refreshes automatically from the cached
               refresh token

Environment (populate via ~/.config/freeagent/.env or the process env):
  MSGRAPH_CLIENT_ID     app registration to authenticate as
                        default: 14d82eec-204b-4c2f-b7e8-296a70dab67e
                        (Microsoft Graph Command Line Tools, a Microsoft
                        first-party multi-tenant public client)
  MSGRAPH_TENANT        default: organizations
  MSGRAPH_TOKEN_CACHE   default: ~/.config/freeagent/msgraph-token.json

Delegated scopes requested: Mail.ReadWrite (move/categorise own mailbox),
User.Read (whoami), offline_access (refresh token).

Subcommands:
  login                          run the device-code flow, cache the tokens
  whoami                         print the signed-in user (name + mail)
  folders                        list mail folders (id <tab> displayName)
  archive [--label CAT] ID...    move messages to the Archive folder,
                                 optionally adding category CAT first
  label CAT ID...                add category CAT to messages (no move)
  attachments ID [DIR]           list a message's attachments; save files to DIR

Message IDs are Graph message ids — the same ids the Microsoft 365 MCP
search tools return.
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

DEFAULT_CLIENT = "14d82eec-204b-4c2f-b7e8-296a70dab67e"
GRAPH = "https://graph.microsoft.com/v1.0"
SCOPE = "offline_access User.Read Mail.ReadWrite"
TOKEN_LEEWAY = 120  # refresh this many seconds before stated expiry
JSON_TYPE = "application/json"


def client_id():
    return os.environ.get("MSGRAPH_CLIENT_ID", DEFAULT_CLIENT)


def login_base():
    tenant = os.environ.get("MSGRAPH_TENANT", "organizations")
    return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0"


def cache_path():
    p = os.environ.get("MSGRAPH_TOKEN_CACHE")
    if p:
        return Path(p)
    return Path.home() / ".config" / "freeagent" / "msgraph-token.json"


def _post_form(url, fields):
    data = urllib.parse.urlencode(fields).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    req.add_header("Accept", JSON_TYPE)
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # token endpoint reports pending/expired states as HTTP 400 + JSON
        try:
            return json.loads(e.read().decode())
        except json.JSONDecodeError:
            sys.exit(f"error: POST {url} -> {e.code} {e.reason}")


# ---------- token lifecycle ----------

def _read_cache():
    p = cache_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def _write_cache(body):
    p = cache_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    cache = {
        "access_token": body["access_token"],
        "refresh_token": body.get("refresh_token", _read_cache().get("refresh_token")),
        "expires_at": int(time.time()) + int(body.get("expires_in", 3600)),
    }
    p.write_text(json.dumps(cache))
    try:
        p.chmod(0o600)
    except OSError:
        pass


def _refresh_access_token():
    cache = _read_cache()
    refresh = cache.get("refresh_token")
    if not refresh:
        sys.exit("error: no cached refresh token — run:  outlook.py login")
    body = _post_form(
        login_base() + "/token",
        {
            "grant_type": "refresh_token",
            "client_id": client_id(),
            "refresh_token": refresh,
            "scope": SCOPE,
        },
    )
    if "access_token" not in body:
        sys.exit(f"error: token refresh failed: {body.get('error_description', body)}")
    _write_cache(body)
    return body["access_token"]


def access_token():
    cache = _read_cache()
    if cache.get("access_token") and cache.get("expires_at", 0) - TOKEN_LEEWAY > time.time():
        return cache["access_token"]
    return _refresh_access_token()


# ---------- authenticated Graph calls ----------

class ApiError(Exception):
    pass


def api(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(GRAPH + path, data=data, method=method)
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
        raise ApiError(f"{method} {path} -> {e.code} {e.reason}\n{detail}")


# ---------- subcommands ----------

def cmd_login(_args):
    body = _post_form(
        login_base() + "/devicecode",
        {"client_id": client_id(), "scope": SCOPE},
    )
    if "device_code" not in body:
        sys.exit(f"error: device-code request failed: {body}")
    print(body["message"], flush=True)  # "To sign in, use a web browser..."
    interval = int(body.get("interval", 5))
    deadline = time.time() + int(body.get("expires_in", 900))
    while time.time() < deadline:
        time.sleep(interval)
        token = _post_form(
            login_base() + "/token",
            {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": client_id(),
                "device_code": body["device_code"],
            },
        )
        err = token.get("error")
        if err == "authorization_pending":
            continue
        if err == "slow_down":
            interval += 5
            continue
        if err:
            sys.exit(f"error: {err}: {token.get('error_description', '')}")
        _write_cache(token)
        me = api("GET", "/me")
        print(f"logged in as {me.get('displayName')} <{me.get('mail') or me.get('userPrincipalName')}>")
        return
    sys.exit("error: device code expired before sign-in completed")


def cmd_whoami(_args):
    me = api("GET", "/me")
    print(f"{me.get('displayName')}\t{me.get('mail') or me.get('userPrincipalName')}")


def cmd_folders(_args):
    data = api("GET", "/me/mailFolders?$top=100")
    for f in data.get("value", []):
        print(f"{f.get('id','')}\t{f.get('displayName','')}")


def _add_categories(msg_id, category):
    # read-modify-write so tags applied in Outlook are never clobbered
    msg = api("GET", f"/me/messages/{msg_id}?$select=categories")
    cats = msg.get("categories", [])
    if category.lower() not in (c.lower() for c in cats):
        api("PATCH", f"/me/messages/{msg_id}", {"categories": cats + [category]})


def cmd_archive(args):
    label = None
    if args and args[0] == "--label":
        if len(args) < 3:
            sys.exit("usage: outlook.py archive [--label CAT] ID...")
        label = args[1]
        args = args[2:]
    if not args:
        sys.exit("usage: outlook.py archive [--label CAT] ID...")
    failures = 0
    for msg_id in args:
        # one bad id must not abort the rest of the batch
        try:
            if label:
                _add_categories(msg_id, label)
            # "archive" is a Graph well-known folder name; no id lookup needed
            moved = api("POST", f"/me/messages/{msg_id}/move", {"destinationId": "archive"})
            print(f"archived\t{moved.get('id', msg_id)}\t{moved.get('subject','')}")
        except ApiError as e:
            failures += 1
            print(f"FAILED\t{msg_id}\t{e}", file=sys.stderr)
    sys.exit(1 if failures else 0)


def cmd_label(args):
    if len(args) < 2:
        sys.exit("usage: outlook.py label CAT ID...")
    category, ids = args[0], args[1:]
    for msg_id in ids:
        _add_categories(msg_id, category)
        print(f"labelled\t{msg_id}")


def cmd_attachments(args):
    if not args:
        sys.exit("usage: outlook.py attachments ID [DIR]")
    msg_id = args[0]
    outdir = Path(args[1]) if len(args) > 1 else None
    data = api("GET", f"/me/messages/{msg_id}/attachments")
    for a in data.get("value", []):
        name = a.get("name", "attachment")
        print(f"{name}\t{a.get('contentType','')}\t{a.get('size',0)}")
        if outdir is not None and a.get("contentBytes"):
            outdir.mkdir(parents=True, exist_ok=True)
            path = outdir / os.path.basename(name)  # never let a name escape DIR
            path.write_bytes(base64.b64decode(a["contentBytes"]))
            print(f"saved\t{path}")


COMMANDS = {
    "login": cmd_login,
    "whoami": cmd_whoami,
    "folders": cmd_folders,
    "archive": cmd_archive,
    "label": cmd_label,
    "attachments": cmd_attachments,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(__doc__)
        sys.exit(1)
    try:
        COMMANDS[sys.argv[1]](sys.argv[2:])
    except ApiError as e:
        sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
