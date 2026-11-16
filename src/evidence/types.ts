/**
 * How well a claim of payment is supported.
 *
 * `claimed` is the important one: the ledger says settled, but no bank
 * transaction explanation points at it. That is either a mis-explained
 * payment or one recorded by hand, and both are worth seeing.
 */
export type EvidenceState =
  "claimed" | "evidenced" | "outstanding" | "part-evidenced";

/** The resolved evidence, without the subject it belongs to. */
export interface EvidenceVerdict {
  /** Bank transaction URIs backing the payment. */
  bankTransactions: string[];
  /** Plain-language reason, safe to put in a report. */
  reason: string;
  /** Verdict. */
  state: EvidenceState;
}
