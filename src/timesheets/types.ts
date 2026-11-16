/** A timeslip as returned by `GET /v2/timeslips`. */
export interface Timeslip {
  /** Optional free-text comment. */
  comment?: string;
  /** Date worked, YYYY-MM-DD. */
  dated_on?: string;
  /** Hours worked, as a decimal string. */
  hours?: string;
  /** Project URI. */
  project?: string;
  /** Task URI. */
  task?: string;
  /** Resource URI. */
  url?: string;
  /** The user the time belongs to. */
  user?: string;
}

/** One day's proposed entry for one client. */
export interface PlannedSlip {
  /** Client label as the operator typed it. */
  client: string;
  /** Date, YYYY-MM-DD. */
  dated_on: string;
  /** Hours to book. */
  hours: number;
  /** Project URI resolved from config. */
  project: string;
  /** Task URI resolved from config. */
  task: string;
}

/** What a run would do, before anything is written. */
export interface TimesheetPlan {
  /** Days in the window that are not worked, with the reason. */
  skipped: { date: string; reason: "weekend" | "holiday" }[];
  /** Entries that already exist and will not be duplicated. */
  alreadyPresent: PlannedSlip[];
  /** Entries that would be created. */
  toCreate: PlannedSlip[];
  /** Existing entries that disagree with the plan — never overwritten. */
  conflicts: { existing: Timeslip; planned: PlannedSlip }[];
  /** Total hours the plan would add, per client. */
  totals: Record<string, number>;
}

/** A description for one client's timeslip on one day. */
export interface SlipDescription {
  /** Client label as configured in finance.json. */
  client: string;
  /** The day's description, written as the timeslip comment. */
  comment: string;
  /** Date, YYYY-MM-DD. */
  date: string;
}
