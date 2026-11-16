import type { BankTransactionExplanation } from "../banking/index.ts";
import type { EvidenceVerdict } from "./types.ts";

/** What to resolve, and how to recognise an explanation that names it. */
export interface EvidenceQuery {
  /** Explanations to search. */
  explanations: BankTransactionExplanation[];
  /** Pulls the link field: `paid_invoice` for sales, `paid_bill` for purchases. */
  linkOf: (explanation: BankTransactionExplanation) => string | undefined;
  /** What to call the subject in the reason text. */
  noun: string;
  /** Human-facing identifier, e.g. an invoice reference. */
  reference: string;
  /** Whether the ledger considers it settled. */
  settled: boolean;
  /** Status as the ledger reports it, quoted back in the reason. */
  status: string;
  /** The subject's resource URI, matched against the link field. */
  url: string;
}

/**
 * The one place the paid-versus-evidenced rule lives.
 *
 * Sales and purchases resolve identically — only the link field differs — so
 * the rule is written once. Two copies would drift, and the copy that drifted
 * would be the one reporting that a payment happened.
 */
export class Evidence {
  /** Explanations naming this subject. */
  static matching(query: EvidenceQuery): BankTransactionExplanation[] {
    return query.explanations.filter(
      (explanation) => query.linkOf(explanation) === query.url,
    );
  }

  /**
   * Resolve the subject against its explanations.
   *
   * A settled subject with no explanation naming it is `claimed`, never paid:
   * the ledger's own status is an opinion, and the evidence is the bank.
   */
  static resolve(query: EvidenceQuery): EvidenceVerdict {
    const matching = Evidence.matching(query);
    const bankTransactions = matching
      .map((explanation) => explanation.bank_transaction)
      .filter((url): url is string => typeof url === "string");

    if (!query.settled) {
      return {
        bankTransactions,
        reason:
          matching.length > 0
            ? `${query.reference} is not settled, but ${matching.length} explanation(s) already point at it — a part payment`
            : `${query.reference} is outstanding: nothing ${query.noun === "bill" ? "paid" : "received"}`,
        state: matching.length > 0 ? "part-evidenced" : "outstanding",
      };
    }

    if (matching.length === 0) {
      return {
        bankTransactions,
        reason: `${query.reference} is marked ${query.status} in FreeAgent, but no bank transaction explanation names it — the payment is claimed, not evidenced`,
        state: "claimed",
      };
    }

    return {
      bankTransactions,
      reason: `${query.reference} is settled and traced to ${bankTransactions.length} bank transaction(s)`,
      state: "evidenced",
    };
  }
}
