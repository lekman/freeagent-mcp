# Copilot instructions

`@lekman/freeagent` is a FreeAgent API client: OAuth token lifecycle and typed
reads over invoices, bills, expenses and timeslips. It is published to npm and
also ships as a Claude Code plugin.

## Pull requests to skip

Stop and post no review for pull requests from these branches. They are
machine-generated, their contents are mechanical, and a review comment on them
is noise that trains people to skim the ones that matter.

- `release-please--*` — a version bump and a generated changelog. The content
  is produced from commit messages that were already reviewed when they landed.
- `dependabot/*` — a dependency or action version bump. What matters is whether
  the upgrade builds and passes, which continuous integration answers, not
  whether the diff reads well.

Exit early on those. Everything below applies to human pull requests.

## What to look at closely

- **Money is never a float.** Amounts are handled per currency and are not
  silently converted. Flag any code that sums across currencies or rounds
  before the last step.
- **Payment evidence comes from bank transaction explanations, not from
  `paid_on`.** That field is set by hand and is often wrong. A change that
  trusts it is a defect even when it passes.
- **A balance and a movement are different questions.** An unbounded query
  answers what is owed; a dated one answers what changed. Check which is
  intended.
- **Paging must stop on a stalled cursor.** An API that keeps returning the
  same page should end the loop, not spin.

## What not to comment on

- **Placeholder names (Acme, Globex, Initech, `acme.freeagent.com`) in
  skills, tests and examples.** They are deliberate. The operator's real
  supplier, tenant and account rules live in a private local file the skills
  read at run time, and `scripts/check-no-client-content.sh` blocks real names
  in this public repository.
- **Commit messages naming a counterparty.** A guard already blocks this on
  every commit and in continuous integration.

## Conventions

Clean architecture: `types.ts` for types, `{name}.ts` for business logic as a
static class, `interfaces.ts` for ports, `{domain}.system.ts` for anything
that touches the network or the filesystem, `index.ts` as a barrel. Business
logic never goes in a `*.system.ts` file. Static class members are sorted
alphabetically and every exported symbol carries a doc comment; both are
enforced by lint, so there is no need to say so in a review.
