# freeagent

Claude Code plugin for FreeAgent accounting, one skill per domain. Expenses
(receipt import from the Outlook inbox) exists today; invoices, bills, timesheets
and bank reconciliation follow. This repo is also its own marketplace
(`/plugin marketplace add lekman/freeagent-mcp`).

**Public repo, public package.** Nothing committed or shipped may carry a
client name, supplier, project URI, account subdomain, address or real amount.
The operator's own rules (supplier treatments, tenants, the account URL) live
in `~/.config/freeagent/rules.md`, which the skills read at run time and which
is never committed. Examples use placeholders: Acme, Globex,
`acme.freeagent.com`.

## Layout

The repository follows the plugin layout of lekman/ai-toolkit: the catalog at
the root, each plugin under `plugins/`, and the TypeScript package at the root.

| Path                                                     | Purpose                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.claude-plugin/marketplace.json`                        | The catalog: one entry per plugin, with source, description, category and tags                                                                   |
| `plugins/freeagent/.claude-plugin/plugin.json`           | Plugin manifest. Release Please sets its `version` together with `package.json`                                                                  |
| `plugins/freeagent/.mcp.json`                            | Starts the MCP server from the published package: `npx -y @lekman/freeagent@latest mcp`                                                          |
| `plugins/freeagent/skills/<domain>/SKILL.md`             | One skill per domain (`bootstrap`, `expenses`, `bills`, `timesheets`), resolving as `freeagent:<domain>`                                         |
| `plugins/freeagent/skills/expenses/scripts/freeagent.py` | Stdlib-only Python FreeAgent helper for expenses and bills; being ported to the TypeScript package and the MCP server                            |
| `plugins/freeagent/skills/expenses/scripts/outlook.py`   | Stdlib-only Microsoft Graph helper, the mailbox **write** path (archive and label). The Microsoft 365 connector stays the read path              |
| `src/`                                                   | The `@lekman/freeagent` package: the API client, readers and writers                                                                             |
| `src/mcp/`                                               | The MCP server: a thin layer over the same writers the CLI uses. `freeagent mcp` serves it on stdio                                              |
| `src/bin/freeagent.ts`                                   | The `freeagent` CLI: `timesheets show/plan/apply/describe` and `mcp`                                                                             |
| `scripts/check-no-client-content.sh`                     | The client-term check shared with lekman/ai-toolkit                                                                                              |
| `.mise.toml`                                             | Toolchain for contributors (`mise install`). Node comes from `.node-version`, bun from `package.json` `packageManager`, the same sources CI uses |

**The MCP server is the standard interface.** A new operation goes into the
package first, then into `src/mcp/tools.ts` as a tool with the same rules as
its CLI command (read-only tools marked `readOnlyHint`, writes only after a
plan the user approved), and the skill calls the tool. The CLI stays for
scripts and for debugging.

New skills go in `plugins/freeagent/skills/<domain>/`. The directory name is
the skill name; it never repeats the plugin name.

## Invariants (do not weaken)

- **Two human gates**: user approval before posting expenses (Step 5) and again
  before archiving emails (Step 7). Never collapse them into one. The only
  exception is a rule-covered item (Step 4b), approved in advance by the operator
  on 2026-11-05. Widen that definition only on the operator's instruction.
- **Mail is filed, never deleted**: archive moves only, to the Archive folder.
- **Credentials live in `~/.config/freeagent/.env`**, never in this repo or the
  installed plugin directory (replaced on update). Token cache:
  `~/.config/freeagent/token.json`.
- **The ledger (`.tmp/freeagent-expenses.md`) is never committed** — the skill
  verifies `.tmp/` is gitignored before writing it. The filename kept its old
  spelling through the v2 rename on purpose: renaming it would orphan the
  existing ledger in every working directory the skill has ever run in.
- `gross_value` is **negative for spend**. GBP default; SEK explicit; any other
  currency is flagged, not guessed.

## Scripts

| Command                 | Does                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bun run fmt`           | Auto-fix: prettier writes, then `eslint --fix`. Run this before `lint` rather than fixing findings by hand |
| `bun run lint`          | `prettier --check` then `eslint` — read-only, what CI runs                                                 |
| `bun run typecheck`     | `tsc --noEmit`                                                                                             |
| `bun test`              | Tests, no coverage                                                                                         |
| `bun run test:coverage` | Tests with coverage, enforcing the floors in `bunfig.toml`                                                 |
| `bun run build`         | Bundle `dist/index.js` for Node                                                                            |
| `bun run check`         | All of the above in order — the pre-push gate                                                              |

