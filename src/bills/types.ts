import type { BankTransactionExplanation } from "../banking/index.ts";
import type { EvidenceState } from "../evidence/index.ts";

/**
 * List filters `GET /v2/bills` accepts. Verified against dev.freeagent.com,
 * and deliberately not the same set as invoices — bills add refund, hire
 * purchase and CIS views and drop the draft and email ones. Assuming the two
 * matched would send a view the API ignores, which returns everything and
 * reads as "nothing is overdue".
 */
export type BillView =
  | "all"
  | "cis"
  | "hire_purchase"
  | "open"
  | "open_or_overdue"
  | "open_or_overdue_payments"
  | "open_or_overdue_refunds"
  | "overdue"
  | "paid"
  | "recurring";

/** Statuses a bill can carry. Fewer than an invoice: no draft, no write-off. */
export type BillStatus =
  "Open" | "Overdue" | "Paid" | "Refunded" | "Zero Value";

/** A bill as returned by `GET /v2/bills`. */
export interface Bill {
  /** Supplier contact URI. */
  contact?: string;
  /** Bill currency. */
  currency?: string;
  /** Bill date, YYYY-MM-DD. */
  dated_on?: string;
  /** Payment due date, YYYY-MM-DD. */
  due_on?: string;
  /** Outstanding balance. */
  due_value?: string;
  /**
   * Native currency per unit of this document's currency, booked at its
   * date. Absent when the document is already in native currency.
   */
  exchange_rate?: string;
  /** Status with the due date as a relative phrase. */
  long_status?: string;
  /** Date the bill was fully paid, per FreeAgent. */
  paid_on?: string;
  /** Amount paid to date. */
  paid_value?: string;
  /** Free-text reference. */
  reference?: string;
  /** Current status. */
  status?: BillStatus;
  /** Gross total. */
  total_value?: string;
  /** Resource URI. */
  url: string;
}

/** A bill with its payment evidence resolved. */
export interface BillEvidence {
  /** Bank transaction URIs backing the payment. */
  bankTransactions: string[];
  /** The bill itself. */
  bill: Bill;
  /** Explanations that name this bill. */
  explanations: BankTransactionExplanation[];
  /** Plain-language reason for the state. */
  reason: string;
  /** Verdict. */
  state: EvidenceState;
}
