import type { BankTransactionExplanation } from "../banking/index.ts";
import type { CurrencyBreakdown } from "../money/index.ts";
import type { Bill, BillEvidence } from "./types.ts";

import { Evidence } from "../evidence/index.ts";
import { Money } from "../money/index.ts";

/**
 * Statuses meaning FreeAgent considers the bill settled.
 *
 * `Refunded` is settled: the docs define it as a negative-value bill that is
 * fully paid. Leaving it out would report every supplier refund as money
 * still owed.
 */
const SETTLED_STATUSES = new Set(["Paid", "Refunded"]);

/** Bill reasoning, pure. The purchase-side mirror of Invoices. */
export class Bills {
  /** Days a bill is overdue on `today`; 0 when not yet due. */
  static daysOverdue(bill: Bill, today: string): number {
    if (!bill.due_on) return 0;
    const due = Date.parse(`${bill.due_on}T00:00:00Z`);
    const now = Date.parse(`${today}T00:00:00Z`);
    if (!Number.isFinite(due) || !Number.isFinite(now)) return 0;
    const days = Math.floor((now - due) / 86_400_000);
    return days > 0 ? days : 0;
  }

  /**
   * Resolve a bill against the explanations that name it. Same rule as the
   * sales side, matched on `paid_bill` instead of `paid_invoice`.
   */
  static evidenceFor(
    bill: Bill,
    explanations: BankTransactionExplanation[],
  ): BillEvidence {
    const query = {
      explanations,
      linkOf: (item: BankTransactionExplanation) => item.paid_bill,
      noun: "bill",
      reference: bill.reference ?? bill.url,
      settled: Bills.isSettled(bill),
      status: bill.status ?? "paid",
      url: bill.url,
    };
    return {
      ...Evidence.resolve(query),
      bill,
      explanations: Evidence.matching(query),
    };
  }

  /** Whether FreeAgent considers the bill settled. */
  static isSettled(bill: Bill): boolean {
    return SETTLED_STATUSES.has(bill.status ?? "");
  }

  /** Outstanding value per currency; never summed across currencies. */
  static owedByCurrency(items: Bill[]): CurrencyBreakdown {
    return Money.breakdown(
      items.map((item) => ({
        currency: item.currency ?? "",
        value: Money.parse(item.due_value),
      })),
    );
  }

  /**
   * Outstanding value converted to the company's native currency using each
   * document's own booked `exchange_rate`. A bill without a rate is assumed
   * to be in native currency already — that is what a missing rate means.
   *
   * The caveat travels with the number: this is the rate the ledger booked,
   * not the rate the money will settle at.
   */
  static owedInNative(items: Bill[]): number {
    return Money.round(
      items.reduce(
        (sum, item) =>
          sum +
          Money.toNative(Money.parse(item.due_value), item.exchange_rate ?? 1),
        0,
      ),
    );
  }
}
