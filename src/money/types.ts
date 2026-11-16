/**
 * Currencies the business handles routinely. GBP is the company's own
 * currency and SEK is what most sales are invoiced in — neither is a special
 * case of the other, and this list is **not** an allow-list. Currencies
 * outside it are still counted and reported; they are only flagged, because
 * an unexpected currency in a total is worth a second look.
 */
export const PRIMARY_CURRENCIES = ["GBP", "SEK"] as const;

/** A currency the business handles routinely. */
export type PrimaryCurrency = (typeof PRIMARY_CURRENCIES)[number];

/** A total held against the currency it is denominated in. */
export interface CurrencyTotal {
  /** ISO currency code. */
  currency: string;
  /** Number of items contributing to the total. */
  count: number;
  /** Sum, in that currency. Never converted. */
  total: number;
}

/** Anything carrying a value and the currency it is in. */
export interface Denominated {
  /** ISO currency code. */
  currency: string;
  /** Value in that currency. */
  value: number;
}

/** Totals per currency, with anything outside the primary set called out. */
export interface CurrencyBreakdown {
  /** Currencies present that are outside the primary set. */
  flagged: string[];
  /** One total per currency, sorted. Never a grand total. */
  totals: CurrencyTotal[];
}
