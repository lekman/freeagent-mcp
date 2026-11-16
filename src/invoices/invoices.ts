import type { BankTransactionExplanation } from "../banking/index.ts";
import type { CurrencyBreakdown } from "../money/index.ts";
import type { Invoice, InvoiceEvidence } from "./types.ts";

import { Evidence } from "../evidence/index.ts";
import { Money } from "../money/index.ts";

/** Statuses that mean FreeAgent considers the invoice settled. */
const SETTLED_STATUSES = new Set(["Paid", "Overpaid"]);

/**
 * Invoice reasoning, all of it pure. The evidence rules live here rather than
 * in the reader so they can be tested against fixed inputs — which matters,
 * because the whole point of this module is not taking the ledger's word for
 * it, and a rule that is hard to test is a rule nobody checks.
 */
export class Invoices {
  /**
   * Days an invoice is overdue on `today`; 0 when not yet due. Both dates are
   * compared as calendar dates, so a timezone never moves an invoice a day.
   */
  static daysOverdue(invoice: Invoice, today: string): number {
    if (!invoice.due_on) return 0;
    const due = Date.parse(`${invoice.due_on}T00:00:00Z`);
    const now = Date.parse(`${today}T00:00:00Z`);
    if (!Number.isFinite(due) || !Number.isFinite(now)) return 0;
    const days = Math.floor((now - due) / 86_400_000);
    return days > 0 ? days : 0;
  }

  /**
   * Resolve an invoice against the explanations that name it.
   *
   * The rule itself lives in Evidence, shared with bills: `paid_on` is
   * FreeAgent's opinion, and an invoice marked paid with nothing in the bank
   * pointing at it is reported as `claimed`, never as paid.
   */
  static evidenceFor(
    invoice: Invoice,
    explanations: BankTransactionExplanation[],
  ): InvoiceEvidence {
    const query = {
      explanations,
      linkOf: (item: BankTransactionExplanation) => item.paid_invoice,
      noun: "invoice",
      reference: invoice.reference ?? invoice.url,
      settled: Invoices.isSettled(invoice),
      status: invoice.status ?? "paid",
      url: invoice.url,
    };
    return {
      ...Evidence.resolve(query),
      explanations: Evidence.matching(query),
      invoice,
    };
  }

  /** Whether FreeAgent considers the invoice settled. */
  static isSettled(invoice: Invoice): boolean {
    return SETTLED_STATUSES.has(invoice.status ?? "");
  }

  /**
   * Outstanding value per currency. Grouped, never summed across currencies,
   * and an unhandled currency throws rather than being dropped — a quietly
   * omitted invoice understates what is owed.
   */
  static outstandingByCurrency(items: Invoice[]): CurrencyBreakdown {
    return Money.breakdown(
      items.map((item) => ({
        currency: item.currency ?? "",
        value: Money.parse(item.due_value),
      })),
    );
  }

  /**
   * Outstanding value converted to the company's native currency using each
   * document's own booked `exchange_rate`. A invoice without a rate is assumed
   * to be in native currency already — that is what a missing rate means.
   *
   * The caveat travels with the number: this is the rate the ledger booked,
   * not the rate the money will settle at.
   */
  static outstandingInNative(items: Invoice[]): number {
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
