# freeagent

FreeAgent accounting for Claude Code — and the client library underneath it.

**Expenses**: receipt emails from the Outlook inbox become out-of-pocket
expenses. The mailbox is the source of truth — **in the inbox = not yet
imported; archived = done.** Claude judges which emails are receipts and
extracts supplier, amount and category; the deterministic API work is the
`freeagent` CLI. Nothing is posted without your confirmation, and processed
emails are archived after each successful create.

**Timesheets**: a weekly total per client becomes timeslips, spread across
working days, reconciled against what FreeAgent already holds so a re-run adds
nothing.

**Reads**: invoices, bills, expenses and bank explanations, including the walk
from an invoice to the bank transaction that actually settled it.

Invoicing and reconciliation follow. Each domain arrives as its own skill over
the same client, so the OAuth bootstrap happens once.

Renamed from `freeagent-expenses` in v2.0.0: the plugin outgrew the name. If
you installed the old one, remove it and install `freeagent@lekman`.

## Three things in one repo

**A Claude Code plugin** (`plugins/freeagent`), the workflows, where Claude does the judgement.

| Component               | Purpose                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/freeagent:bootstrap`  | One-time FreeAgent OAuth setup (config + refresh token)                                                              |
| `/freeagent:expenses`   | Import receipts: read-only pass → confirm → create → verify → archive; items the rules decide skip the confirm steps |
| `/freeagent:bills`      | Record supplier invoices as bills, after the same read-only pass and confirmation                                    |
| `/freeagent:timesheets` | Log billable hours for a week, or report what is already recorded                                                    |

Each is a skill, so the natural phrasings work too — "do my receipts", "log my
time", "have I done my timesheets". Every expenses run starts with a read-only
pass. Items the rules decide are then posted and archived without asking: a
recognised supplier with a complete, unique receipt, or an email a rule says to
archive. Everything else has two human gates: approve the table before anything
is created, confirm the created expenses before any email is archived. There is
no separate dry-run entry point — the dry run is simply the first phase of every
run.

**An MCP server**, started by the plugin from the published package
(`npx -y @lekman/freeagent@latest mcp`), or by any MCP client:

```json
{
  "mcpServers": {
    "freeagent": {
      "command": "npx",
      "args": ["-y", "@lekman/freeagent@latest", "mcp"]
    }
  }
}
```

| Tool                  | Does                                                                           |
| --------------------- | ------------------------------------------------------------------------------ |
| `timesheets_show`     | Read-only: the timeslips in a range, and which have no description             |
| `timesheets_plan`     | Read-only: the grid a weekly total turns into, with conflicts and skipped days |
| `timesheets_apply`    | Create the planned timeslips; writes nothing when any recorded day conflicts   |
| `timesheets_describe` | Set each day's description as the timeslip comment; changes nothing else       |

It reads the OAuth credentials from `~/.config/freeagent/.env` and the client
mapping from `~/.config/freeagent/finance.json`, both written by
`/freeagent:bootstrap`.

**An npm package**, `@lekman/freeagent`, the deterministic half, usable on its own.

```ts
import { ClientFactory, InvoiceReader, Invoices } from "@lekman/freeagent";

const reader = new InvoiceReader(ClientFactory.fromEnvironment());
const chasing = await reader.openOrOverdue();
console.log(Invoices.outstandingByCurrency(chasing));

// "Paid" is the ledger's opinion; this walks invoice -> bank explanation ->
// bank transaction and reports `claimed` when nothing in the bank backs it up.
for (const e of await reader.withEvidence("paid"))
  console.log(e.state, e.reason);
