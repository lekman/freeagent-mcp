---
name: bootstrap
description: |
  One-time FreeAgent OAuth setup: creates the config file, stores the refresh
  token, and signs in the Graph mailbox-write helper. Triggers: "set up
  FreeAgent", "freeagent bootstrap", "connect FreeAgent".
---

# FreeAgent Bootstrap

Walk the user through the one-time FreeAgent OAuth bootstrap. The helper script lives at
`${CLAUDE_PLUGIN_ROOT}/skills/expenses/scripts/freeagent.py`; config lives at
`~/.config/freeagent/.env` (never inside the plugin directory — it is replaced on update).

Follow these steps in order, confirming each with the user before moving on:

1. **Check for existing config.** If `~/.config/freeagent/.env` exists and contains a
   `FREEAGENT_REFRESH_TOKEN`, verify it still works by running:

   ```bash
   set -a; source ~/.config/freeagent/.env; set +a
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/expenses/scripts/freeagent.py" whoami
   ```

   If that prints a user URL, tell the user the bootstrap is already done and stop.

2. **App registration.** Ask whether they have registered an OAuth app at
   https://dev.freeagent.com/apps. It must have redirect URI
   `http://localhost:8923/callback` and access level **Full Access (8)** — FreeAgent
   uses numeric access levels set at registration, not OAuth scopes, and lower levels
   cannot read accounting categories. If not registered, wait until they have done it.

3. **Create the config file.** Ask the user for the app's OAuth identifier (client ID)
   and secret, then write `~/.config/freeagent/.env` with mode 600:

   ```bash
   mkdir -p ~/.config/freeagent
   cat > ~/.config/freeagent/.env <<'EOF'
   FREEAGENT_CLIENT_ID=<their-client-id>
   FREEAGENT_CLIENT_SECRET=<their-secret>
   FREEAGENT_REDIRECT_URI=http://localhost:8923/callback
   EOF
   chmod 600 ~/.config/freeagent/.env
   ```

4. **Authorise.** Print the approval URL and have the user open it in a browser:

   ```bash
   set -a; source ~/.config/freeagent/.env; set +a
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/expenses/scripts/freeagent.py" auth-url
   ```

   After approving, the browser redirects to `http://localhost:8923/callback?code=XXXX`.
   The page will not load (nothing listens there) — tell the user to copy the `code`
   value from the address bar and paste it back here.

5. **Exchange the code.** Run:

   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/skills/expenses/scripts/freeagent.py" exchange <CODE>
   ```

   The refresh token is cached automatically in the token cache file
   (`~/.config/freeagent/token.json`) — no config-file edit needed. Do not echo
   tokens into the chat.

6. **Verify.** Re-run `whoami` (as in step 1). If it prints a user URL, the bootstrap
   is complete — the refresh token is long-lived and access tokens now refresh
   automatically.

7. **Graph login for mailbox writes.** The managed M365 MCP connector is the read
   path only (read-only by design); all archiving/labelling goes through
   `${CLAUDE_PLUGIN_ROOT}/skills/expenses/scripts/outlook.py`. If
   `outlook.py whoami` fails, run `outlook.py login` in the background, relay the
   printed device code to the user (they enter it at
   https://login.microsoft.com/device), and wait for completion. Then tell the
   user they can run `/freeagent:expenses` from now on.
