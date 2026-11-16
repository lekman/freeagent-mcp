#!/usr/bin/env node
/**
 * FreeAgent CLI — the deterministic surface the skills call.
 *
 * Claude decides *what* to record; this decides *how*, so the judgement and
 * the API calls stay separable and the API half is testable on its own.
 *
 *   freeagent timesheets show  --from D --to D
 *   freeagent timesheets plan  --from D --to D --hours "Acme=40,Globex=40"
 *   freeagent timesheets apply --from D --to D --hours "Acme=40,Globex=40"
 *   freeagent timesheets describe --input-file descriptions.json
 *   freeagent timesheets show --from D --to D --require-descriptions
 *   freeagent mcp      the same timesheet commands as MCP tools, on stdio
 *
 * `plan` never writes. `apply` re-plans first and writes only what is still
 * missing, so running it twice is safe and running it after a manual edit
 * reports a conflict rather than overwriting one.
 *
 * Add --json for machine-readable output.
 */

import { readFileSync } from "node:fs";

import type { SlipDescription, TimesheetPlan } from "../timesheets/index.ts";

import { ClientFactory } from "../client/index.ts";
import { ConfigStore } from "../config/index.ts";
import { serveStdio } from "../mcp/index.ts";
import { TimesheetWriter } from "../timesheets/index.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const die = (message: string): never => {
  console.error(`error: ${message}`);
  process.exit(2);
};

/** Parse `"Acme=40,Globex=20"` into client/hours pairs. */
const parseHours = (raw: string): [string, number][] =>
  raw.split(",").map((part) => {
    const [client, hours] = part.split("=");
    const value = Number(hours);
    if (!client || !Number.isFinite(value) || value <= 0) {
      throw new Error(`bad --hours entry "${part}" — expected Client=Hours`);
    }
    return [client.trim(), value];
  });

/** Human-readable grid; the thing an operator approves before a write. */
const render = (plan: TimesheetPlan, from: string, to: string): void => {
  console.log(`\nPLAN  ${from} .. ${to}\n`);
  const days = [...new Set(plan.toCreate.map((s) => s.dated_on))].sort();
  for (const day of days) {
    const row = plan.toCreate.filter((s) => s.dated_on === day);
    console.log(
      `  ${day}  ${row.map((s) => `${s.client} ${s.hours}h`).join("   ")}`,
    );
  }
  if (days.length === 0) console.log("  (nothing to create)");
  console.log(`\n  totals:          ${JSON.stringify(plan.totals)}`);
  console.log(`  to create:       ${plan.toCreate.length}`);
  console.log(`  already present: ${plan.alreadyPresent.length}`);
  console.log(`  conflicts:       ${plan.conflicts.length}`);
  console.log(
    `  skipped:         ${plan.skipped.map((s) => `${s.date} (${s.reason})`).join(", ") || "none"}`,
  );
  for (const c of plan.conflicts) {
    console.log(
      `  CONFLICT ${c.planned.dated_on}: recorded ${c.existing.hours}h, plan says ${c.planned.hours}h — left alone`,
    );
  }
};

const main = async (): Promise<void> => {
  const [domain, action] = argv;
  if (domain === "mcp") {
    // package.json sits two levels up from both src/bin and dist/bin.
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    await serveStdio(pkg.version);
    return;
  }
  if (domain !== "timesheets")
    die("usage: freeagent timesheets <show|plan|apply|describe> …");

  if (action === "describe") {
    const file =
      flag("input-file") ??
      die("--input-file is required: [{date, client, comment}, …]");
    const rows = JSON.parse(readFileSync(file, "utf8")) as SlipDescription[];
    if (!Array.isArray(rows)) die("the input file must hold a JSON list");
    const writer = new TimesheetWriter(
      ClientFactory.fromEnvironment(),
      ConfigStore.load(),
    );
    const updated = await writer.describe(rows);
    console.log(`described ${updated.length} timeslip(s)`);
    return;
  }

  const from = flag("from") ?? die("--from is required (YYYY-MM-DD)");
  const to = flag("to") ?? die("--to is required (YYYY-MM-DD)");
  const writer = new TimesheetWriter(
    ClientFactory.fromEnvironment(),
    ConfigStore.load(),
  );

  if (action === "show") {
    const slips = await writer.list(from, to);
    if (has("json")) console.log(JSON.stringify(slips, null, 2));
    else {
      for (const s of slips)
        console.log(
          `  ${s.dated_on}  ${s.hours}h  ${s.project}  ${s.comment ?? "(no description)"}`,
        );
      console.log(`  ${slips.length} timeslips`);
    }
    // A timesheet is complete only when every day says what was done.
    const missing = TimesheetWriter.undescribed(slips);
    if (has("require-descriptions") && missing.length > 0) {
      for (const s of missing)
        console.error(`  no description: ${s.dated_on}  ${s.project}`);
      console.error(`error: ${missing.length} timeslip(s) have no description`);
      process.exit(3);
    }
    return;
  }

  if (action !== "plan" && action !== "apply") {
    die("usage: freeagent timesheets <show|plan|apply|describe> …");
  }

  const pairs = parseHours(
    flag("hours") ?? die('--hours is required, e.g. "Acme=40,Globex=20"'),
  );
  const plans: TimesheetPlan[] = [];
  for (const [client, hours] of pairs) {
    plans.push(await writer.plan(client, from, to, hours));
  }
  const merged = TimesheetWriter.merge(plans);

  if (action === "plan") {
    if (has("json")) console.log(JSON.stringify(merged, null, 2));
    else render(merged, from, to);
    return;
  }

  // A conflict means the recorded week and the requested week disagree.
  // Writing the non-conflicting part would leave the week half-corrected and
  // half-not, which is harder to reason about than refusing outright.
  if (merged.conflicts.length > 0) {
    render(merged, from, to);
    die(
      `${merged.conflicts.length} conflict(s) — resolve in FreeAgent, then re-run`,
    );
  }

  let created = 0;
  for (const plan of plans) created += (await writer.apply(plan)).length;
  console.log(`created ${created} timeslip(s)`);
  if (created === 0) console.log("(already logged — nothing to do)");
};

main().catch((error: unknown) => {
  console.error(`error: ${(error as Error).message}`);
  process.exit(1);
});
