import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { z } from "zod";

import type { TimesheetPlan } from "../timesheets/index.ts";

import { TimesheetWriter } from "../timesheets/index.ts";

/** How the tools reach FreeAgent. A factory, so a missing credential is a tool error, not a crash at start. */
export interface TimesheetToolDeps {
  writer: () => TimesheetWriter;
}

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("YYYY-MM-DD");
const HOURS = z
  .record(z.string(), z.number().positive())
  .describe('Total hours per configured client label, e.g. {"Acme": 40}');

const text = (value: unknown) => ({
  content: [{ text: JSON.stringify(value, null, 2), type: "text" as const }],
});

async function planAll(
  writer: TimesheetWriter,
  from: string,
  to: string,
  hours: Record<string, number>,
): Promise<{ merged: TimesheetPlan; plans: TimesheetPlan[] }> {
  const plans: TimesheetPlan[] = [];
  for (const [client, total] of Object.entries(hours)) {
    plans.push(await writer.plan(client, from, to, total));
  }
  return { merged: TimesheetWriter.merge(plans), plans };
}

/**
 * The timesheet tools: the same four operations as the `freeagent timesheets`
 * CLI, with the same rules. `plan` and `show` never write; `apply` re-plans and
 * refuses on any conflict; `describe` changes only the comment.
 */
export function registerTimesheetTools(
  server: McpServer,
  deps: TimesheetToolDeps,
): void {
  server.registerTool(
    "timesheets_show",
    {
      annotations: { readOnlyHint: true },
      description:
        "List the timeslips recorded between two dates, with each day's description, and the timeslips that have no description yet.",
      inputSchema: { from: DATE, to: DATE },
    },
    async ({ from, to }) => {
      const slips = await deps.writer().list(from, to);
      return text({
        slips,
        undescribed: TimesheetWriter.undescribed(slips),
      });
    },
  );

  server.registerTool(
    "timesheets_plan",
    {
      annotations: { readOnlyHint: true },
      description:
        "Plan timeslips without writing: spread each client's total over the working days in the range, and report what would be created, what is already present, conflicts, and skipped days. Show this grid to the user before calling timesheets_apply.",
      inputSchema: { from: DATE, hours: HOURS, to: DATE },
    },
    async ({ from, hours, to }) =>
      text((await planAll(deps.writer(), from, to, hours)).merged),
  );

  server.registerTool(
    "timesheets_apply",
    {
      annotations: { destructiveHint: false, readOnlyHint: false },
      description:
        "Create the planned timeslips. Call only after the user approved the grid from timesheets_plan. Re-plans first, writes only what is missing, and writes nothing when any recorded day conflicts.",
      inputSchema: { from: DATE, hours: HOURS, to: DATE },
    },
    async ({ from, hours, to }) => {
      const writer = deps.writer();
      const { merged, plans } = await planAll(writer, from, to, hours);
      if (merged.conflicts.length > 0) {
        return {
          ...text({ conflicts: merged.conflicts, created: 0 }),
          isError: true,
        };
      }
      let created = 0;
      for (const plan of plans) created += (await writer.apply(plan)).length;
      return text({ created });
    },
  );

  server.registerTool(
    "timesheets_describe",
    {
      annotations: { destructiveHint: false, readOnlyHint: false },
      description:
        "Write each day's description as the comment on its timeslip. Only the comment changes. A description that matches no timeslip, or more than one, stops the call before anything is written.",
      inputSchema: {
        descriptions: z
          .array(
            z.object({
              client: z.string().min(1),
              comment: z.string().min(1),
              date: DATE,
            }),
          )
          .min(1),
      },
    },
    async ({ descriptions }) => {
      const updated = await deps.writer().describe(descriptions);
      return text({ described: updated.length });
    },
  );
}