```

| Export                             | Does                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `ClientFactory`, `FreeAgentClient` | OAuth token lifecycle and authenticated requests                                            |
| `InvoiceReader`, `Invoices`        | Invoice views, overdue days, outstanding by currency, payment evidence                      |
| `BillReader`, `Bills`              | The same for the purchase side, matched on `paid_bill`                                      |
| `ExpenseReader`, `Expenses`        | Out-of-pocket claims and what is still owed to the claimant                                 |
| `TimesheetWriter`, `Timesheets`    | Plan a week, reconcile against what exists, write what is missing                           |
| `BankReader`                       | Bank accounts and their transaction explanations                                            |
| `Money`                            | Totals grouped **by** currency, never across; conversion only on a rate the ledger supplied |

It also ships a CLI, `freeagent`, which is what the skills call:

```bash
freeagent timesheets show  --from 2026-08-17 --to 2026-08-21
freeagent timesheets plan  --from 2026-08-17 --to 2026-08-21 --hours "Acme=40,Globex=20"
freeagent timesheets apply --from 2026-08-17 --to 2026-08-21 --hours "Acme=40,Globex=20"
```

`plan` never writes. `apply` re-plans first, so running it twice is safe.

### What it will not do

Deliberate, and the reason the numbers can be trusted:

- **It never converts on a rate it chose.** Totals are grouped per currency;
  conversion uses the `exchange_rate` the ledger booked, and says so.
- **It never treats "Paid" as proof.** A settled invoice with no bank
  explanation naming it is reported as `claimed`, not paid.
- **It never guesses a client.** An unmapped label throws before any network
  call — there is no fallback project.
- **It never overwrites a recorded timeslip.** A day that disagrees with the
  plan is a conflict, reported and left alone.

## Setup

### 1. Install the plugin

```
/plugin marketplace add lekman/freeagent-mcp
/plugin install freeagent@lekman
```

### 2. Connect the Microsoft 365 MCP

The skill reads and archives mail through the **Microsoft 365** connector (an
Anthropic-managed claude.ai connector — no local MCP server to run):

1. Go to [claude.ai → Settings → Connectors](https://claude.ai/settings/connectors).
2. Add **Microsoft 365** and sign in with the mailbox account.
3. In Claude Code, run `/mcp` and confirm `claude.ai Microsoft 365` shows as connected
   (it appears automatically when you are logged in with the same claude.ai account).

The connector is the **read path only** — it is read-only by design
(`outlook_email_search`, message read).

**All mailbox writes go through the bundled Graph helper**:
[outlook.py](plugins/freeagent/skills/expenses/scripts/outlook.py) uses OAuth device-code
flow with delegated `Mail.ReadWrite` and moves messages to Archive / applies the
`Receipts` category. One-time setup:

```
python3 plugins/freeagent/skills/expenses/scripts/outlook.py login
# open https://login.microsoft.com/device, enter the printed code
```

Tokens cache at `~/.config/freeagent/msgraph-token.json` (mode 600, auto-refresh).
It authenticates as the Microsoft Graph Command Line Tools public client by
default; set `MSGRAPH_CLIENT_ID` to use your own app registration. It can only
file mail (Archive move) and edit categories — it never deletes.

No FreeAgent MCP exists or is needed — the bundled `freeagent.py` script talks to the
FreeAgent REST API directly.

### 3. Register a FreeAgent OAuth app

1. Create an app at [dev.freeagent.com/apps](https://dev.freeagent.com/apps).
2. Set the redirect URI to `http://localhost:8923/callback`.
3. Choose access level **Full Access (8)** — FreeAgent uses numeric access levels set
   at registration (not OAuth scopes); lower levels cannot read accounting categories.
4. Note the OAuth identifier (client ID) and secret.

### 4. Run the bootstrap

```
/freeagent:bootstrap
```

This creates `~/.config/freeagent/.env` (mode 600) with your client ID/secret, walks
you through the browser approval, exchanges the code, and stores the long-lived
refresh token. It only needs to run once; access tokens refresh automatically into
`~/.config/freeagent/token.json`.

Config lives under `~/.config/freeagent/`, never inside the plugin directory — the
plugin directory is replaced on update.

### 5. Import receipts

```
/freeagent:expenses
```

or just say "do my receipts". The flow has two human gates:

1. **Before posting** — the skill shows a confirmation table of everything it wants
   to create; nothing is posted until you approve.
