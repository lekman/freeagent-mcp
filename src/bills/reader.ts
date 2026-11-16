import type { ExplanationWindow } from "../banking/index.ts";
import type { IFreeAgentClient } from "../client/index.ts";
import type { Bill, BillEvidence, BillView } from "./types.ts";

import { BankReader } from "../banking/index.ts";
import { Paging } from "../paging/index.ts";
import { Bills } from "./bills.ts";

const PER_PAGE = 100;

/**
 * Fetches bills and resolves their payment evidence.
 *
 * One difference from the sales side, and it is the API's not ours: bills
 * accept `from_date` and `to_date` server-side, so a window is pushed to the
 * endpoint rather than applied after fetching. Invoices have no such filter
 * and must be narrowed here.
 */
export class BillReader {
  private readonly bank: BankReader;
  private readonly client: IFreeAgentClient;

  constructor(
    client: IFreeAgentClient,
    bank: BankReader = new BankReader(client),
  ) {
    this.bank = bank;
    this.client = client;
  }

  /** Explanation window covering every bill; a payment cannot precede its bill. */
  private static coveringWindow(
    bills: Bill[],
    requested: ExplanationWindow,
  ): ExplanationWindow {
    if (requested.from_date ?? requested.to_date) return requested;
    const earliest = bills
      .map((bill) => bill.dated_on)
      .filter((date): date is string => typeof date === "string")
      .sort()[0];
    return earliest === undefined ? {} : { from_date: earliest };
  }

  /** Bills matching a view, narrowed server-side by the window. */
  async list(
    view: BillView = "all",
    window: ExplanationWindow = {},
  ): Promise<Bill[]> {
    return Paging.collect<Bill>(
      async (page) =>
        (
          await this.client.request<{ bills?: Bill[] }>({
            path: "/v2/bills",
            query: {
              from_date: window.from_date,
              page,
              per_page: PER_PAGE,
              to_date: window.to_date,
              view,
            },
          })
        ).bills ?? [],
      PER_PAGE,
    );
  }

  /** Everything open or overdue: what is owed to suppliers. */
  async openOrOverdue(): Promise<Bill[]> {
    return this.list("open_or_overdue");
  }

  /**
   * Bills in a view with their payment evidence.
   *
   * The same window covers both sides, for the reason recorded on the invoice
   * reader: bounding only the explanations reports older items as `claimed`
   * because their evidence was never fetched, which reads as a finding rather
   * than an artefact. Here the window is honoured by the endpoint itself, so
   * alignment costs nothing extra.
   */
  async withEvidence(
    view: BillView = "paid",
    window: ExplanationWindow = {},
  ): Promise<BillEvidence[]> {
    const bills = await this.list(view, window);
    if (bills.length === 0) return [];
    const explanations = await this.bank.explanationsEverywhere(
      BillReader.coveringWindow(bills, window),
    );
    return bills.map((bill) => Bills.evidenceFor(bill, explanations));
  }
}
