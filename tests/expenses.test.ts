import { describe, expect, test } from "bun:test";

import { FreeAgentClient } from "../src/client";
import { ExpenseReader, Expenses } from "../src/expenses";
import { HttpMock } from "./mocks/http.mock";
import { TokenStoreMock } from "./mocks/token-store.mock";

const NOW = 1_800_000_000;
const OK = (body: unknown) => ({ body: JSON.stringify(body), status: 200 });

const build = (responses: { body: string; status: number }[]) => {
  const http = new HttpMock(responses);
  const client = new FreeAgentClient({
    credentials: { clientId: "id", clientSecret: "secret" },
    http,
    now: () => NOW,
    tokens: new TokenStoreMock({ access_token: "c", expires_at: NOW + 3600 }),
  });
  return { client, http };
};

const spend = (gross: string, over: Record<string, unknown> = {}) => ({
  currency: "GBP",
  dated_on: "2026-08-01",
  gross_value: gross,
  native_gross_value: gross,
  url: `https://api.freeagent.com/v2/expenses/${gross}`,
  ...over,
});

const reimbursement = (gross: string) => ({
  category: "https://api.freeagent.com/v2/categories/905",
  gross_value: gross,
  url: `https://api.freeagent.com/v2/bank_transaction_explanations/${gross}`,
});

describe("Expenses.claimValue", () => {
  test("a negative gross value is money owed TO the claimant", () => {
    // FreeAgent's convention. Reading the sign the other way would turn
    // every claim into a debt owed by the claimant.
    expect(Expenses.claimValue(spend("-39.60"))).toBe(39.6);
  });

  test("a positive gross value is a refund owed BY the claimant", () => {
    expect(Expenses.claimValue(spend("12.00"))).toBe(-12);
  });

  test("prefers the native value so a USD expense nets against GBP", () => {
    // A USD expense is reimbursed in GBP. Netting needs one currency, and
    // FreeAgent has already converted at the right rate — we never invent one.
    const usd = spend("-10.46", {
      currency: "USD",
      native_gross_value: "-8.12",
    });
    expect(Expenses.claimValue(usd)).toBe(8.12);
  });

  test("falls back to gross when no conversion was needed", () => {
    const noNative = { ...spend("-5.00"), native_gross_value: undefined };
    expect(Expenses.claimValue(noNative)).toBe(5);
  });

  test("negative: a missing value halts rather than reading as zero", () => {
    expect(() =>
      Expenses.claimValue({ url: "u" } as unknown as ReturnType<typeof spend>),
    ).toThrow("refusing to read it as zero");
  });
});

describe("Expenses.isReimbursement", () => {
  test("an explanation posted to 905 is a reimbursement", () => {
    expect(Expenses.isReimbursement(reimbursement("-100.0"))).toBe(true);
  });

  test("negative: another category is not", () => {
    expect(
      Expenses.isReimbursement({
        category: "https://api.freeagent.com/v2/categories/274",
        url: "e",
      }),
    ).toBe(false);
  });

  test("negative: a category ending in 1905 is not 905", () => {
    // Suffix matching must not match a longer code that happens to end the
    // same way, or an unrelated account would be counted as a payout.
    expect(
      Expenses.isReimbursement({
        category: "https://api.freeagent.com/v2/categories/1905",
        url: "e",
      }),
    ).toBe(false);
  });

  test("negative: an uncategorised explanation is not a reimbursement", () => {
    expect(Expenses.isReimbursement({ url: "e" })).toBe(false);
  });
});

