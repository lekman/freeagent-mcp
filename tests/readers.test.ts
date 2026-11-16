import { describe, expect, test } from "bun:test";

import { BankReader } from "../src/banking";
import { FreeAgentClient } from "../src/client";
import { InvoiceReader } from "../src/invoices";
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

// Distinct URLs per page. Repeating them would trip Paging's stall guard,
// which is what a real endpoint ignoring `page` looks like.
const page = (n: number, key: string, tag = "a") =>
  OK({ [key]: Array.from({ length: n }, (_, i) => ({ url: `${tag}${i}` })) });

describe("InvoiceReader.list", () => {
  test("sends the view as the API's own filter", async () => {
    const { client, http } = build([OK({ invoices: [{ url: "u1" }] })]);
    await new InvoiceReader(client).list("overdue");
    expect(http.requests[0]?.url).toContain("view=overdue");
    expect(http.requests[0]?.url).toContain("/v2/invoices");
  });

  test("openOrOverdue uses the combined view, not two calls", async () => {
    const { client, http } = build([OK({ invoices: [] })]);
    await new InvoiceReader(client).openOrOverdue();
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.url).toContain("view=open_or_overdue");
  });

  test("follows pagination to the end", async () => {
    // A full first page means there may be more. Stopping there would
    // under-report the chase list, which reads as "less is owed".
    const { client, http } = build([
      page(100, "invoices", "p1-"),
      page(100, "invoices", "p2-"),
      page(7, "invoices", "p3-"),
    ]);
    const invoices = await new InvoiceReader(client).list();
    expect(invoices).toHaveLength(207);
    expect(http.requests).toHaveLength(3);
    expect(http.requests[2]?.url).toContain("page=3");
  });

  test("negative: a short first page stops after one request", async () => {
    const { client, http } = build([page(3, "invoices")]);
    await new InvoiceReader(client).list();
    expect(http.requests).toHaveLength(1);
  });

  test("negative: a body with no invoices key yields an empty list", async () => {
    const { client } = build([OK({})]);
    expect(await new InvoiceReader(client).list()).toEqual([]);
  });
});

describe("BankReader.explanations", () => {
  test("scopes the listing to the account, as the API requires", async () => {
    const { client, http } = build([OK({ bank_transaction_explanations: [] })]);
    await new BankReader(client).explanations("https://acct/1", {
      from_date: "2026-01-01",
      to_date: "2026-08-16",
    });
    const url = http.requests[0]?.url ?? "";
    expect(url).toContain("bank_account=");
    expect(url).toContain("from_date=2026-01-01");
    expect(url).toContain("to_date=2026-08-16");
  });

  test("walks every account, not just the first", async () => {
    // Explanations cannot be listed company-wide. Checking one account would
    // silently miss any invoice settled into another.
    const { client, http } = build([
      OK({
        bank_accounts: [{ url: "https://acct/1" }, { url: "https://acct/2" }],
      }),
      OK({ bank_transaction_explanations: [{ url: "e1" }] }),
      OK({ bank_transaction_explanations: [{ url: "e2" }] }),
    ]);
    const all = await new BankReader(client).explanationsEverywhere();
    expect(all).toHaveLength(2);
    expect(http.requests[1]?.url).toContain("acct%2F1");
    expect(http.requests[2]?.url).toContain("acct%2F2");
  });
});

describe("InvoiceReader.withEvidence", () => {
  test("resolves the chain from invoice to bank transaction", async () => {
    const { client } = build([
      OK({ invoices: [{ status: "Paid", url: "https://inv/1" }] }),
      OK({ bank_accounts: [{ url: "https://acct/1" }] }),
      OK({
        bank_transaction_explanations: [
          {
            bank_transaction: "https://txn/9",
            paid_invoice: "https://inv/1",
            url: "e1",
          },
        ],
      }),
    ]);
    const [result] = await new InvoiceReader(client).withEvidence("paid");
    expect(result?.state).toBe("evidenced");
    expect(result?.bankTransactions).toEqual(["https://txn/9"]);
  });

  test("negative: no invoices means the bank is never queried", async () => {
    // One pass over the accounts is cheap, but not free — and pointless.
    const { client, http } = build([OK({ invoices: [] })]);
    expect(await new InvoiceReader(client).withEvidence("paid")).toEqual([]);
    expect(http.requests).toHaveLength(1);
  });

  test("negative: a window bounds the invoices too, not just the evidence", async () => {
    // The bug this guards. Windowing only the explanations reported every
    // older invoice as `claimed` because its evidence was never fetched —
    // 137 false verdicts out of 151 on the first live run.
    const { client, http } = build([
      OK({
        invoices: [
          { dated_on: "2022-03-01", status: "Paid", url: "https://inv/old" },
          { dated_on: "2026-06-01", status: "Paid", url: "https://inv/new" },
        ],
      }),
      OK({ bank_accounts: [{ url: "https://acct/1" }] }),
      OK({ bank_transaction_explanations: [] }),
    ]);
    const results = await new InvoiceReader(client).withEvidence("paid", {
      from_date: "2026-05-01",
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.invoice.url).toBe("https://inv/new");
    expect(http.requests[2]?.url).toContain("from_date=2026-05-01");
  });

  test("with no window, the evidence window starts at the earliest invoice", async () => {
    const { client, http } = build([
      OK({
        invoices: [
          { dated_on: "2026-06-01", status: "Paid", url: "https://inv/2" },
          { dated_on: "2022-03-01", status: "Paid", url: "https://inv/1" },
        ],
      }),
      OK({ bank_accounts: [{ url: "https://acct/1" }] }),
      OK({ bank_transaction_explanations: [] }),
    ]);
    await new InvoiceReader(client).withEvidence("paid");
    // Earliest invoice, not earliest in list order — a payment cannot
    // precede its invoice, so that is the whole span that needs covering.
    expect(http.requests[2]?.url).toContain("from_date=2022-03-01");
  });

  test("negative: an invoice with no date is outside every closed window", async () => {
    const { client } = build([
      OK({ invoices: [{ status: "Paid", url: "https://inv/undated" }] }),
    ]);
    const results = await new InvoiceReader(client).withEvidence("paid", {
      from_date: "2026-01-01",
    });
    expect(results).toEqual([]);
  });

  test("fetches explanations once for the whole batch", async () => {
    const { client, http } = build([
      OK({
        invoices: [
          { status: "Paid", url: "https://inv/1" },
          { status: "Paid", url: "https://inv/2" },
        ],
      }),
      OK({ bank_accounts: [{ url: "https://acct/1" }] }),
      OK({ bank_transaction_explanations: [] }),
    ]);
    const results = await new InvoiceReader(client).withEvidence("paid");
    expect(results).toHaveLength(2);
    // Three calls total, not one bank walk per invoice.
    expect(http.requests).toHaveLength(3);
    expect(results.every((r) => r.state === "claimed")).toBe(true);
  });
});
