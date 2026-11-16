/** A bank account as returned by `GET /v2/bank_accounts`. */
export interface BankAccount {
  /** Account currency. */
  currency?: string;
  /** Display name. */
  name?: string;
  /** Resource URI, used to scope an explanation listing. */
  url: string;
}

/**
 * A bank transaction explanation: the record tying money that moved to what
 * it was for. This is the link that turns "FreeAgent says paid" into evidence.
 */
export interface BankTransactionExplanation {
  /** The transaction this explains. */
  bank_transaction?: string;
  /** Category URI the explanation is posted to. */
  category?: string;
  /** Date of the explanation. */
  dated_on?: string;
  /** Free-text description; absent on invoice receipts and transfers. */
  description?: string;
  /** Value in the bank account's native currency. */
  gross_value?: string;
  /** Bill this explanation settles, when it settles one. */
  paid_bill?: string;
  /** Invoice this explanation settles, when it settles one. */
  paid_invoice?: string;
  /** Resource URI. */
  url: string;
}

/** Date window for an explanation listing. */
export interface ExplanationWindow {
  /** Inclusive start, YYYY-MM-DD. */
  from_date?: string;
  /** Inclusive end, YYYY-MM-DD. */
  to_date?: string;
}
