---
name: bills
description: |
  Records supplier invoices in FreeAgent as bills — money the company owes out, not
  out-of-pocket spend. Reads the invoice email, matches it to a supplier rule, and
  writes only after showing the row and getting a yes.
  Triggers: "record my bills", "import the invoice", "log the accountant's invoice",
  "supplier invoice", "have I recorded this month's bill", "FreeAgent bills".
---

# FreeAgent Bills

A **bill** is an invoice a supplier sent the company: the company owes them. An
**expense** is money the claimant paid personally and the company owes back. They
are different objects, and the difference is not cosmetic — see the table below
before touching anything.

Same two-gate shape as `/freeagent:expenses`: a read-only pass first, then one
approval before writing to FreeAgent, then a separate approval before the mailbox
moves. Nothing is created or archived without an explicit yes each time.

## Bills Are Not Expenses

|               | Expense                          | **Bill**                             |
| ------------- | -------------------------------- | ------------------------------------ |
| Endpoint      | `POST /v2/expenses`              | **`POST /v2/bills`**                 |
| Whose money   | claimant's, reimbursed           | **the company's, owed out**          |
| Keyed on      | `user` (the claimant)            | **`contact` (the supplier)**         |
| Sign of value | **negative** (`-42.50`)          | **positive** (`165.00`)              |
| Dedup key     | `receipt_reference` (Message-ID) | **`reference`** (the invoice number) |
| Archive label | `Receipts`                       | **no label**                         |

The last row matters more than it looks. `Receipts` is the expense flow's marker;
putting it on a bill email misdescribes the record and makes a later sweep treat it
as an imported expense. _(Established on a subcontractor bill.)_

Getting the sign wrong is the expensive one: a negative bill is a credit note.

## Prerequisites

Identical to `/freeagent:expenses` — the Microsoft 365 connector for reading, the
Graph helper for mailbox writes, `~/.config/freeagent/.env` for credentials. If
`whoami` fails, stop and direct the user to `/freeagent:bootstrap`.

**The MCP server has no bill tools yet.** The package's bill reader is read-only
(`list`, `openOrOverdue`, `withEvidence`). Until bills move into the MCP server,
creates go through the Python helper:

```python
import sys; sys.path.insert(0, "<skill-dir>/../expenses/scripts")
import freeagent
freeagent.api("POST", "/v2/bills", {"bill": {...}})
```

## Step 0: Reconcile the Ledger

Shared with the expenses flow: `~/.config/freeagent/freeagent-expenses.md`. Bill rows
live under the same `## Pending` / `## History` headings, marked `type: bill`, because
one mailbox sweep surfaces both and splitting the ledger would hide half the state.
Deal with any `## Pending` rows before looking at new mail.

## Step 1: Inventory

Search the inbox. A bill is an invoice **addressed to the company** with an amount, a
due date and an invoice number. Capture sender, subject, received date, body,
attachment presence, the invoice number, and the connector's message `id`.

**Watch the relay.** Invoices often arrive from the supplier's accounting platform,
not the supplier's own domain — for example a Xero relay
(`messaging-service@post.xero.com`) or Visma (`mail@eaccounting.vismaonline.com`).
Each supplier's relay is in the rules file. Match on the **subject and body**, never
on the sending domain alone.

If there are no candidates, say so and stop.

## Step 2: Resolve Context

```bash
python3 "<expenses-scripts>/freeagent.py" whoami       # sanity: expected user
python3 "<expenses-scripts>/freeagent.py" categories   # category URLs
python3 "<expenses-scripts>/outlook.py"   whoami       # Graph write path
```

Plus the supplier's **contact URL**, which bills require and expenses do not:

```python
freeagent.api("GET", "/v2/contacts?per_page=100")   # match organisation_name
```

**A supplier with no contact record halts the run.** Do not create a contact to get
past the gate: a duplicate contact splits a supplier's history in two and is tedious
to merge. Report it and let the operator create it.