describe("Expenses.unpaid", () => {
  test("owed is claims less reimbursements", () => {
    const result = Expenses.unpaid(
      [spend("-100.00"), spend("-50.00")],
      [reimbursement("-120.00")],
    );
    expect(result.claimed).toBe(150);
    expect(result.reimbursed).toBe(120);
    expect(result.owed).toBe(30);
    expect(result.hasUnpaid).toBe(true);
  });

  test("fully reimbursed answers no", () => {
    const result = Expenses.unpaid(
      [spend("-80.00")],
      [reimbursement("-80.00")],
    );
    expect(result.owed).toBe(0);
    expect(result.hasUnpaid).toBe(false);
  });

  test("negative: overpaid is reported as negative, not clamped to zero", () => {
    // Being owed less than nothing is a real state and worth seeing.
    const result = Expenses.unpaid(
      [spend("-50.00")],
      [reimbursement("-75.00")],
    );
    expect(result.owed).toBe(-25);
    expect(result.hasUnpaid).toBe(false);
  });

  test("negative: explanations in other categories are not counted as payouts", () => {
    const result = Expenses.unpaid(
      [spend("-100.00")],
      [
        reimbursement("-40.00"),
        {
          category: "https://api.freeagent.com/v2/categories/274",
          gross_value: "-999.00",
          url: "x",
        },
      ],
    );
    expect(result.reimbursed).toBe(40);
    expect(result.reimbursementCount).toBe(1);
    expect(result.owed).toBe(60);
  });

  test("flags currencies outside the handled set without dropping them", () => {
    // The books really do carry USD. Halting would make the answer
    // unavailable forever; dropping it would understate the claim.
    const result = Expenses.unpaid(
      [
        spend("-20.00"),
        spend("-10.46", { currency: "USD", native_gross_value: "-8.12" }),
      ],
      [],
    );
    expect(result.flaggedCurrencies).toEqual(["USD"]);
    expect(result.claimed).toBe(28.12);
    expect(result.claimedByCurrency).toEqual([
      { count: 1, currency: "GBP", total: 20 },
      { count: 1, currency: "USD", total: 10.46 },
    ]);
  });

  test("the window travels with the answer", () => {
    // The figure is a movement over a window, not an all-time balance, so
    // the window must not be separable from it.
    const window = { from_date: "2026-01-01", to_date: "2026-08-16" };
    expect(Expenses.unpaid([], [], window).window).toEqual(window);
  });

  test("no expenses and no payouts is a clean zero", () => {
    const result = Expenses.unpaid([], []);
    expect(result).toMatchObject({ claimed: 0, hasUnpaid: false, owed: 0 });
  });
});

describe("ExpenseReader", () => {
  test("sends no view by default, because there is no `all`", async () => {
    // The endpoint documents only `recent` and `recurring`. Sending `recent`
    // would narrow the list and understate what is owed.
    const { client, http } = build([OK({ expenses: [] })]);
    await new ExpenseReader(client).list({ from_date: "2026-01-01" });
    const url = http.requests[0]?.url ?? "";
    expect(url).toContain("from_date=2026-01-01");
    expect(url).not.toContain("view=");
  });

  test("passes a view when one is asked for", async () => {
    const { client, http } = build([OK({ expenses: [] })]);
    await new ExpenseReader(client).list({}, "recurring");
    expect(http.requests[0]?.url).toContain("view=recurring");
  });

  test("reads both sides over the same window", async () => {
    const { client, http } = build([
      OK({ expenses: [spend("-100.00")] }),
      OK({ bank_accounts: [{ url: "https://acct/1" }] }),
      OK({ bank_transaction_explanations: [reimbursement("-30.00")] }),
    ]);
    const result = await new ExpenseReader(client).unpaid({
      from_date: "2026-01-01",
    });
    expect(result.owed).toBe(70);
    // Claims over one period and payments over another is not a balance.
    expect(http.requests[0]?.url).toContain("from_date=2026-01-01");
    expect(http.requests[2]?.url).toContain("from_date=2026-01-01");
  });
});

describe("Expenses.unpaid basis", () => {
  test("no window is a balance", () => {
    // Unbounded, this ties exactly to the figure FreeAgent's own app shows:
    // verified at GBP 39.61 across 1,232 claims on the live account.
    expect(Expenses.unpaid([], []).basis).toBe("balance");
  });

  test("any window makes it a movement, not a balance", () => {
    expect(Expenses.unpaid([], [], { from_date: "2026-01-01" }).basis).toBe(
      "movement",
    );
    expect(Expenses.unpaid([], [], { to_date: "2026-08-16" }).basis).toBe(
      "movement",
    );
  });

  test("negative: a movement can read overpaid while the balance is owed", () => {
    // The trap. A reimbursement inside the window settles a claim from
    // before it, so the window shows -60 while the true balance is +40.
    const windowed = Expenses.unpaid(
      [spend("-40.00")],
      [reimbursement("-100.00")],
      { from_date: "2026-01-01" },
    );
    expect(windowed.owed).toBe(-60);
    expect(windowed.basis).toBe("movement");
    expect(windowed.hasUnpaid).toBe(false);
  });
});
