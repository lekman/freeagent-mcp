---
name: expenses
description: |
  Imports receipt emails from the Outlook inbox into FreeAgent as out-of-pocket expenses.
  Reads unimported mail via the Microsoft 365 connector (inbox = not yet imported);
  creates expenses via the FreeAgent API; the claimant is the operator (a director), since
  these are personal-card and personally-settled Amex purchases the company reimburses.
  Triggers: "import receipts", "log my expenses", "process expense emails",
  "consolidate expenses", "FreeAgent expenses", "do my receipts".
---

# FreeAgent Expense Import

Turns receipt emails into FreeAgent expenses with the mailbox as the source of truth:
**in the inbox = not yet imported; archived = done.** Receipts paid on a personal card or
a personally-settled business Amex are out-of-pocket expenses the company owes back, so
they map to the FreeAgent **Expenses** object with a negative `gross_value`.

This skill does the deterministic API work through `freeagent.py`. Claude does the
judgement (which emails are receipts, supplier, amount, currency, category) and posts
without confirmation only what the rules already decide.

**The read-only pass is not a mode — it is always the first phase.** Every run
executes Steps 0–4 read-only: full inventory, classification, context
resolution, and dedup, with no creates, no archive moves, no ledger writes.
Then [rule-covered items](#step-4b-separate-rule-covered-items) are posted and
archived without asking. For everything else, present the confirmation table
**plus a "not a receipt" list with a one-line reason per excluded email** (so
the classifier can be sanity-checked), and stop. Creating those expenses happens
only after the user explicitly approves that table, and archiving happens only
after they separately confirm the created expenses in FreeAgent. Two gates, in
that order, for every item the rules do not decide.

## Prerequisites

- Microsoft 365 (Outlook) MCP connector active — **read-only by design**. It is the
  search/read path only. All mailbox writes (archive moves, `Receipts` category) go
  through `scripts/outlook.py`, a Microsoft Graph helper with delegated
  `Mail.ReadWrite` (device-code auth via `outlook.py login`; token cache
  `~/.config/freeagent/msgraph-token.json`). It moves mail only to Archive and
  edits categories — it never deletes.
- Config at `~/.config/freeagent/.env` with FreeAgent OAuth credentials and a refresh
  token. If it is missing or `whoami` fails, stop and direct the user to run
  `/freeagent:bootstrap` — do not attempt the OAuth flow ad hoc.
- The helper script is `scripts/freeagent.py` inside this skill's base directory
  (announced when the skill loads). The token cache defaults to
  `~/.config/freeagent/token.json`; nothing is ever written inside the plugin
  directory (it is replaced on update).

---

## Workflow

Always load the environment first, and set a path variable for the helper script
(substitute this skill's announced base directory):

```bash
set -a; source ~/.config/freeagent/.env; set +a
FA="<skill-base-dir>/scripts/freeagent.py"
```

### Step 0: Reconcile the ledger from previous runs

The run ledger lives at `~/.config/freeagent/freeagent-expenses.md` and survives
across runs. **It is deliberately not in the working directory**: this skill runs
from whichever repo the operator happens to be in, and a cwd-relative ledger
starts a fresh one each time — losing the reconciliation history that Step 0
depends on, and dropping supplier and expense data into a code checkout that may
be public. It sits beside the credentials it already reads. If it exists and has rows under `## Pending`,
deal with those **before** looking at new mail:

- `created` / `duplicate` rows (approved but the archive never happened, or the
  session ended early): archive rule-covered rows now, confirm the others with the
  user and archive them, then move the rows to `## History`.
- `created, archive FAILED` rows: retry the archive move; on success move to
  `## History`, otherwise leave in `## Pending` and note the retry.
- Rows whose email is no longer in the inbox (the user archived manually): move
  straight to `## History` with status `archived manually`.

A clean ledger (no `## Pending` rows) means nothing to reconcile — proceed.

### Step 1: Inventory candidate receipts

Search the **inbox** via the Microsoft 365 connector. Every unarchived inbox message is
a candidate; Claude judges which are receipts (order confirmations, invoices, payment
receipts) and which are not (newsletters, notifications). Inbox presence is the only
"not yet imported" signal — do not rely on tags or dates.

For each receipt, capture: sender, subject, received date, body, attachment presence,
the internet `Message-ID` (dedup key), and the connector's message `id` (needed for
the archive move in Step 8).

If there are no candidates, say so and stop.

### Step 2: Resolve FreeAgent context (once per run)

```bash
python3 "$FA" whoami        # -> claimant user URL
python3 "$FA" categories    # -> url <tab> nominal <tab> description <tab> [group]
python3 "$FA" projects      # -> url <tab> name <tab> currency <tab> status
```

The `projects` list is needed whenever a supplier rule (below) links expenses to a
re-billable client project.

**Read the operator's rules file** at `~/.config/freeagent/rules.md`. It holds
everything specific to this operator's business: the FreeAgent subdomain and
claimant, the operator's own organisation and tenants, the supplier rules
(re-bills, never-import rules), and the suppliers named for each category. Apply
its tables in Step 3 and Step 4b alongside the method below. It sits outside the
plugin and outside every repository, because it names clients and suppliers.

If the file is missing, no item is rule-covered: run the read-only pass, then stop
at the Step 5 gate, say that the rules file is missing, and treat every item as
needing approval. Never fill in a supplier rule from memory.

Also verify the Graph write path once per run:

```bash
python3 "<skill-base-dir>/scripts/outlook.py" whoami
```

If it fails, direct the user through `outlook.py login` (device code) before
Step 8 — the run can proceed to expense creation, but archiving waits for it.

If `whoami` returns an unexpected user, stop and report. Hold the user URL and category
list in context for the rest of the run.

### Step 3: Extract and classify each receipt

| Field                | Source                                         | Notes                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dated_on`           | Receipt/transaction date in the email          | `YYYY-MM-DD`. Not the received date if they differ.                                                                                                                                                  |
| `gross_value`        | Total paid                                     | **Negative** for spend (e.g. `-42.50`).                                                                                                                                                              |
| `currency`           | Receipt currency                               | **GBP, SEK, USD or EUR.** Omit for GBP; set explicitly otherwise. Anything else: flag for review.                                                                                                    |
| `category`           | Category URL from Step 2 via the mapping below | Anything that fits none of the mapped categories: ask at confirmation — never guess.                                                                                                                 |
| `description`        | **Supplier name**                              | Plus a short qualifier only when needed to disambiguate, e.g. "AWS" or "AWS - June compute".                                                                                                         |
| `receipt_reference`  | Outlook internet `Message-ID`                  | Dedup backstop. **No email** (operator supplies a PDF directly): use the supplier's own **invoice number** instead — it is the natural key, and with no inbox presence it is the _only_ dedup guard. |
| `attachment`         | Supported receipt file, if retrievable         | See attachment rules.                                                                                                                                                                                |
| **tenant / account** | Account or organisation block on the receipt   | **Multi-tenant suppliers only** (Microsoft, Google, GitHub, Apple Developer). Not posted to FreeAgent — it decides _whose_ cost this is. See the tenant check below.                                 |

**Category mapping** (match by supplier/purpose; resolve to the URL from Step 2).
The operator's named suppliers for each category are in the rules file:

| Category                    | Goes here                                                                                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Travel**                  | Flights, trains, buses, taxis/Uber, airport services (fast track, parking), onboard wifi                                                                                                                             |
| **Computer Software**       | GitHub, Anthropic, Cloudflare, Microsoft/Azure, AWS, app subscriptions and licences                                                                                                                                  |
| **Accommodation and Meals** | Hotels, restaurant/pub meals and subsistence on trips, hotel stays                                                                                                                                                   |
| **Office Costs**            | Workspace/coworking day passes. (Decided by the operator.)                                                                                                                                                           |
| **Internet & Telephone**    | VoIP and telephony providers, broadband and line rental. Category **273** — not Computer Software.                                                                                                                   |
| **Insurance**               | Business insurance: professional indemnity, public liability, cyber. Category **364**. Premiums are **VAT-exempt** and Insurance Premium Tax is not VAT, so `sales_tax_rate` stays `"0"` and no part is reclaimable. |

Anything that fits none of the above: do not guess — ask at the Step 5 gate.

**Subcontractor Costs (150) is not here on purpose.** A subcontractor invoices the
company, so it is money owed out and belongs to `/freeagent:bills`, not to an
out-of-pocket expense the company reimburses. See
[bills/SKILL.md](../bills/SKILL.md) and the bills supplier table in the rules file.

**VAT (`sales_tax_rate`)**: always `"0"` for Travel expenses and for every non-GBP
expense. For GBP purchases where VAT is shown on the receipt, set the actual rate
(e.g. `"20.0"`) **when the receipt qualifies as a VAT invoice and is attached**;
otherwise `"0"`, with the potential VAT amount flagged in the confirmation table.

A receipt qualifies when it carries the supplier's name and address, the
supplier's **VAT number**, the invoice date, and the net/VAT/gross split. Below
£250 that is a simplified VAT invoice and the customer's own name and VAT number
are not required, which covers most subscription receipts.

**Most such receipts arrive as HTML with no PDF attached.** Render the email's own
body — a faithful print of what was received, not a reconstruction:

```bash
# body -> HTML -> PDF (Chrome is present on macOS; wkhtmltopdf also works)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
  --disable-gpu --no-pdf-header-footer \
  --print-to-pdf=receipt.pdf "file:///path/to/body.html"
pdftotext receipt.pdf - | grep -iE "VAT|total"   # confirm before attaching
```

Verify the extracted text actually contains the VAT fields before attaching —
a blank render is a silent failure. Attach as `application/x-pdf`.

Setting a rate on one month of a recurring subscription while earlier months sit
at `"0"` leaves the series inconsistent. Offer the backfill at the gate; the
update flow is in Step 6.

**Full amounts are mandatory before the confirmation gate.** Never present a row
with a placeholder amount. Extraction ladder, in order:

1. **Email body** (regex the total out; bodies can be huge HTML — extract, don't
   read; when a read tool overflows and saves the result to a file, regex the
   saved file). Use the amount **actually paid after credits/discounts**
   (OneKeyCash, Uber One credits, order discounts), not the pre-credit total.
2. **Attached PDF** — but beware: attachments are often _tickets_, which carry no
   price (Arlanda, SJ, FastTrack). A ticket is not a receipt.
3. **Receipt-download link in the email** — fetch it (curl); if it returns a real
   receipt PDF, use it for both the amount and the expense attachment (better
   evidence than a ticket).
4. **Ask the user** — some receipts sit behind JS/login walls (e.g. SJ); the user
   reads the amount off the page. A row without an amount is not confirmable.

**Dual-currency receipts:** when a receipt shows a local sticker price and a
"paid in cardholder's currency" amount (e.g. an airline: 900.00 SEK / £70.00 GBP),
post the **charged** currency and amount — that is the real cost.

**Passenger check on travel bookings:** a booking listing family members as
passengers is personal regardless of which card paid — reclassify and archive
without import (e.g. a two-passenger holiday flight).

**Business vs personal.** Classify every receipt as `business` or `personal`.
Signals: which card/profile paid (e.g. an Uber ride tagged with the company profile
is business, one tagged [Personal] is not), the supplier (developer tooling, cloud,
client travel = business; household, health, leisure = personal), and the
description. Only business receipts become FreeAgent expenses. Personal receipts
are still catalogued and recommended for archiving — they must not linger in the
inbox — but nothing is posted for them. When genuinely unsure, mark `review` and
ask at the confirmation gate.

**Tenant check (multi-tenant suppliers).** A receipt addressed to you is not
automatically your company's cost. Microsoft, Google, GitHub and Apple
Developer all bill the mailbox of whoever administers a tenant, so the supplier
and the amount do not settle whose expense it is.

Two questions, and **both** must be answered — the first alone gives the wrong
answer in either direction:

1. **Whose tenant is it?** Read the account block. Microsoft 365 invoices carry
   `Organisation name` and `Domain` near the foot of the email; GitHub receipts
   name the org in the subject. **On a Microsoft 365 PDF invoice the test is the
   Sold-To / Bill-To address**, because recent invoices have no "Account
   information" block. A nonprofit pricing line is another sign the tenant is not
   the operator's company.
2. **Who actually pays it?** Whose card settled it.

The operator's own organisation, tenants and address are in the rules file.

| Tenant                 | Paid by           | Treatment                                                                                                    |
| ---------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ |
| The operator's company | the operator      | Import normally                                                                                              |
| Another organisation   | **the operator**  | **Still an out-of-pocket expense** — import, then check the supplier rules for a re-bill to a client project |
| Another organisation   | That organisation | **Never import** — archive with the `Receipts` label                                                         |
| Unrecognised           | either            | **Stop at the Step 5 gate and ask.** Never default to the operator's company                                 |

Row two is the one that is easy to get wrong: paying for someone else's tenant
out of your own pocket is exactly what an out-of-pocket expense is, and
refusing it would leave real money unclaimed. Row three is money that was never
yours to claim. The difference is the card, not the tenant.

This is the same principle as the passenger check on travel bookings, run in
both directions: who paid does not decide whose _tenant_ it is, and whose
tenant it is does not decide who _paid_.

_(Lesson from a real mis-post: a Microsoft 365 invoice for another
organisation's tenant, administered but not paid by the operator, was once
imported by mistake. The rule was first written as tenant-only and corrected the
same day, because that version would have blocked a client re-bill, which is row
two.)_

**Supplier rules.** Some suppliers have standing treatment beyond category
matching. The operator's table is in `~/.config/freeagent/rules.md`; check every
receipt against it before building its JSON. The table has two columns, Match and
Treatment. These made-up rows show the kinds of rule it holds:

| Match                                                                                  | Treatment                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub receipt where the org is **acme** (subject `[GitHub] Payment Receipt for acme`) | Link to the **Acme** project and re-bill at a specific price in the project's currency: `project` = the Acme project URL from `projects`, `rebill_type` = `"price"`, `rebill_factor` = receipt total × current mid-market rate × the markup the rule names, rounded **up** to a whole unit. Look up the rate at run time from the source the rule names. Show the calculation in the confirmation table. |
| Any **Microsoft 365** invoice for a tenant other than the operator's company           | **Never import** — not the operator's cost and not billed to the operator. Archive with the `Receipts` label, no expense action. Applies to every plan alike.                                                                                                                                                                                                                                            |
| Apple invoice whose line item is a personal product (for example a device warranty)    | **Never import** — treat as personal regardless of card. Archive without import, together with its PayPal payment-pair email when present.                                                                                                                                                                                                                                                               |
| A rule that no longer applies                                                          | Keep the row and mark it _Superseded_ with what it was, so an old ledger entry still makes sense.                                                                                                                                                                                                                                                                                                        |

`rebill_type: "price"` + `rebill_factor` + `project` are proven live to store
correctly.

GitHub receipts for orgs with no rule are ordinary non-rebilled business
expenses.

**A gap in a supplier's monthly chain is not evidence of a missed import.** When a
recurring supplier appears to be missing a month, two checks come before any
investigation, in this order:

1. **Read the supplier rules table in the rules file.** A supplier that is never
   imported will always look like a gap, permanently. _(Learned the slow way: an
   apparent "supplier is absent from FreeAgent entirely" finding was once investigated
   across many invoice PDFs before anyone re-read the rule that already said never
   import.)_
2. **Confirm the supplier actually billed.** A month with no charge produces no expense,
   and that is correct, not missing.

Two cases of the second check, both proven live:

- **AWS.** Search the whole mailbox for `"Billing Statement Available"`. AWS sends no
  statement for some months, so a gap in the chain can be theirs, with nothing missed
  at import.
- **Azure on a Visual Studio subscription.** Read the invoice's **Total Amount, never
  the Usage Charges.** The Visual Studio Enterprise free-usage credit posts as a negative
  line that can cancel the usage entirely, so an invoice can net **£0.00** on real gross
  usage. A £0.00 invoice is correctly absent from FreeAgent. Related trap: the Azure
  **budget alerts forecast gross usage, not the charged amount**, so an alert above the
  threshold does not imply a bill of that size.

**Same-purchase email groups.** One purchase often produces several emails: an
Apple invoice plus the PayPal payment receipt for the same Order ID, a flight
receipt plus its EMD documents, a receipt plus a license-key email. Group emails
by supplier + order id/amount + date. One group = **one expense**: pick the most
complete email (best attachment, itemised amounts) as the source and use its
`Message-ID` as `receipt_reference`; every email in the group is archived and
labelled together in Step 8.

**One expense per payment, not per booking reference.** A single booking ref can
span several purchases (e.g. an airline booking: the flight paid one week, a
fast-track add-on paid the next — two receipts with distinct receipt numbers and
payment dates). Split by receipt/payment date, one expense each, even though the
emails share a booking-reference group for archiving.

### Step 4: Deduplicate

An email may still sit in the inbox after its expense was created (an archive move
failed, or the expense predates auto-archiving). The `receipt_reference` check is
therefore mandatory, not optional:

```bash
python3 "$FA" find-expense "<Message-ID>"
```

Exit 0 with a URL: already logged — do not create a new expense, but mark it
`duplicate` so it is archived in Step 8 and stops resurfacing. Exit 1: proceed to
the fuzzy check below. (Known limitation: `find-expense` scans the 100 most
recent expenses only; sufficient at current volumes.)

**Fuzzy clash check against manual entries (mandatory).** `receipt_reference`
only catches expenses this skill created. Expenses entered by hand in FreeAgent
carry no reference, and recurring subscriptions (GitHub, Anthropic, Cloudflare…)
recur with the same amount on nearby dates. Before creating anything, fetch the
existing expenses for the batch's date range once
(`GET /v2/expenses?from_date=...&to_date=...`, paginate) and compare each
candidate against entries with **no** `receipt_reference`:

- Same supplier keyword in the description + same amount + same currency, dated
  within **±7 days** → already recorded: skip, mark `duplicate (manual)`.
- Same supplier keyword within ±7 days but a _different_ amount or currency →
  **flag at the confirmation gate**, never auto-create. (Real case: a flight
  manually recorded at the SEK sticker price while the card was charged in GBP —
  same purchase; only supplier + week matched.)
- Recurring subscriptions: if the supplier shows a manual monthly cadence (e.g.
  "GitHub −$10 on the 27th"), confirm the candidate month is not already covered
  before importing that month's receipt.

### Step 4b: Separate rule-covered items

An item the rules already decide needs no approval. The operator approved this
in advance on 2026-11-05, for posting and for archiving, in live and scheduled
runs. Everything else still goes through both gates.

A **receipt** is rule-covered when all of these hold:

- **Recognised supplier.** It is named in the category mapping or the supplier
  rules (here or in the rules file), or it has an earlier FreeAgent expense in the
  same category. A first-time
  supplier that only fits a category by purpose is not recognised.
- **Clearly business.** It is not marked `review`, and the passenger and tenant
  checks are settled.
- **Complete.** The full amount was read from the receipt, the currency is GBP,
  SEK, USD or EUR, and no field is waiting on a question.
- **Dedup clean.** `find-expense` exits 1 and the fuzzy check raised no flag.
- **Expected amount.** The amount is at most twice the supplier's largest earlier
  expense, when it has one.
- **Proven fields.** The expense uses no field that needs a probe.

An **archive-only email** is rule-covered when a rule decides it:

- a `find-expense` match, or a `duplicate (manual)` match on supplier, amount and
  currency;
- a supplier rule that says never import;
- a passenger check that shows a family booking;
- a secondary email of a same-purchase group whose expense exists.

A receipt called personal by judgement alone is not rule-covered. It stays at the
gate.

Rule-covered items skip the Step 5 table and the Step 7 handover:

1. Create the expense as in Step 6.
2. `GET` it back and compare the date, amount, currency and category.
3. Write the ledger row as in Step 7, then archive as in Step 8 and move the row to
   `## History`.
4. List it in the run's summary with its dashboard link, so the operator can check
   it afterwards. `freeagent.py delete-expense ID` reverses a wrong post.

A failed create or a read-back that differs stops that item: its email stays in the
inbox, its row stays in `## Pending`, and the summary reports it.

### Step 5: Confirm (human in the loop)

This step and the next ones cover the items Step 4b left. If none are left, skip to
the summary in Step 8.

Write the full run overview into the ledger (`~/.config/freeagent/freeagent-expenses.md`)
**before** asking for approval, as a `## Proposed (run <date> — NOT yet
posted, awaiting approval)` section, and open it for review
(`code ~/.config/freeagent/freeagent-expenses.md`; if a file-send tool is available, send it
too). The overview is the review surface — a chat table alone scrolls away;
the document gives the operator a stable side-by-side against the emails.

The Proposed section carries two tables:

1. Everything about to be posted:

| #   | Date | Supplier | Amount | Cur | Category | Attachment | Email subject | Note |
| --- | ---- | -------- | ------ | --- | -------- | ---------- | ------------- | ---- |

The Note column shows the evidence for judgement calls: dedup-pattern
matches ("follows May/Jun pattern"), first-time imports, rebill
calculations spelled out (rate × factor, rounded), and email groupings.

2. An **Archive-only, no import** table listing every classified-out email
   with its reason (duplicate (manual), supplier rule, personal + which
   signal) — so the operator reviews what will be archived, not only what
   will be posted.

Call out anything low-confidence: uncertain category, missing attachment, SEK amounts,
odd values. **Do not post these before the user approves.** If corrections are made, update
the Proposed section and re-show. On approval, the Proposed section becomes the
run's `## Pending` rows (Step 7).

### Step 6: Create the expenses

For each approved receipt:

1. Build the expense JSON (root key `expense`) with `user`, `category`, `dated_on`,
   `description`, `gross_value`, `receipt_reference`, plus `currency` for SEK and
   `attachment` if a supported file is present.
2. Create it:

   ```bash
   echo '<expense-json>' | python3 "$FA" create-expense
   ```

   On error, stop for that item and report; its email must **not** be archived.

**Probe-first for unproven fields.** When a batch introduces expense fields not
previously verified against the live API (e.g. `project`/`rebill_*`, a new
currency), create **one** expense first, `GET` it back and confirm every field
stored as intended, then run the rest of the batch.

For a batch, prefer a one-off driver script (in `.tmp/`) that does
`sys.path.insert(0, "<scripts-dir>"); import freeagent` and calls
`freeagent.api(...)` directly: one date-ranged dedup sweep for the whole batch,
then one create per item with the attachment base64-inlined — instead of 2N
subprocess round-trips.

If a duplicate is discovered _after_ creation, `freeagent.py delete-expense ID`
removes it (or keep the skill copy and delete the manual one — user's call at
the gate).

**Updating an existing expense** (e.g. attaching a VAT invoice to an earlier
month, or correcting a rate). `PUT /v2/expenses/:id` replaces the record, so
**GET it first and rebuild the payload from what is there** — a partial PUT
blanks the fields it omits:

```python
b = freeagent.api("GET", f"/v2/expenses/{eid}")["expense"]
freeagent.api("PUT", f"/v2/expenses/{eid}", {"expense": {
    "user": b["user"], "category": b["category"], "dated_on": b["dated_on"],
    "description": b["description"], "gross_value": b["gross_value"],
    "receipt_reference": b.get("receipt_reference"),
    "sales_tax_rate": "20.0",
    "attachment": {...},
}})
```

Proven live against a real expense: `dated_on`, `description`,
`gross_value` and `receipt_reference` all preserved, rate and attachment stored.
Probe one record and read it back before running a batch.

**Do not archive anything yet** — archiving happens in Step 8, after the user has
verified the created expenses against the run report.

### Step 7: Update the ledger and wait for verification

The ledger is a single rolling file, `~/.config/freeagent/freeagent-expenses.md`,
updated in place every run — not one file per run. It lives outside every git
repository by design: it links real expenses and suppliers and must never be
committed.

Ledger conventions: wrap every table in a `<details><summary>…</summary>` block
(the file gets long); when a batch completes, move its rows to a new History
subsection and leave the empty Pending section **headers** in place, ready for
the next run; the header blockquote carries the standing config (claimant,
category ids, VAT rules, supplier-rules pointer) so a cold-start run needs no
rediscovery.

Ledger format:

```markdown
# FreeAgent expense ledger

## Pending

| Run        | Email subject             | From                 | Received   | Type     | Group            | Expense                                                                 | Amount | Currency | Category          | Status  |
| ---------- | ------------------------- | -------------------- | ---------- | -------- | ---------------- | ----------------------------------------------------------------------- | ------ | -------- | ----------------- | ------- |
| 2026-07-10 | AWS invoice June          | aws@amazon.com       | 2026-06-15 | business | —                | [Expense 123](https://acme.freeagent.com/users/<user-id>/expenses/123/) | -42.50 | GBP      | Computer Software | created |
| 2026-07-10 | PayPal receipt ABC123XYZ0 | service@paypal.co.uk | 2026-07-02 | business | apple-ABC123XYZ0 | (grouped)                                                               | —      | —        | —                 | grouped |

`Type` is `business`, `personal`, or `review`. `Group` ties same-purchase emails
together; secondary group members carry status `grouped` and archive with their
primary.

## History

| Run        | Email subject | Expense                                                                 | Amount | Currency | Status             |
| ---------- | ------------- | ----------------------------------------------------------------------- | ------ | -------- | ------------------ |
| 2026-07-03 | SaaS renewal  | [Expense 119](https://acme.freeagent.com/users/<user-id>/expenses/119/) | -12.00 | GBP      | created + archived |
```

Append this run's rows under `## Pending`. Link each expense with its **dashboard
URL**, not the API URL: `create-expense` prints
`https://api.freeagent.com/v2/expenses/<id>`; the human-clickable form is
`https://<subdomain>.freeagent.com/users/<claimant-user-id>/expenses/<id>/` — the
subdomain is in the rules file, and the claimant user id is the numeric tail of the
`whoami` URL. Status at this point is
one of `created`, `duplicate` (from Step 4), `skipped`, `create FAILED`.

Then **stop and hand over**: point the user at the ledger and ask them to open the
expense links, compare each against its email, and approve archiving. This is the
second human gate — Step 5 approved the posting, this one approves the mailbox
moves. Do not archive until the user explicitly approves.

### Step 8: Batch-archive on approval, clean up the ledger, summarise

Once the user approves (all items, or a corrected subset):

1. Archive the approved emails with the Graph helper — same message ids the MCP
   search returns:

   ```bash
   python3 "<skill-base-dir>/scripts/outlook.py" archive --label Receipts <ID>...
   ```

   Apply `--label Receipts` to every email whose group produced an expense —
   including the secondary emails of a same-purchase group. Personal receipts
   approved for archiving are moved without the label (omit `--label`). Only
   emails whose status is `created`, `duplicate` or `personal` are eligible; a
   `create FAILED` email is never archived. The helper continues past per-message
   failures and reports each one.

2. A per-message `ErrorItemNotFound` usually means the message already left the
   inbox (ids go stale once a message moves) — verify with a fresh search before
   treating it as a failure.
3. If a move genuinely fails, keep the expense (it is already created) and leave
   the row in `## Pending` with status `created, archive FAILED` — Step 0 of the
   next run retries it, and dedup protects against double-posting either way.
4. **Clean up for future runs:** move every successfully archived row from
   `## Pending` to `## History` (condensed columns, final status such as
   `created + archived` or `duplicate, archived`). `## Pending` must end the run
   containing only genuinely unresolved items. Prune `## History` to the newest
   ~50 rows — FreeAgent itself is the permanent record.
5. Summarise in chat: created expenses (dashboard link + amount), archived emails,
   skipped/failed items with reasons, run totals per currency, anything left in
   `## Pending`, and the ledger path.

---

## Attachment rules

The Expenses create call accepts an inline attachment, base64-encoded, max 5MB, content
type one of: `image/png`, `image/x-png`, `image/jpeg`, `image/jpg`, `image/gif`,
`application/x-pdf`.

Fetch attachments through the Graph helper (the MCP read path does not expose
attachment bytes):

```bash
python3 "<skill-base-dir>/scripts/outlook.py" attachments <MSG_ID> .tmp/attachments
```

This lists each attachment (name, content type, size) and saves the files. Then:

- Supported file (PDF/image, ≤5MB): read the total from it, base64 the file and
  include as `{"data": "<base64>", "file_name": "...", "content_type": "..."}`.
  **Every expense whose email has a PDF must carry it as the attachment.**
- HTML-body-only receipt: create the expense without an attachment (the email body
  is the receipt) and note it in the ledger.
- Unsupported type or >5MB: treat as no attachment and flag.

## Expense JSON example

```json
{
  "expense": {
    "user": "https://api.freeagent.com/v2/users/123",
    "category": "https://api.freeagent.com/v2/categories/285",
    "dated_on": "2026-06-15",
    "description": "AWS - June compute",
    "gross_value": "-42.50",
    "sales_tax_rate": "20.0",
    "receipt_reference": "<CA+abc123@mail.gmail.com>",
    "attachment": {
      "data": "JVBERi0xLjQ...",
      "file_name": "aws-invoice-june.pdf",
      "content_type": "application/x-pdf"
    }
  }
}
```

For SEK or USD, add `"currency": "SEK"` / `"currency": "USD"` and omit
`sales_tax_rate`.

For a re-billed project expense (see supplier rules), add:

```json
{
  "project": "https://api.freeagent.com/v2/projects/456",
  "rebill_type": "price",
  "rebill_factor": "158"
}
```

`rebill_factor` is the re-bill price in the **project's** currency (kr for a
SEK project). Verify field names against the live API on first use —
if the create call rejects them, stop and report rather than dropping the
re-bill silently.

