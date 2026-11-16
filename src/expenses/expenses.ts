import type { BankTransactionExplanation } from "../banking/index.ts";
import type { CurrencyTotal } from "../money/index.ts";
import type { Expense, UnpaidExpenses } from "./types.ts";

import { Money } from "../money/index.ts";

/**
 * Nominal code for the user's Expense Account — where out-of-pocket claims
 * accrue and where a reimbursement is posted when it leaves the bank.
 * Matched on the code rather than the full URI so sandbox and production
 * both resolve.
 */
export const EXPENSE_ACCOUNT_CODE = "905";

/**
 * Expense reasoning, pure.
 *
 * The sign convention is FreeAgent's and it is the thing to get right:
 * a **negative** `gross_value` is a payment due *to* the claimant, and a
 * positive one is a refund due *from* them. Reading the sign the other way
 * would turn every claim into a debt owed by you.
 */
export class Expenses {
  /** Gross claims per currency, unconverted, for showing the working. */
  static claimsByCurrency(expenses: Expense[]): CurrencyTotal[] {
    return Money.totalByCurrency(
      expenses.map((expense) => ({
        currency: expense.currency ?? "",
        value: -Money.parse(expense.gross_value),
      })),
    );
  }

  /**
   * What the company owes for one expense, in the company's native currency.
   * Positive means owed to the claimant.
   *
   * `native_gross_value` is preferred over `gross_value` because a USD
   * expense is reimbursed in GBP: netting the two needs one currency, and
   * FreeAgent has already done that conversion at the right rate. Falling
   * back to `gross_value` is only safe when no conversion was needed.
   */
  static claimValue(expense: Expense): number {
    const native = expense.native_gross_value ?? expense.gross_value;
    return -Money.parse(native);
  }

  /** Currencies present that fall outside the primary set. */
  static flaggedCurrencies(expenses: Expense[]): string[] {
    return Money.flagged(expenses.map((expense) => expense.currency ?? ""));
  }

  /** Whether an explanation is a reimbursement to a claimant. */
  static isReimbursement(explanation: BankTransactionExplanation): boolean {
    const category = explanation.category ?? "";
    return category.endsWith(`/${EXPENSE_ACCOUNT_CODE}`);
  }

  /**
   * Money paid out to claimants, in the company's native currency. The
   * explanation's value is negative because the money left the bank, so it
   * is flipped to a positive amount reimbursed.
   */
  static reimbursedValue(explanations: BankTransactionExplanation[]): number {
    return Money.round(
      explanations
        .filter((item) => Expenses.isReimbursement(item))
        .reduce((sum, item) => sum + -Money.parse(item.gross_value), 0),
    );
  }

  /**
   * Answer "do I have unpaid expenses, and how much?" over a window.
   *
   * **Pass no window to get a balance.** FreeAgent exposes no endpoint for the
   * Expense Account balance — users carry no balance field, the trial balance
   * summary returns profit-and-loss categories only, and the balance sheet
   * summary is not served — so it is computed from both sides. Unbounded, that
   * computation ties exactly to the figure FreeAgent's own app reports.
   *
   * A window makes it a movement instead, and a movement is not a balance: a
   * reimbursement inside the window can settle a claim from before it, so the
   * result can read as overpaid while the real balance is positive. On the
   * live account the 2026 movement is -505.77 against a balance of +39.61.
   * `basis` records which one this is so the two cannot be confused.
   */
  static unpaid(
    expenses: Expense[],
    explanations: BankTransactionExplanation[],
    window: { from_date?: string; to_date?: string } = {},
  ): UnpaidExpenses {
    const claimed = Money.round(
      expenses.reduce((sum, expense) => sum + Expenses.claimValue(expense), 0),
    );
    const reimbursements = explanations.filter((item) =>
      Expenses.isReimbursement(item),
    );
    const reimbursed = Expenses.reimbursedValue(explanations);
    const owed = Money.round(claimed - reimbursed);
    const bounded = Boolean(window.from_date ?? window.to_date);
    return {
      basis: bounded ? "movement" : "balance",
      claimed,
      claimedByCurrency: Expenses.claimsByCurrency(expenses),
      expenseCount: expenses.length,
      flaggedCurrencies: Expenses.flaggedCurrencies(expenses),
      hasUnpaid: owed > 0,
      owed,
      reimbursed,
      reimbursementCount: reimbursements.length,
      window,
    };
  }
}
