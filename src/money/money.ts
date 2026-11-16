import type {
  CurrencyBreakdown,
  CurrencyTotal,
  Denominated,
  PrimaryCurrency,
} from "./types.ts";

import { PRIMARY_CURRENCIES } from "./types.ts";

/**
 * Currency handling, kept deliberately unhelpful: it will not convert, and it
 * will not guess. A report that silently adds SEK to GBP is worse than one
 * that refuses, because the number it produces looks like an answer.
 *
 * It does not refuse to *count*, though. The books carry GBP, SEK, EUR and
 * USD, so halting on an unfamiliar code would make whole reports permanently
 * unavailable. Everything is grouped and totalled in its own currency, and
 * anything outside the primary set is flagged for a second look. That keeps
 * "never guessed" without buying it at the cost of "never answered".
 */
export class Money {
  /**
   * Throw unless the code is one this toolkit handles. Called at the boundary
   * so an unexpected currency stops there rather than flowing into a total.
   */
  static assertPrimary(currency: string): PrimaryCurrency {
    if (!Money.isPrimary(currency)) {
      throw new Error(
        `${currency} is outside the primary set (${PRIMARY_CURRENCIES.join(", ")}) — this caller needs a single known currency. Reports should group and flag instead of halting`,
      );
    }
    return currency;
  }

  /**
   * Group values by currency and flag anything outside the primary set.
   * The preferred entry point for a report: nothing is dropped, nothing is
   * converted, and an unexpected currency is visible rather than fatal.
   */
  static breakdown(items: Denominated[]): CurrencyBreakdown {
    return {
      flagged: Money.flagged(items.map((item) => item.currency)),
      totals: Money.totalByCurrency(items),
    };
  }

  /** Currencies present that are outside the primary set, sorted. */
  static flagged(currencies: string[]): string[] {
    return [
      ...new Set(
        currencies.filter(
          (currency) => currency !== "" && !Money.isPrimary(currency),
        ),
      ),
    ].sort();
  }

  /** Whether this is one of the routinely handled currencies. */
  static isPrimary(currency: string): currency is PrimaryCurrency {
    return (PRIMARY_CURRENCIES as readonly string[]).includes(currency);
  }

  /**
   * Parse a FreeAgent decimal string. The API sends money as strings to avoid
   * float drift, so `Number()` on a missing field silently yields 0 and a
   * missing field is not the same as nothing owed.
   */
  static parse(value: string | number | undefined | null): number {
    if (value === undefined || value === null || value === "") {
      throw new Error("missing monetary value — refusing to read it as zero");
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`unparseable monetary value: ${String(value)}`);
    }
    return parsed;
  }

  /** Round to whole pence/öre, killing accumulated float error. */
  static round(value: number): number {
    return Math.round(value * 100) / 100;
  }

  /**
   * Convert to the company's native currency using a rate the ledger
   * supplied — FreeAgent's `exchange_rate`, booked at the document's date.
   *
   * This is not a rate we chose, which is the whole point. It is also **not
   * the rate the money will settle at**: a forward contract or a spot
   * conversion on the day realises something different, and the gap is a real
   * gain or loss. Anything reporting a converted figure should say which rate
   * it used.
   */
  static toNative(value: number, exchangeRate: string | number): number {
    const rate = Money.parse(exchangeRate);
    if (rate <= 0) {
      throw new Error(`exchange rate must be positive, got ${String(rate)}`);
    }
    return Money.round(value * rate);
  }

  /**
   * Group values by currency. Returns one total per currency, sorted, and
   * never a single grand total — there is no exchange rate here, and inventing
   * one is how a report becomes confidently wrong.
   */
  static totalByCurrency(items: Denominated[]): CurrencyTotal[] {
    const byCurrency = new Map<string, CurrencyTotal>();
    for (const item of items) {
      const existing = byCurrency.get(item.currency);
      if (existing) {
        existing.count += 1;
        existing.total = Money.round(existing.total + item.value);
      } else {
        byCurrency.set(item.currency, {
          count: 1,
          currency: item.currency,
          total: Money.round(item.value),
        });
      }
    }
    return [...byCurrency.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    );
  }
}
