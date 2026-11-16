import { describe, expect, test } from "bun:test";

import { BillReader, Bills } from "../src/bills";
import { FreeAgentClient } from "../src/client";
import { Paging } from "../src/paging";
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

const bill = (over: Record<string, unknown> = {}) => ({
  currency: "GBP",
  dated_on: "2026-07-01",
  due_on: "2026-07-31",
  due_value: "0.0",
  reference: "SUP-1",
  status: "Paid" as const,
  total_value: "240.0",
  url: "https://api.freeagent.com/v2/bills/1",
  ...over,
});

describe("Bills.evidenceFor", () => {
  test("matches on paid_bill, not paid_invoice", async () => {
    // The two link fields are distinct. Matching the wrong one would report
    // every bill as claimed while quietly crediting an invoice.
    const settled = Bills.evidenceFor(bill(), [
      {
        bank_transaction: "https://txn/4",
        paid_bill: "https://api.freeagent.com/v2/bills/1",
        url: "e1",
      },
    ]);
    expect(settled.state).toBe("evidenced");
    expect(settled.bankTransactions).toEqual(["https://txn/4"]);
  });

  test("negative: an explanation naming an invoice does not evidence a bill", () => {
    const result = Bills.evidenceFor(bill(), [
      { paid_invoice: "https://api.freeagent.com/v2/bills/1", url: "e1" },
    ]);
    expect(result.state).toBe("claimed");
  });

  test("Refunded counts as settled", () => {
    // The docs define it as a negative-value bill that is fully paid.
    // Excluding it would report every supplier refund as still owed.
    expect(Bills.isSettled(bill({ status: "Refunded" }))).toBe(true);
  });

  test("negative: Open is not settled", () => {
    expect(
      Bills.evidenceFor(bill({ due_value: "240.0", status: "Open" }), []).state,
    ).toBe("outstanding");
  });

  test("an unsettled bill with an explanation is a part payment", () => {
    const result = Bills.evidenceFor(
      bill({ due_value: "100.0", paid_value: "140.0", status: "Open" }),
      [{ paid_bill: "https://api.freeagent.com/v2/bills/1", url: "e1" }],
    );
    expect(result.state).toBe("part-evidenced");
  });

  test("the outstanding reason says paid, not received, on the purchase side", () => {
    const result = Bills.evidenceFor(
      bill({ due_value: "240.0", status: "Open" }),
      [],
    );
    expect(result.reason).toContain("nothing paid");
  });
});

describe("Bills.owedByCurrency", () => {
  test("groups by currency", () => {
    expect(
      Bills.owedByCurrency([
        bill({ due_value: "100.0" }),
        bill({ currency: "SEK", due_value: "500.0" }),
      ]),
    ).toMatchObject({
      flagged: [],
      totals: [
        { count: 1, currency: "GBP", total: 100 },
        { count: 1, currency: "SEK", total: 500 },
      ],
    });
  });

  test("a currency outside the primary set is flagged, not dropped", () => {
    expect(Bills.owedByCurrency([bill({ currency: "USD" })])).toMatchObject({
      flagged: ["USD"],
    });
  });

  test("converts with the bill's own booked rate", () => {
    expect(
      Bills.owedInNative([
        bill({
          currency: "SEK",
          due_value: "49680.0",
          exchange_rate: "0.07790244",
        }),
      ]),
    ).toBe(3870.19);
  });
});

describe("BillReader", () => {
  test("pushes the window to the endpoint, which bills support", async () => {
    // Unlike invoices, bills filter server-side. Fetching everything and
    // narrowing afterwards would pull years of history to read one month.
    const { client, http } = build([OK({ bills: [] })]);
    await new BillReader(client).list("paid", {
      from_date: "2026-07-01",
      to_date: "2026-07-31",
    });
    const url = http.requests[0]?.url ?? "";
    expect(url).toContain("from_date=2026-07-01");
    expect(url).toContain("to_date=2026-07-31");
    expect(url).toContain("view=paid");
  });

  test("openOrOverdue uses the bill-specific view", async () => {
    const { client, http } = build([OK({ bills: [] })]);
    await new BillReader(client).openOrOverdue();
    expect(http.requests[0]?.url).toContain("view=open_or_overdue");
  });

  test("resolves the chain from bill to bank transaction", async () => {
    const { client } = build([
      OK({ bills: [bill({ url: "https://bill/1" })] }),
      OK({ bank_accounts: [{ url: "https://acct/1" }] }),
      OK({
        bank_transaction_explanations: [
          {
            bank_transaction: "https://txn/2",
            paid_bill: "https://bill/1",
            url: "e",
          },
        ],
      }),
    ]);
    const [result] = await new BillReader(client).withEvidence("paid");
    expect(result?.state).toBe("evidenced");
  });

  test("negative: no bills means the bank is never queried", async () => {
    const { client, http } = build([OK({ bills: [] })]);
    expect(await new BillReader(client).withEvidence("paid")).toEqual([]);
    expect(http.requests).toHaveLength(1);
  });
});

describe("Paging.collect", () => {
  const rows = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ url: `${prefix}${i}` }));

  test("stops on a short page", async () => {
    let calls = 0;
    const all = await Paging.collect(async () => {
      calls += 1;
      return rows(3, "a");
    }, 100);
    expect(all).toHaveLength(3);
    expect(calls).toBe(1);
  });

  test("follows full pages until a short one", async () => {
    const pages = [rows(100, "a"), rows(100, "b"), rows(5, "c")];
    let calls = 0;
    const all = await Paging.collect(async () => pages[calls++] ?? [], 100);
    expect(all).toHaveLength(205);
  });

  test("negative: an endpoint that ignores `page` stops instead of looping", async () => {
    // Bills do not document page/per_page. An endpoint returning the same
    // full page forever would hang a loop that only stops on a short page.
    let calls = 0;
    const all = await Paging.collect(async () => {
      calls += 1;
      return rows(100, "same");
    }, 100);
    expect(calls).toBe(2);
    expect(all).toHaveLength(100);
  });

  test("negative: an empty page stops immediately", async () => {
    const all = await Paging.collect(async () => [], 100);
    expect(all).toEqual([]);
  });

  test("negative: runaway pagination throws rather than silently truncating", async () => {
    let n = 0;
    expect(
      Paging.collect(async () => rows(100, `p${n++}`), 100, 3),
    ).rejects.toThrow("exceeded 3 pages");
  });
});

describe("Bills.daysOverdue", () => {
  test("counts whole days past the due date", () => {
    expect(Bills.daysOverdue(bill(), "2026-08-16")).toBe(16);
  });

  test("negative: not yet due is zero, never negative", () => {
    expect(Bills.daysOverdue(bill(), "2026-07-01")).toBe(0);
  });

  test("negative: no due date is zero, not NaN", () => {
    expect(Bills.daysOverdue(bill({ due_on: undefined }), "2026-08-16")).toBe(
      0,
    );
  });

  test("negative: an unparseable due date is zero, not NaN", () => {
    expect(
      Bills.daysOverdue(bill({ due_on: "not-a-date" }), "2026-08-16"),
    ).toBe(0);
  });
});
