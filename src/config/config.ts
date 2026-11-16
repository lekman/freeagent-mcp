import type { ClientMapping, FinanceConfig } from "./types.ts";

const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5];

/**
 * Validation for the operator config.
 *
 * It resolves which project and task a timeslip lands on, so a malformed or
 * partial file must stop here rather than surface as hours booked against the
 * wrong contract. There is no fallback project and no fuzzy client matching:
 * an unknown label is an error, not a guess.
 */
export class Config {
  /**
   * The mapping for a client label, or a throw naming what is configured.
   * Matching is exact and case-insensitive — close enough to be usable, not
   * close enough to silently pick a neighbour.
   */
  static clientMapping(config: FinanceConfig, label: string): ClientMapping {
    const wanted = label.trim().toLowerCase();
    for (const [name, mapping] of Object.entries(config.clients)) {
      if (name.trim().toLowerCase() === wanted) return mapping;
    }
    throw new Error(
      `no configuration for client "${label}" — configured: ${Object.keys(config.clients).join(", ") || "(none)"}. Add it to finance.json; there is no default project`,
    );
  }

  /** Validate a parsed config, filling only what has a safe default. */
  static parse(raw: unknown): FinanceConfig {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("finance.json is not an object");
    }
    const candidate = raw as Partial<FinanceConfig>;
    if (typeof candidate.user !== "string" || candidate.user === "") {
      throw new Error("finance.json: `user` must be a FreeAgent user URI");
    }
    // Array.isArray matters: `typeof [] === "object"`, so an array would
    // otherwise pass validation and then iterate to nothing, leaving every
    // client unmapped with no error raised.
    if (
      typeof candidate.clients !== "object" ||
      candidate.clients === null ||
      Array.isArray(candidate.clients)
    ) {
      throw new Error(
        "finance.json: `clients` must be an object of label -> {project, task}",
      );
    }
    const incomplete = Object.entries(candidate.clients).find(([, mapping]) => {
      const m = mapping as Partial<ClientMapping>;
      return typeof m?.project !== "string" || typeof m?.task !== "string";
    });
    if (incomplete) {
      throw new Error(
        `finance.json: client "${incomplete[0]}" needs both project and task URIs — the API requires task and has no default`,
      );
    }
    return {
      clients: candidate.clients as Record<string, ClientMapping>,
      holidays: Array.isArray(candidate.holidays) ? candidate.holidays : [],
      user: candidate.user,
      workingDays:
        Array.isArray(candidate.workingDays) && candidate.workingDays.length > 0
          ? candidate.workingDays
          : DEFAULT_WORKING_DAYS,
    };
  }
}
