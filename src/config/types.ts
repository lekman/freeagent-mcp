/** One billable engagement: label to the URIs a timeslip needs. */
export interface ClientMapping {
  /** FreeAgent project URI. */
  project: string;
  /** FreeAgent task URI. Required by the API; there is no default. */
  task: string;
}

/** Operator configuration, read from outside the repo. */
export interface FinanceConfig {
  /** Client label (as typed by the operator) to its URIs. */
  clients: Record<string, ClientMapping>;
  /** Dates that are never worked, YYYY-MM-DD. */
  holidays: string[];
  /** The FreeAgent user timeslips are written against. */
  user: string;
  /** Weekdays worked, 1 = Monday … 7 = Sunday. */
  workingDays: number[];
}
