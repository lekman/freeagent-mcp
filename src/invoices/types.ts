import type { BankTransactionExplanation } from "../banking/index.ts";
import type { EvidenceState } from "../evidence/index.ts";

/**
 * List filters the API accepts. Verified against dev.freeagent.com rather
 * than inferred — an unsupported view is ignored server-side and silently
 * returns everything, which reads as "nothing is overdue".
 */
export type InvoiceView =
  | "all"
  | "draft"
  | "open"
  | "open_or_overdue"
  | "overdue"
  | "paid"
  | "recent_open_or_overdue"
  | "scheduled_to_email";

/** Statuses an invoice can carry. */
export type InvoiceStatus =
  | "Draft"
  | "Open"
  | "Overdue"
  | "Overpaid"
  | "Paid"
  | "Part written-off"
  | "Refunded"
  | "Scheduled To Email"
  | "Written-off"
  | "Zero Value";

/** An invoice as returned by `GET /v2/invoices`. */
export interface Invoice {
  /** Contact URI. */
  contact?: string;
  /** Display name of the invoiced contact. */
  contact_name?: string;
  /** Invoice currency. */
  currency?: string;
  /** Invoice date, YYYY-MM-DD. */
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
  /** Date the invoice was fully paid, per FreeAgent. */
  paid_on?: string;
  /** Amount received to date. */
  paid_value?: string;
  /** Invoice reference. */
  reference?: string;
  /** Current status. */
  status?: InvoiceStatus;
  /** Gross total. */
  total_value?: string;
  /** Resource URI. */
  url: string;
}

/** An invoice with its payment evidence resolved. */
export interface InvoiceEvidence {
  /** Bank transaction URIs backing the payment. */
  bankTransactions: string[];
  /** Explanations that name this invoice. */
  explanations: BankTransactionExplanation[];
  /** The invoice itself. */
  invoice: Invoice;
  /** Plain-language reason for the state, safe to put in a report. */
  reason: string;
  /** Verdict. */
  state: EvidenceState;
}