**Read the operator's rules file** at `~/.config/freeagent/rules.md`. Its bills
section holds the supplier table for Step 3 (with contact ids and categories), the
addresses each supplier sends correspondence from, and the FreeAgent subdomain for
the dashboard links in Step 7. It sits outside the plugin and outside every
repository, because it names suppliers.

If the file is missing, treat every supplier as unknown: run the read-only pass,
then stop at the Step 5 gate and say that the rules file is missing. Never fill in a
supplier rule from memory.

## Step 3: Classify Against the Supplier Rules

The operator's supplier table is in the rules file. It uses these columns; the rows
below are made up and show the shape:

| Supplier                     | Arrives as                                   | Recognise by                                                    | Contact   | Category                    | Notes                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------- | --------------------------------------------------------------- | --------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Example Accounting Ltd**   | Xero relay `messaging-service@post.xero.com` | subject `<Month> Invoice INV-##### from Example Accounting Ltd` | `1234567` | **292 Accountancy Fees**    | Monthly, due the following month, £127.00 gross with **`manual_sales_tax_amount` `19.00`** (net 108.00; the filing-fee line is zero-rated). `reference` = the `INV-#####` from the subject. PDF attached |
| **Example Subcontractor AB** | Visma `mail@eaccounting.vismaonline.com`     | invoice number in subject/body                                  | look up   | **150 Subcontractor Costs** | Quarterly, SEK.                                                                                                                                                                                          |

**Not bills, from the same suppliers.** An accountant often sends payslips,
VAT-return approvals and filing confirmations from a personal address, while the
invoices come through the relay. Those are documents, not invoices — never import
them. The split is by sending address and is reliable: relay = bill, the
accountant's own domain = correspondence. The rules file names the addresses for
each supplier.

A supplier not in the table: **stop at the Step 5 gate and ask.** Never guess a
category or a contact. On approval, add the row to the bills supplier table in
`~/.config/freeagent/rules.md` in the same session — a rule discovered and not
written down is a rule that has to be rediscovered.

**Payment evidence is not a bill.** A Wise or bank transfer email confirming money
reached the supplier records a _payment_, not an invoice. Note it at the gate so the
operator can see the bill is settled, but never create a bill from one.

**VAT — set the amount, not the rate.** A supplier invoice that mixes rated and
zero-rated lines cannot be reproduced by one percentage. For example, an
accountant's £127.00 invoice is net £108.00 + VAT £19.00 because a £13.00 filing
fee is 0% while the service lines are 20%, and a flat 20% on the gross computes
£21.17 — £2.17 adrift of the document. Put the figure printed on the invoice into
**`manual_sales_tax_amount`** on the line item and omit `sales_tax_rate`:

```python
"bill_items": [{ ..., "total_value": "127.00", "manual_sales_tax_amount": "19.00" }]
```

`total_value` stays **gross**; FreeAgent derives `total_value_ex_tax` and stores
`sales_tax_value` as the amount given. Earlier bills from a mixed-rate supplier are
normally stored this way; check them to confirm.
Fall back to `sales_tax_rate` only when the invoice genuinely is a single rate on
the whole amount, and to `"0"` when it carries no VAT.

**Check every new bill for this.** Read the invoice's own VAT total before
building the payload — a supplier whose lines are all one rate today can add a
zero-rated line tomorrow, and the rate would silently stop matching. If the
computed VAT and the printed VAT disagree, the printed one wins.
_(Lesson from a real case: a bill was once created at rate 0 and lost its VAT,
which could not then be corrected — see the third trap in Step 6.)_

## Step 4: Deduplicate on the Invoice Number

The invoice number is the natural key — stable, printed on the document, and unique
per supplier. Fetch the supplier's bills and compare:

```python
bills = freeagent.api("GET", "/v2/bills?per_page=100")   # paginate
```

- `reference` already present for that contact → already recorded. Mark `duplicate`
  so the email is archived and stops resurfacing, and create nothing.
- Same supplier, same amount, within ±7 days, **different** reference → flag at the
  gate. Never auto-create: two invoices a week apart at the same amount is either a
  genuine second invoice or a re-send, and only the operator knows which.