`coverageThreshold` in `bunfig.toml` has two traps, both found by experiment:
the keys are **plural** (`lines`, `functions`; the singular forms parse and are
silently ignored), and it applies **per file**, not to the total. Verify any
change to it by setting the floor one point too high and confirming the run
fails — a threshold that enforces nothing is worse than none.

`perfectionist/sort-classes` keeps class members alphabetical, so a new method
lands in the same place every time. `bun run fmt` sorts them for you.

## Commit messages

**Never name a client, supplier or account in a commit message.** Describe the
shape of the change instead:

```text
bad   fix(expenses): stop importing Acme Ltd invoices
good  fix(expenses): stop importing invoices billed to another tenant
```

The same rule covers file content and commit messages. Messages travel further — pull request titles, notifications, release notes, a
`git log` pasted into an issue — and they are the one thing a later cleanup
cannot fix quietly: redacting a file is a commit, redacting a message is a
history rewrite. Release Please also builds `CHANGELOG.md` out of them.

`scripts/check-no-client-content.sh` is the same check as in lekman/ai-toolkit.
Terms live in the gitignored `scripts/client-terms.txt` (start from
`scripts/client-terms.example.txt`). Enforced in two places, because either
alone is skippable:

- **Locally**, `pre-commit` (staged content) and `commit-msg` hooks in
  `.githooks/`. Enable them once per clone with
  `git config core.hooksPath .githooks`. They can be bypassed with
  `--no-verify`, which is why CI exists.
- **In CI**, on every push and pull request (`client-content.yml`): every blob
  in history and every commit message. CI reads the list from the
  `CLIENT_TERMS` repository secret; a missing secret **fails the job** rather
  than skipping, since a scan that passes for want of anything to match on is
  the worst possible green. The npm tarball check reads the same secret.

CI runs the scan with `--quiet`, printing failing SHAs and nothing else. A log
that names the matched term defeats the check that found it, and GitHub masks a
registered secret value but not another capitalisation of it.

Audit locally with `bash scripts/check-no-client-content.sh --history` and
`--messages`, which print the term and where it is, because your machine
already has the list.

## Releasing

Release Please owns versioning. Conventional commits on `main` maintain a
release pull request; merging it writes the changelog, tags, and publishes the
GitHub release, which is what fires `publish.yml` and the npm publish. Nothing
reaches npm without that merge.

One version covers both artefacts: `.github/release-config.json` bumps
`package.json` and `plugins/freeagent/.claude-plugin/plugin.json` together. They were 0.1.0 and
2.2.0 respectively before this was set up and were unified at **2.2.0** — the
plugin has real install history to preserve, the npm package had never been
published.

**Never add `CHANGELOG.md` to package.json `files`.** The package ships code
and its documentation, not project history. `scripts/check-tarball.sh` refuses
it structurally.

## Development notes

- Commands reference the skill rather than duplicating workflow text — edit
  SKILL.md, not the command files, when changing run behavior.
- **A `SKILL.md` edit is a behaviour change, not documentation.** The skills are
  what this plugin ships, so commit them as `fix:` or `feat:`, never `docs:`.
  Release Please cuts a version only for `feat`, `fix` and breaking changes: a
  `docs:` commit renders in the changelog but releases nothing, so the edit stays
  on `main` and never reaches an installed plugin. Two skill fixes stranded that
  way before this was written down (the telephony and insurance category rows).
  Keep `docs:` for README, CLAUDE.md and code comments.
- Env-pattern files (`.env*`) are blocked from read/write by local permission
  settings; document config in README's variable table instead of an example file.
- Test API changes against the FreeAgent sandbox
  (`FREEAGENT_BASE_URL=https://api.sandbox.freeagent.com`).
- `python3 -m py_compile plugins/freeagent/skills/expenses/scripts/freeagent.py` before
  committing script changes (then delete the `__pycache__`).
- Conventional commits, with no client, supplier or account named in the
  message (see above).
