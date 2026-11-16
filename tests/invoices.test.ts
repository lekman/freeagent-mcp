import { describe, expect, test } from "bun:test";

import { Invoices } from "../src/invoices";
import { Money } from "../src/money";

const invoice = (over: Record<string, unknown> = {}) => ({
  currency: "GBP",
  due_on: "2026-08-01",
  due_value: "0.0",
  paid_value: "1000.0",
  reference: "007",
  status: "Paid" as const,
  total_value: "1000.0",
  url: "https://api.freeagent.com/v2/invoices/1",
  ...over,
});

const explanation = (over: Record<string, unknown> = {}) => ({
  bank_transaction: "https://api.freeagent.com/v2/bank_transactions/9",
  paid_invoice: "https://api.freeagent.com/v2/invoices/1",
  url: "https://api.freeagent.com/v2/bank_transaction_explanations/5",
  ...over,
});

describe("Invoices.evidenceFor", () => {
  test("settled and traced to a bank transaction is evidenced", () => {
    const result = Invoices.evidenceFor(invoice(), [explanation()]);
    expect(result.state).toBe("evidenced");
    expect(result.bankTransactions).toEqual([
      "https://api.freeagent.com/v2/bank_transactions/9",
    ]);
  });

  test("negative: marked paid with nothing in the bank is only claimed", () => {
    // The rule this module exists for. paid_on is FreeAgent's opinion; a
    // report that stops there confirms a payment that was mis-explained.
    const result = Invoices.evidenceFor(invoice({ paid_on: "2026-08-02" }), []);
    expect(result.state).toBe("claimed");
    expect(result.reason).toContain("claimed, not evidenced");
  });

  test("negative: an explanation for a different invoice does not count", () => {
    const result = Invoices.evidenceFor(invoice(), [
      explanation({
        paid_invoice: "https://api.freeagent.com/v2/invoices/999",
      }),
    ]);
    expect(result.state).toBe("claimed");
    expect(result.explanations).toHaveLength(0);
  });

  test("unsettled with no explanation is outstanding", () => {
    const result = Invoices.evidenceFor(
      invoice({ due_value: "1000.0", paid_value: "0.0", status: "Overdue" }),
      [],
    );
    expect(result.state).toBe("outstanding");
  });

  test("unsettled but partly received is part-evidenced", () => {
    const result = Invoices.evidenceFor(
      invoice({ due_value: "400.0", paid_value: "600.0", status: "Open" }),
      [explanation()],
    );
    expect(result.state).toBe("part-evidenced");
    expect(result.reason).toContain("part payment");
  });

  test("overpaid counts as settled", () => {
    expect(
      Invoices.evidenceFor(invoice({ status: "Overpaid" }), [explanation()])
        .state,
    ).toBe("evidenced");
  });

  test("negative: written-off is not settled and not evidence of payment", () => {
    // Money never arrived. Treating it as paid would overstate receipts.
    expect(
      Invoices.evidenceFor(invoice({ status: "Written-off" }), []).state,
    ).toBe("outstanding");
  });

  test("an explanation with no bank transaction yields no transaction URI", () => {
    const result = Invoices.evidenceFor(invoice(), [
      explanation({ bank_transaction: undefined }),
    ]);
    expect(result.state).toBe("evidenced");
    expect(result.bankTransactions).toEqual([]);
  });
});

describe("Invoices.daysOverdue", () => {
  test("counts whole days past the due date", () => {
    expect(Invoices.daysOverdue(invoice(), "2026-08-16")).toBe(15);
  });

  test("negative: not yet due is zero, never negative", () => {
    expect(Invoices.daysOverdue(invoice(), "2026-07-20")).toBe(0);
  });

  test("due today is zero", () => {
    expect(Invoices.daysOverdue(invoice(), "2026-08-01")).toBe(0);
  });

  test("negative: no due date is zero, not NaN", () => {
    expect(
      Invoices.daysOverdue(invoice({ due_on: undefined }), "2026-08-16"),
    ).toBe(0);
  });
});

describe("Invoices.outstandingByCurrency", () => {
  test("groups by currency and never cross-sums", () => {
    const totals = Invoices.outstandingByCurrency([
      invoice({ currency: "GBP", due_value: "100.0" }),
      invoice({ currency: "SEK", due_value: "1000.0" }),
      invoice({ currency: "GBP", due_value: "50.5" }),
    ]);
    expect(totals.totals).toEqual([
      { count: 2, currency: "GBP", total: 150.5 },
      { count: 1, currency: "SEK", total: 1000 },
    ]);
    expect(totals.flagged).toEqual([]);
  });

  test("a currency outside the primary set is counted and flagged, not dropped", () => {
    // Halting would make the report permanently unavailable; dropping would
    // understate what is owed. Neither is acceptable, so it is flagged.
    const totals = Invoices.outstandingByCurrency([
      invoice({ currency: "USD", due_value: "80.0" }),
    ]);
    expect(totals.flagged).toEqual(["USD"]);
    expect(totals.totals).toEqual([{ count: 1, currency: "USD", total: 80 }]);
  });

  test("converts with the ledger's own booked rate, never an invented one", () => {
    // 0.07768136 GBP per SEK is what FreeAgent booked on this invoice.
    expect(
      Invoices.outstandingInNative([
        invoice({
          currency: "SEK",
          due_value: "173558.7",
          exchange_rate: "0.07768136",
        }),
      ]),
    ).toBe(13482.28);
  });

  test("a document with no rate is already in native currency", () => {
    expect(
      Invoices.outstandingInNative([
        invoice({ currency: "GBP", due_value: "100.0" }),
      ]),
    ).toBe(100);
  });

  test("negative: a missing due_value halts rather than reading as zero", () => {
    expect(() =>
      Invoices.outstandingByCurrency([invoice({ due_value: undefined })]),
    ).toThrow("refusing to read it as zero");
  });
});

describe("Money", () => {
  test("float error does not accumulate across a total", () => {
    const totals = Money.totalByCurrency([
      { currency: "GBP", value: 0.1 },
      { currency: "GBP", value: 0.2 },
    ]);
    expect(totals[0]?.total).toBe(0.3);
  });

  test("negative: an unparseable value throws", () => {
    expect(() => Money.parse("not-a-number")).toThrow("unparseable");
  });

  test("negative: empty string is missing, not zero", () => {
    expect(() => Money.parse("")).toThrow("refusing to read it as zero");
  });

  test("parses the API's decimal strings", () => {
    expect(Money.parse("1234.56")).toBe(1234.56);
  });

  test("GBP and SEK are both primary — neither is the exception", () => {
    // SEK is what most sales are invoiced in, so treating it as a special
    // case of a GBP default understated how routine it is.
    expect(Money.assertPrimary("SEK")).toBe("SEK");
    expect(Money.assertPrimary("GBP")).toBe("GBP");
  });

  test("negative: assertPrimary still refuses, for callers needing one currency", () => {
    expect(() => Money.assertPrimary("EUR")).toThrow("outside the primary set");
  });

  test("negative: a zero or negative exchange rate throws", () => {
    expect(() => Money.toNative(100, "0")).toThrow("must be positive");
  });
});
