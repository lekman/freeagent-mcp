import type { CurrencyTotal } from "../money/index.ts";

/**
 * List filters `GET /v2/expenses` accepts. Only two are documented — there is
 * no `all`, so an unfiltered list is the default and `recent` is a narrowing.
 */
export type ExpenseView = "recent" | "recurring";

/** An out-of-pocket expense as returned by `GET /v2/expenses`. */
export interface Expense {
  /** Category URI the expense is posted to. */
  category?: string;
  /** Currency the expense was incurred in. */
  currency?: string;
  /** Expense date, YYYY-MM-DD. */
  dated_on?: string;
  /** Free-text description. */
  description?: string;
  /**
   * Value in the expense's own currency. **Negative means a payment due to
   * the claimant**; positive means a refund due from them.
   */
  gross_value?: string;
  /**
   * Value converted to the company's native currency by FreeAgent. This is
   * what nets against a reimbursement, which is always paid in the bank
   * account's currency — using it avoids inventing an exchange rate.
   */
  native_gross_value?: string;
  /** Receipt reference, when one was recorded. */
  receipt_reference?: string;
  /** Resource URI. */
  url: string;
  /** The claimant. */
  user?: string;
}

/** What is still owed to a claimant, and the working that produced it. */
export interface UnpaidExpenses {
  /** Claims raised in the window, in the company's native currency. */
  claimed: number;
  /** Gross claims per currency, unconverted, for transparency. */
  claimedByCurrency: CurrencyTotal[];
  /** Currencies present that the toolkit does not otherwise handle. */
  flaggedCurrencies: string[];
  /** Straight answer to "do I have unpaid expenses?". */
  hasUnpaid: boolean;
  /** Number of expenses counted. */
  expenseCount: number;
  /** Reimbursements paid in the window, in the company's native currency. */
  reimbursed: number;
  /** Number of reimbursement explanations counted. */
  reimbursementCount: number;
  /** Still owed: claimed less reimbursed. Negative means overpaid. */
  owed: number;
  /**
   * Whether the figure is a true balance or only a movement.
   *
   * `balance` when no window was given: every claim and every reimbursement
   * is counted, so `owed` is what the claimant is actually owed and ties to
   * the figure FreeAgent's own app shows.
   *
   * `movement` when a window was given: claims and reimbursements inside the
   * window only. A reimbursement inside it can settle a claim from before it,
   * so a movement can read as **negative** — overpaid — while the real
   * balance is positive. Measured on the live account: the 2026 movement is
   * -505.77 while the balance is +39.61.
   */
  basis: "balance" | "movement";
  /** The window both sides were measured over; empty for a balance. */
  window: { from_date?: string; to_date?: string };
}
