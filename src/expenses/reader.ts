import type { ExplanationWindow } from "../banking/index.ts";
import type { IFreeAgentClient } from "../client/index.ts";
import type { Expense, ExpenseView, UnpaidExpenses } from "./types.ts";

import { BankReader } from "../banking/index.ts";
import { Paging } from "../paging/index.ts";
import { Expenses } from "./expenses.ts";

const PER_PAGE = 100;

/** Fetches expenses and answers what is still owed to the claimant. */
export class ExpenseReader {
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
   * Expenses in a window. `view` is optional because the endpoint documents
   * only `recent` and `recurring` — there is no `all`, so the unfiltered list
   * is the complete one and passing `recent` would narrow it.
   */
  async list(
    window: ExplanationWindow = {},
    view?: ExpenseView,
  ): Promise<Expense[]> {
    return Paging.collect<Expense>(
      async (page) =>
        (
          await this.client.request<{ expenses?: Expense[] }>({
            path: "/v2/expenses",
            query: {
              from_date: window.from_date,
              page,
              per_page: PER_PAGE,
              to_date: window.to_date,
              view,
            },
          })
        ).expenses ?? [],
      PER_PAGE,
    );
  }

  /**
   * "Do I have unpaid expenses, and what is the total to pay out?"
   *
   * Both sides are read over the same window: claims from the expense list,
   * reimbursements from bank explanations posted to the Expense Account.
   * Holding them to one window is the same rule the invoice and bill readers
   * follow — measuring claims over one period and payments over another
   * produces a number that looks like a balance and is not.
   */
  async unpaid(window: ExplanationWindow = {}): Promise<UnpaidExpenses> {
    const expenses = await this.list(window);
    const explanations = await this.bank.explanationsEverywhere(window);
    return Expenses.unpaid(expenses, explanations, window);
  }
}
