import type { FinanceConfig } from "../config/index.ts";
import type { PlannedSlip, TimesheetPlan, Timeslip } from "./types.ts";

const DAY_MS = 86_400_000;

/**
 * Timesheet planning, all of it pure.
 *
 * A wrong timesheet becomes a wrong invoice, so the rules that decide which
 * day gets which hours live here where they can be tested against fixed
 * inputs rather than inferred from a successful run.
 */
export class Timesheets {
  /** Dates from `from` to `to` inclusive, YYYY-MM-DD. */
  static dateRange(from: string, to: string): string[] {
    const out: string[] = [];
    for (
      let t = Date.parse(`${from}T00:00:00Z`);
      t <= Date.parse(`${to}T00:00:00Z`);
      t += DAY_MS
    ) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  }

  /** ISO weekday, 1 = Monday … 7 = Sunday. */
  static isoWeekday(date: string): number {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return day === 0 ? 7 : day;
  }

  /**
   * Build the plan for one client over a window.
   *
   * Existing entries are read first and reconciled, never assumed absent: a
   * re-run must add nothing rather than double the week. An existing entry
   * with different hours is a **conflict**, reported and left alone — the
   * operator decides, because silently overwriting is how a corrected day
   * gets un-corrected.
   */
  static plan(
    config: FinanceConfig,
    client: string,
    project: string,
    task: string,
    from: string,
    to: string,
    hours: number,
    existing: Timeslip[],
  ): TimesheetPlan {
    const holidays = new Set(config.holidays);
    const working: string[] = [];
    const skipped: TimesheetPlan["skipped"] = [];
    for (const date of Timesheets.dateRange(from, to)) {
      if (holidays.has(date)) skipped.push({ date, reason: "holiday" });
      else if (!config.workingDays.includes(Timesheets.isoWeekday(date)))
        skipped.push({ date, reason: "weekend" });
      else working.push(date);
    }
    if (working.length === 0) {
      throw new Error(
        `no working days between ${from} and ${to} — nothing to spread ${hours}h over`,
      );
    }

    const perDay = Timesheets.spread(hours, working.length);
    const planned: PlannedSlip[] = working.map((dated_on, i) => ({
      client,
      dated_on,
      hours: perDay[i] as number,
      project,
      task,
    }));

    const byDate = new Map<string, Timeslip>();
    for (const slip of existing) {
      if (slip.project === project && slip.dated_on)
        byDate.set(slip.dated_on, slip);
    }

    const alreadyPresent: PlannedSlip[] = [];
    const toCreate: PlannedSlip[] = [];
    const conflicts: TimesheetPlan["conflicts"] = [];
    for (const slip of planned) {
      const found = byDate.get(slip.dated_on);
      if (!found) toCreate.push(slip);
      else if (Math.abs(Number(found.hours ?? 0) - slip.hours) < 0.005)
        alreadyPresent.push(slip);
      else conflicts.push({ existing: found, planned: slip });
    }

    return {
      alreadyPresent,
      conflicts,
      skipped,
      toCreate,
      totals: {
        [client]:
          Math.round(toCreate.reduce((s, p) => s + p.hours, 0) * 100) / 100,
      },
    };
  }

  /**
   * Split hours across days as evenly as two decimal places allow, with any
   * remainder on the earliest days. 40 over 5 is 8.00 each; 37.5 over 5 is
   * 7.50 each; 40 over 3 is 13.34, 13.33, 13.33 — and the total is exact,
   * which matters because these hours are billed.
   */
  static spread(hours: number, days: number): number[] {
    const totalPence = Math.round(hours * 100);
    const base = Math.floor(totalPence / days);
    let remainder = totalPence - base * days;
    return Array.from({ length: days }, () => {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      return (base + extra) / 100;
    });
  }
}
