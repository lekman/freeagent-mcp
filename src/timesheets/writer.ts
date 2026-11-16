import type { IFreeAgentClient } from "../client/index.ts";
import type { FinanceConfig } from "../config/index.ts";
import type { SlipDescription, TimesheetPlan, Timeslip } from "./types.ts";

import { Config } from "../config/index.ts";
import { Paging } from "../paging/index.ts";
import { Timesheets } from "./timesheets.ts";

const PER_PAGE = 100;

/**
 * Reads and writes timeslips.
 *
 * The only write path in the toolkit that touches billable hours, so it is
 * built to refuse rather than guess: the project and task come from config
 * and never from a name match, the range is read before anything is written,
 * and `apply` will not run on a plan it did not produce.
 */
export class TimesheetWriter {
  private readonly client: IFreeAgentClient;
  private readonly config: FinanceConfig;

  constructor(client: IFreeAgentClient, config: FinanceConfig) {
    this.client = client;
    this.config = config;
  }

  /** Merge several single-client plans into one grid for confirmation. */
  static merge(plans: TimesheetPlan[]): TimesheetPlan {
    const merged: TimesheetPlan = {
      alreadyPresent: [],
      conflicts: [],
      skipped: [],
      toCreate: [],
      totals: {},
    };
    for (const plan of plans) {
      merged.alreadyPresent.push(...plan.alreadyPresent);
      merged.conflicts.push(...plan.conflicts);
      merged.toCreate.push(...plan.toCreate);
      for (const [k, v] of Object.entries(plan.totals)) {
        merged.totals[k] = (merged.totals[k] ?? 0) + v;
      }
      for (const s of plan.skipped) {
        if (!merged.skipped.some((x) => x.date === s.date))
          merged.skipped.push(s);
      }
    }
    merged.skipped.sort((a, b) => a.date.localeCompare(b.date));
    return merged;
  }

  /** Timeslips in a list that have no description. */
  static undescribed(slips: Timeslip[]): Timeslip[] {
    return slips.filter((s) => !(s.comment ?? "").trim());
  }

  /**
   * Create the entries in a plan.
   *
   * Takes a plan rather than a description of one, so what is written is
   * exactly what was shown and approved — there is no second derivation that
   * could differ from the grid the operator saw. Conflicts are never touched.
   */
  async apply(plan: TimesheetPlan): Promise<Timeslip[]> {
    const created: Timeslip[] = [];
    for (const slip of plan.toCreate) {
      const body = await this.client.request<{ timeslip?: Timeslip }>({
        method: "POST",
        path: "/v2/timeslips",
        payload: {
          timeslip: {
            dated_on: slip.dated_on,
            hours: slip.hours.toFixed(2),
            project: slip.project,
            task: slip.task,
            user: this.config.user,
          },
        },
      });
      if (body.timeslip) created.push(body.timeslip);
    }
    return created;
  }

  /**
   * Write each day's description as the comment on its timeslip. Only the
   * comment changes; hours, project and task are never sent. Every
   * description must match exactly one recorded timeslip for that client and
   * day, so the run stops before writing anything when one is missing or
   * ambiguous.
   */
  async describe(descriptions: SlipDescription[]): Promise<Timeslip[]> {
    if (descriptions.length === 0) return [];
    for (const d of descriptions) {
      if (!d.comment.trim())
        throw new Error(`${d.client} ${d.date}: the description is empty`);
    }
    const dates = descriptions.map((d) => d.date).sort();
    const existing = await this.list(dates[0] ?? "", dates.at(-1) ?? "");
    const targets = descriptions.map((d) => {
      const { project } = Config.clientMapping(this.config, d.client);
      const matches = existing.filter(
        (s) => s.dated_on === d.date && s.project === project && s.url,
      );
      if (matches.length !== 1)
        throw new Error(
          `${d.client} ${d.date}: expected one timeslip, found ${matches.length}. Nothing was written`,
        );
      return { comment: d.comment.trim(), url: matches[0]?.url ?? "" };
    });
    const updated: Timeslip[] = [];
    for (const t of targets) {
      const body = await this.client.request<{ timeslip?: Timeslip }>({
        method: "PUT",
        path: new URL(t.url).pathname,
        payload: { timeslip: { comment: t.comment } },
      });
      if (body.timeslip) updated.push(body.timeslip);
    }
    return updated;
  }

  /** Timeslips already recorded in a window. */
  async list(from: string, to: string): Promise<Timeslip[]> {
    return Paging.collect<Timeslip & { url?: string }>(
      async (page) =>
        (
          await this.client.request<{ timeslips?: Timeslip[] }>({
            path: "/v2/timeslips",
            query: { from_date: from, page, per_page: PER_PAGE, to_date: to },
          })
        ).timeslips ?? [],
      PER_PAGE,
    );
  }

  /**
   * Plan one client's week without writing anything. Resolving the client
   * label through config is what makes an unmapped client an error instead of
   * hours on the wrong contract.
   */
  async plan(
    client: string,
    from: string,
    to: string,
    hours: number,
  ): Promise<TimesheetPlan> {
    const mapping = Config.clientMapping(this.config, client);
    const existing = await this.list(from, to);
    return Timesheets.plan(
      this.config,
      client,
      mapping.project,
      mapping.task,
      from,
      to,
      hours,
      existing,
    );
  }
}
