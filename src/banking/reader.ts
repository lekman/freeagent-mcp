import type { IFreeAgentClient } from "../client/index.ts";
import type {
  BankAccount,
  BankTransactionExplanation,
  ExplanationWindow,
} from "./types.ts";

import { Paging } from "../paging/index.ts";

const PER_PAGE = 100;

/**
 * Reads bank accounts and their explanations.
 *
 * The shape here is forced by the API: explanations cannot be listed across
 * the whole company, only per bank account, so every evidence lookup starts
 * by enumerating accounts. An implementation that queried one account would
 * silently miss any invoice settled into another.
 */
export class BankReader {
  private readonly client: IFreeAgentClient;

  constructor(client: IFreeAgentClient) {
    this.client = client;
  }

  /** Every bank account on the company. */
  async accounts(): Promise<BankAccount[]> {
    const body = await this.client.request<{ bank_accounts?: BankAccount[] }>({
      path: "/v2/bank_accounts",
    });
    return body.bank_accounts ?? [];
  }

  /**
   * Explanations for one account, following pagination to the end. Stopping
   * at the first page would under-report, and under-reporting here reads as
   * "no evidence exists" rather than "we did not look far enough".
   */
  async explanations(
    bankAccount: string,
    window: ExplanationWindow = {},
  ): Promise<BankTransactionExplanation[]> {
    return Paging.collect<BankTransactionExplanation>(
      async (page) =>
        (
          await this.client.request<{
            bank_transaction_explanations?: BankTransactionExplanation[];
          }>({
            path: "/v2/bank_transaction_explanations",
            query: {
              bank_account: bankAccount,
              from_date: window.from_date,
              page,
              per_page: PER_PAGE,
              to_date: window.to_date,
            },
          })
        ).bank_transaction_explanations ?? [],
      PER_PAGE,
    );
  }

  /** Explanations across every account, for a whole-company evidence walk. */
  async explanationsEverywhere(
    window: ExplanationWindow = {},
  ): Promise<BankTransactionExplanation[]> {
    const accounts = await this.accounts();
    const all: BankTransactionExplanation[] = [];
    for (const account of accounts) {
      all.push(...(await this.explanations(account.url, window)));
    }
    return all;
  }
}