2. **Before archiving** — after creating the expenses it updates the ledger at
   `.tmp/freeagent-expenses.md` (one row per email: clickable dashboard link to the
   created expense, amount, currency, category, status). You compare the expenses
   against the emails, approve, and only then are the emails batch-archived.

The ledger is a rolling file that survives across runs: archived items move to a
pruned History section, and anything unresolved (e.g. a failed archive move) stays
in Pending and is reconciled at the start of the next run. The skill ensures
`.tmp/` is gitignored before writing, so the ledger never ends up in a commit.

### 6. Map your clients (needed for timesheets only)

`POST /v2/timeslips` requires a **task** URI and has no default, so each client
label has to be mapped before hours can be logged. Create
`~/.config/freeagent/finance.json`:

```json
{
  "user": "https://api.freeagent.com/v2/users/<user-id>",
  "workingDays": [1, 2, 3, 4, 5],
  "holidays": ["2026-12-25"],
  "clients": {
    "Acme": {
      "project": "https://api.freeagent.com/v2/projects/<project-id>",
      "task": "https://api.freeagent.com/v2/tasks/<task-id>"
    }
  }
}
```

The URIs come from `GET /v2/projects` and `GET /v2/tasks`, or from any timeslip
you have already recorded. Give the file mode 600.

It lives outside the repo on purpose. It decides which project and task your
hours land on, so a `git pull`, a merge or a bad rebase must not be able to
change it — a silently altered mapping puts real hours on the wrong contract,
which becomes a wrong invoice to a real client.

### 7. Log time

```
/freeagent:timesheets
```

or say "log 40 hours each for Acme and Globex this week". The flow settles the
**dates** first and confirms them, because "this week" is ambiguous — on a
Sunday the week ending and the week starting are both defensible readings, and
picking wrong either double-logs a finished week or bills the wrong one.

Then it shows what is already recorded, plans the spread, presents the grid,
and writes only after an explicit yes. Asking for hours is the _request_; the
approval is seeing the grid it turned into.

## Configuration reference

`~/.config/freeagent/.env`:

| Variable                  | Required | Default                          | Purpose                                                                                                     |
| ------------------------- | -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `FREEAGENT_CLIENT_ID`     | yes      | —                                | OAuth identifier from dev.freeagent.com                                                                     |
| `FREEAGENT_CLIENT_SECRET` | yes      | —                                | OAuth secret                                                                                                |
| `FREEAGENT_REFRESH_TOKEN` | no       | (token cache)                    | Optional override; the bootstrap caches the refresh token in `~/.config/freeagent/token.json` automatically |
| `FREEAGENT_REDIRECT_URI`  | no       | `http://localhost:8923/callback` | Must match the registered app                                                                               |
| `FREEAGENT_BASE_URL`      | no       | `https://api.freeagent.com`      | Use `https://api.sandbox.freeagent.com` for testing                                                         |
| `FREEAGENT_TOKEN_CACHE`   | no       | `~/.config/freeagent/token.json` | Access-token cache location                                                                                 |

`~/.config/freeagent/finance.json` (timesheets only):

| Key           | Required | Default       | Purpose                                                                        |
| ------------- | -------- | ------------- | ------------------------------------------------------------------------------ |
| `user`        | yes      | —             | Claimant URI that timeslips are written against                                |
| `clients`     | yes      | —             | Label to `{ project, task }` URIs. Both are required; there is no default task |
| `workingDays` | no       | `[1,2,3,4,5]` | ISO weekdays worked, 1 = Monday                                                |
| `holidays`    | no       | `[]`          | Dates never worked, `YYYY-MM-DD`. Hours redistribute across the remaining days |

Client matching is exact and case-insensitive. An unknown label is an error
naming what _is_ configured — never a guess at the nearest match.

## API reference

- FreeAgent API docs: https://dev.freeagent.com/docs
- Postman collection for exploring the API:
  https://github.com/fac/postman-freeagent-api-collection
