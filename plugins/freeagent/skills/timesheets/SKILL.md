---
name: timesheets
description: |
  Records billable hours in FreeAgent as timeslips, and reports what is already logged.
  Spreads a weekly total across working days, reconciles against what FreeAgent already
  holds, and writes only after showing the grid and getting a yes.
  Triggers: "log my time", "log 40 hours for X this week", "timesheets", "have I done
  my timesheets", "book hours", "fill in my time".
---

# FreeAgent Timesheets

Turns "40 hours each for Acme and Globex this week" into timeslips, and answers
"are my timesheets done?" without a script.

The judgement — which week, which clients, how many hours — is Claude's. The API
work is the plugin's `freeagent` MCP server, which is deterministic and refuses
rather than guesses. Its tools are `timesheets_show`, `timesheets_plan`,
`timesheets_apply` and `timesheets_describe`.
**Nothing is written without the grid being shown and approved.**

## Prerequisites

- Config at `~/.config/freeagent/finance.json` mapping each client label to its
  FreeAgent **project and task URIs**, plus the claimant `user` URI. `POST /v2/timeslips`
  requires `task` and there is no default — an unmapped client is an error, never a
  guess. If the file is missing, the tool says so and names the path; do not invent one.
- Credentials at `~/.config/freeagent/.env`, as for the expenses skill. The MCP
  server reads that file itself. If a call fails on auth, stop and direct the
  user to `/freeagent:bootstrap`.
- The plugin starts the server with `npx -y @lekman/freeagent@latest mcp`. If
  the `timesheets_*` tools are missing, the server did not start: say so, and
  do not fall back to writing timeslips any other way.

---

## Step 1: Settle the dates before anything else

**Never infer the week silently.** "This week" is ambiguous, and on a Sunday it is
genuinely undecidable — the week that is ending and the week that is starting are both
defensible readings. Getting it wrong either double-logs a finished week or books hours
against the wrong one, and both end up on an invoice.

Resolve to an explicit **Monday–Friday range**, state it back, and only continue once
the user has seen it:

> Logging Mon 17 – Fri 21 August 2026. Correct?

Skip the confirmation only when the user named explicit dates themselves.

## Step 2: Show what is already recorded

Call `timesheets_show` with `{"from": "2026-08-17", "to": "2026-08-21"}`.

This answers "are my timesheets done?" on its own. If the week is already complete,
say so and stop — there is nothing to add, and proposing a write would invite an
approval that does nothing.

## Step 3: Plan, and show the grid

Call `timesheets_plan` with
`{"from": "2026-08-17", "to": "2026-08-21", "hours": {"Acme": 40, "Globex": 40}}`.

It writes nothing. Present its output as a table — days down, clients across —
along with the four lists it returns:

| Field            | Means                                                     |
| ---------------- | --------------------------------------------------------- |
| `toCreate`       | New timeslips that would be written                       |
| `alreadyPresent` | Days that match what is recorded; skipped, not duplicated |
| `conflicts`      | A recorded day whose hours differ from the plan           |
| `skipped`        | Non-working days: weekends, and holidays from config      |

**Conflicts stop the run.** A recorded day that disagrees with the plan is reported and
left alone — never overwritten. Someone corrected that day deliberately, or the request
is wrong; either way it is not a decision to make silently. Show the conflict, ask, and
let the user fix it in FreeAgent or restate the request.

## Step 3b: Describe each day

**Every timeslip needs a short description of what was done that day.** A
timesheet is not finished without one. These descriptions are what
reporting systems downstream (an agency portal, a consultancy's time
system) copy, so they are written here first and nowhere else.

Build them from evidence, not from memory:

- Merged and opened pull requests by day (`gh search prs --author @me --created D..D`).
- The task database log for the client, if one exists.
- Other agent sessions working for that client: ask each for one line per
  day with the PRs or tickets behind it.
- Meeting titles from the calendar or the meeting recorder.

One sentence per client per day, under about 250 characters: ticket keys
and PR numbers, semicolons between items, no names of people outside the
team. When a day has little evidence, say so in the grid instead of
padding the description, and let the user decide.

