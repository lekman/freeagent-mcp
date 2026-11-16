import type { ExplanationWindow } from "../banking/index.ts";
import type { IFreeAgentClient } from "../client/index.ts";
import type { Invoice, InvoiceEvidence, InvoiceView } from "./types.ts";

import { BankReader } from "../banking/index.ts";
import { Paging } from "../paging/index.ts";
import { Invoices } from "./invoices.ts";

const PER_PAGE = 100;

/**
 * Fetches invoices and resolves their payment evidence.
 *
 * I/O arrives through IFreeAgentClient, so this is testable end to end with a
 * scripted HTTP mock and no network.
 */
export class InvoiceReader {
  private readonly bank: BankReader;
  private readonly client: IFreeAgentClient;

  constructor(
    client: IFreeAgentClient,
    bank: BankReader = new BankReader(client),
  ) {
    this.bank = bank;
    this.client = client;
  }

  /**
   * The explanation window covering every invoice in the set. Starts at the
   * earliest invoice date, since a payment cannot precede its invoice, and is
   * left open at the top because a late payment is normal.
   */
  private static coveringWindow(
    invoices: Invoice[],
    requested: ExplanationWindow,
  ): ExplanationWindow {
    if (requested.from_date ?? requested.to_date) return requested;
    const dates = invoices
      .map((invoice) => invoice.dated_on)
      .filter((date): date is string => typeof date === "string")
      .sort();
    const earliest = dates[0];
    return earliest === undefined ? {} : { from_date: earliest };
  }

  /** Invoices dated inside the window; all of them when the window is open. */
  private static within(
    invoices: Invoice[],
    window: ExplanationWindow,
  ): Invoice[] {
    if (!window.from_date && !window.to_date) return invoices;
    return invoices.filter((invoice) => {
      const date = invoice.dated_on;
      if (date === undefined) return false;
      if (window.from_date && date < window.from_date) return false;
      if (window.to_date && date > window.to_date) return false;
      return true;
    });
  }

  /**
   * Invoices matching a view, following pagination. The view is sent as the
   * API's own filter rather than fetched-and-filtered here, so "overdue"
   * means what FreeAgent means by it.
   */
  async list(view: InvoiceView = "all"): Promise<Invoice[]> {
    return Paging.collect<Invoice>(
      async (page) =>
        (
          await this.client.request<{ invoices?: Invoice[] }>({
            path: "/v2/invoices",
            query: { page, per_page: PER_PAGE, view },
          })
        ).invoices ?? [],
      PER_PAGE,
    );
  }

  /** Everything open or overdue: the chase list. */
  async openOrOverdue(): Promise<Invoice[]> {
    return this.list("open_or_overdue");
  }

  /**
   * Invoices in a view, each with its payment evidence resolved.
   *
   * Explanations are fetched once across every bank account and matched in
   * memory. One pass over the accounts costs the same whether it checks one
   * invoice or all of them, and per-invoice fetching would multiply requests
   * by the size of the chase list.
   *
   * **Both sides are held to the same window.** A window bounding only the
   * explanations reports every older invoice as `claimed` — not because its
   * payment is unevidenced, but because the evidence was never fetched. That
   * reads as a finding about the books rather than an artefact of the query,
   * which is the worst kind of wrong answer. Measured on the first live run:
   * a May-2026 window over invoices dating to 2022 produced 137 false
   * `claimed` verdicts out of 151.
   *
   * With no window, one is derived from the invoices themselves, so the two
   * sets align by construction rather than by the caller remembering to.
   */
  async withEvidence(
    view: InvoiceView = "paid",
    window: ExplanationWindow = {},
  ): Promise<InvoiceEvidence[]> {
    const invoices = InvoiceReader.within(await this.list(view), window);
    if (invoices.length === 0) return [];
    const explanations = await this.bank.explanationsEverywhere(
      InvoiceReader.coveringWindow(invoices, window),
    );
    return invoices.map((invoice) =>
      Invoices.evidenceFor(invoice, explanations),
    );
  }
}