## Scheduled runs

A scheduled task (a desktop-app routine at fixed times) covers this skill and the
bills skill in **one inbox sweep** against the shared ledger. It runs Steps 0 to 5
of both, acts on rule-covered expense items, and hands every other decision to the
operator.

- **Rule-covered expense items go through.** Post and archive them as in
  [Step 4b](#step-4b-separate-rule-covered-items).
- **Nothing else writes.** No other create, update or delete of an expense or bill,
  and no other archive, move or label. Those need the operator's approval in a live
  session. Bills are always proposed, never posted.
- **Step 0 acts only on rule-covered rows.** Other `## Pending` rows are listed in
  the run's summary, not archived or retried.
- **Write the proposal once.** Name the section
  `## Proposed (run <YYYY-MM-DD HH:MM> — NOT yet posted, awaiting approval)`.
  An email already listed in an earlier, still-open Proposed section (same
  Message-ID) is not listed again. If every candidate is already proposed,
  write nothing.
- **No placeholder amounts.** A receipt whose amount could not be extracted
  goes in a third table, `Needs input`, with the reason, never in the posting
  table.
- **Notify only when there is something to report.** Expenses posted, new
  expense or bill candidates, or a failure (expired token, connector down), are
  worth one notification naming the count, suppliers and amounts. A run that
  found nothing new stays quiet.

The next live run of `/freeagent:expenses` starts at Step 0 as usual and uses
the open Proposed sections as its starting point. It re-checks each email and
the dedup state before showing the gate, because mail and FreeAgent may have
changed since the scheduled run.

## Safety and invariants

- Never post an expense without explicit confirmation (Step 5 gate), unless it
  is rule-covered ([Step 4b](#step-4b-separate-rule-covered-items)). A scheduled run
  stops at that gate: see [Scheduled runs](#scheduled-runs).
- Never archive without explicit approval of the run report (Step 7 gate), unless
  the item is rule-covered — two separate human gates for everything else: one
  before posting, one before mailbox moves.
- Never archive an email whose expense create failed — only successful creates and
  confirmed duplicates get archived.
- Never move mail anywhere except the Archive folder; never delete.
- Always run the `find-expense` dedup check — the mailbox guard alone is insufficient
  because an archive move can fail after a successful create.
- Negative `gross_value` is spend (owed to the claimant); positive is a refund due
  _from_ the claimant. Get the sign right.
- One claimant only (the operator, named in the rules file). Unexpected `whoami`
  result: stop.
- Operator-specific rules live in `~/.config/freeagent/rules.md`, never in this
  file. Missing rules file: nothing is rule-covered, stop at the Step 5 gate.

## Reference

| Item                 | Value                                                             |
| -------------------- | ----------------------------------------------------------------- |
| FreeAgent account    | `https://<subdomain>.freeagent.com` (subdomain in the rules file) |
| API base (prod)      | https://api.freeagent.com                                         |
| Create expense       | `POST /v2/expenses`                                               |
| List recent expenses | `GET /v2/expenses?view=recent`                                    |
| Categories           | `GET /v2/categories`                                              |
| Current user         | `GET /v2/users/me`                                                |
| Token endpoint       | `POST /v2/token_endpoint`                                         |