Keep them as a list, one entry per client and day, for `timesheets_describe`:

```json
[
  {
    "date": "2026-08-17",
    "client": "Acme",
    "comment": "Release 1.0.0 to production; KPI page fixes (#345)"
  }
]
```

## Step 4: The gate

Show the grid, the totals and each day's description. Get an explicit yes. Do not treat "log 40 hours for this
week" as the approval — that is the _request_; the approval is the user seeing the dates
and the numbers that request turned into.

## Step 5: Apply

Call `timesheets_apply` with the same `from`, `to` and `hours` the user approved.

It re-plans before writing, so it writes only what is still missing. Calling it
twice is safe: the second call reports `created: 0`. It returns an error with the
conflicts, and writes nothing, rather than writing the non-conflicting part, which
would leave the week half-corrected.

Then write the descriptions. Only the comment changes; a description
that matches no timeslip, or more than one, stops the run before anything
is written:

Call `timesheets_describe` with `{"descriptions": [...]}`, the list from Step 3b.

The same tool backfills descriptions on timeslips logged earlier.

## Step 6: Verify by reading back

Call `timesheets_show` again for the range. Its `undescribed` list holds every
timeslip without a description. Do not report the week as done, and do not
mirror it to another system, until that list is empty.

Confirm the count and the totals from FreeAgent, not from the create call's output.
Report what is now recorded, not what was requested.

---

## How hours are spread

Evenly across working days, with any remainder on the earliest days, to two decimals:
40 over 5 days is 8.00 each; 37.5 over 5 is 7.50 each; 40 over 3 is 13.34, 13.33, 13.33.
**The parts always sum to the whole** — these hours are billed, so a rounding leak is a
billing error.

Working days and holidays come from config (`workingDays`, `holidays`). A holiday inside
the window is skipped and its hours land on the remaining days, so 40h over a four-day
week is 10h a day, not 8h and a missing Friday.

## Weekend and holiday work

The tools spread hours only over `workingDays`, and take no override — a
weekend-only range fails with `no working days between D and D`. To log a
Saturday or a holiday, widen `workingDays` in `~/.config/freeagent/finance.json`
for the one run and restore it **in the same shell command**, so it is never
left widened across a wait. An MCP call cannot share a command with the restore,
so this one case uses the same package's CLI:

```bash
cfg=~/.config/freeagent/finance.json; cp "$cfg" "$cfg.bak"
python3 -c "import json,sys;d=json.load(open('$cfg'));d['workingDays']=[1,2,3,4,5,6];json.dump(d,open('$cfg','w'),indent=2)"
set -a; source ~/.config/freeagent/.env; set +a
npx -y @lekman/freeagent@latest timesheets apply --from 2026-08-22 --to 2026-08-22 --hours "Acme=2"
cp "$cfg.bak" "$cfg" && rm "$cfg.bak"
```

Leaving `workingDays` widened turns every later "log 40 hours this week" into a
six-day spread — a billing error that looks correct. Weekdays are ISO: Monday 1,
Saturday 6, Sunday 7. Ask which date the hours should carry before doing this:
weekend work is a real choice between the day it happened and the next working
day.

## Uneven weeks

The tools take one total per client per range. For a week that is not uniform — three
days on one client, two on another — call them per sub-range:

- `timesheets_apply` with `{"from": "2026-08-17", "to": "2026-08-19", "hours": {"Acme": 24}}`
- `timesheets_apply` with `{"from": "2026-08-20", "to": "2026-08-21", "hours": {"Globex": 16}}`

Do not try to express it as one call; a total spread over a range it does not belong to
is a wrong timesheet that looks right.

## Invariants (do not weaken)

- **Never write without showing the grid first.** The request is not the approval.
- **Never overwrite a recorded day.** Conflicts are reported and left alone.
- **Never guess a client.** An unmapped label halts before any network call. There is
  no fallback project and no fuzzy matching.
- **Never infer the week in silence.** State the resolved dates and confirm.
- **Verify by reading back**, not from the write call's return value.
- **Never finish without descriptions.** Every timeslip carries a
  description of the day's work before the week is reported as done.