- A recurring supplier missing a month → say so. A gap in a monthly series is worth
  reporting even when this run cannot fill it.

## Step 5: Confirm

Write the run into the ledger as a `## Proposed` section, then present:

| # | Dated | Due | Supplier | Reference | Amount | Cur | Category | Attachment | Note |

Plus the **no-import** table with a reason per excluded email — payslips, payment
confirmations, duplicates. Do not create before an explicit yes.

## Step 6: Create

```python
freeagent.api("POST", "/v2/bills", {"bill": {
    "contact":   "https://api.freeagent.com/v2/contacts/1234567",
    "dated_on":  "2026-08-24",
    "due_on":    "2026-09-08",
    "reference": "INV-10001",
    "bill_items": [{                       # value and category live HERE
        "category":       "https://api.freeagent.com/v2/categories/292",
        "description":    "Accountancy services — August 2026",
        "total_value":    "127.00",        # positive
        "sales_tax_rate": "0",
    }],
}})
```

**`total_value` and `category` belong on the line item, not on the bill.** Sent at the
top level they are **silently ignored** — no error, no warning; the bill is created
with `total_value: 0.0`, `category: null` and `status: "Zero Value"`. Proven live
2026-08-25: the first probe produced exactly that and had to be deleted. This is why
the probe exists, and why reading the bill back is not optional.

Add `"currency": "SEK"` for non-GBP. Attach the PDF exactly as the expenses skill
does — base64, `application/x-pdf`, ≤5MB.

**Probe first.** Create **one**, `GET` it back, confirm `contact`, `reference`,
`total_value`, `due_on`, the VAT and the attachment all stored, and only then run
any remainder.

### Updating an existing bill — three traps, all proven live 2026-09-28

1. **Every `bill_items` entry must carry its `url`**, or the call fails with
   `422 Each item in bill_items must contain a url key`. The url comes from the
   GET: `https://api.freeagent.com/v2/bill_items/<id>`.
2. **A rejected `PUT` still strips the attachment.** Observed twice on one
   bill: both 422s left every other field untouched but removed the PDF, and
   the `attachment` key vanished from the GET entirely. **Download the existing
   attachment from `content_src` before any bill PUT** and be ready to re-send it;
   treat every PUT, successful or not, as attachment-destroying.
3. **VAT locks once a bill has payments.** `manual_sales_tax_amount` and
   `sales_tax_rate` both appear in `locked_attributes`, and a PUT returns
   `422 ... is locked and cannot be changed`. The VAT on a paid bill cannot be
   corrected through the API at all — it is an adjustment on the next return,
   which is the accountant's call, not this skill's.

## Step 7: Ledger and Hand Over

Append rows with `type: bill` and the FreeAgent **dashboard** URL
(`https://<subdomain>.freeagent.com/bills/<id>`, subdomain from the rules file).
Then stop: ask the operator to open the
bills and compare them against the emails. This is the second gate.

## Step 8: Archive on Approval

```bash
python3 "<expenses-scripts>/outlook.py" archive <ID>...
```

**No `--label Receipts`.** Move the row to `## History`, then summarise: bills
created with links and amounts, emails archived, anything skipped and why, totals per
currency, and anything left in `## Pending`.

## Scheduled Runs

A scheduled task covers bills and expenses in one inbox sweep, Steps 0 to 5
of both skills. Bills stay read-only in that sweep: it never creates a bill or
archives a bill's email. The rules live in one place, the expenses skill's
[Scheduled runs](../expenses/SKILL.md#scheduled-runs) section, because the two
skills share the ledger.

## Safety and Invariants

- Never create without the Step 5 gate; never archive without the Step 7 gate.
- **Positive `total_value`.** Negative is a credit note.
- Never archive an email whose create failed.
- Never invent a contact or a category — halt and ask.
- Operator-specific supplier rules live in `~/.config/freeagent/rules.md`, never in
  this file. Missing rules file: every supplier is unknown, stop at the Step 5 gate.
- Never label a bill email `Receipts`.
- Dedup on `reference` every run: the mailbox alone is not sufficient, because an
  archive move can fail after a successful create.
