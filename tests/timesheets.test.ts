import { describe, expect, test } from "bun:test";

import { FreeAgentClient } from "../src/client";
import { Config } from "../src/config";
import { Timesheets, TimesheetWriter } from "../src/timesheets";
import { HttpMock } from "./mocks/http.mock";
import { TokenStoreMock } from "./mocks/token-store.mock";

const NOW = 1_800_000_000;
const OK = (body: unknown) => ({ body: JSON.stringify(body), status: 200 });

const CONFIG = {
  clients: {
    Acme: { project: "https://p/acme", task: "https://t/acme" },
    Globex: { project: "https://p/globex", task: "https://t/globex" },
  },
  holidays: [] as string[],
  user: "https://api.freeagent.com/v2/users/1",
  workingDays: [1, 2, 3, 4, 5],
};

const build = (responses: { body: string; status: number }[]) => {
  const http = new HttpMock(responses);
  const client = new FreeAgentClient({
    credentials: { clientId: "id", clientSecret: "secret" },
    http,
    now: () => NOW,
    tokens: new TokenStoreMock({ access_token: "c", expires_at: NOW + 3600 }),
  });
  return { http, writer: new TimesheetWriter(client, CONFIG) };
};

describe("Timesheets.spread", () => {
  test("40 hours over 5 days is 8 each", () => {
    expect(Timesheets.spread(40, 5)).toEqual([8, 8, 8, 8, 8]);
  });

  test("an uneven split still totals exactly", () => {
    // These hours are billed, so the parts must sum to the whole.
    const parts = Timesheets.spread(40, 3);
    expect(parts).toEqual([13.34, 13.33, 13.33]);
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(40, 10);
  });

  test("fractional totals survive", () => {
    expect(Timesheets.spread(37.5, 5)).toEqual([7.5, 7.5, 7.5, 7.5, 7.5]);
  });
});

describe("Timesheets.plan", () => {
  const plan = (
    hours: number,
    existing: unknown[] = [],
    from = "2026-08-17",
    to = "2026-08-23",
  ) =>
    Timesheets.plan(
      CONFIG,
      "Acme",
      "https://p/acme",
      "https://t/acme",
      from,
      to,
      hours,
      existing as never,
    );

  test("spreads across working days and skips the weekend", () => {
    const p = plan(40);
    expect(p.toCreate).toHaveLength(5);
    expect(p.toCreate.map((s) => s.dated_on)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
    ]);
    expect(p.skipped.map((s) => s.date)).toEqual(["2026-08-22", "2026-08-23"]);
    expect(p.totals["Acme"]).toBe(40);
  });

  test("negative: a re-run creates nothing", () => {
    // Blind-POSTing a second time would double the week and the invoice.
    const first = plan(40);
    const existing = first.toCreate.map((s) => ({
      dated_on: s.dated_on,
      hours: "8.0",
      project: "https://p/acme",
      url: `u${s.dated_on}`,
    }));
    const second = plan(40, existing);
    expect(second.toCreate).toHaveLength(0);
    expect(second.alreadyPresent).toHaveLength(5);
    expect(second.totals["Acme"]).toBe(0);
  });

  test("negative: different hours on a day is a conflict, never an overwrite", () => {
    // A corrected day must not be silently un-corrected.
    const p = plan(40, [
      {
        dated_on: "2026-08-18",
        hours: "4.0",
        project: "https://p/acme",
        url: "u1",
      },
    ]);
    expect(p.conflicts).toHaveLength(1);
    expect(p.conflicts[0]?.existing.hours).toBe("4.0");
    expect(p.toCreate).toHaveLength(4);
  });

  test("negative: another project's entry on the same day is not a clash", () => {
    const p = plan(40, [
      {
        dated_on: "2026-08-18",
        hours: "8.0",
        project: "https://p/globex",
        url: "u1",
      },
    ]);
    expect(p.toCreate).toHaveLength(5);
    expect(p.conflicts).toHaveLength(0);
  });

  test("holidays are skipped and the hours land on the remaining days", () => {
    const withHoliday = { ...CONFIG, holidays: ["2026-08-19"] };
    const p = Timesheets.plan(
      withHoliday,
      "Acme",
      "https://p/acme",
      "https://t/acme",
      "2026-08-17",
      "2026-08-23",
      40,
      [],
    );
    expect(p.toCreate).toHaveLength(4);
    expect(p.toCreate.map((s) => s.hours)).toEqual([10, 10, 10, 10]);
    expect(p.skipped.find((s) => s.date === "2026-08-19")?.reason).toBe(
      "holiday",
    );
  });

  test("negative: a window with no working days throws", () => {
    expect(() => plan(40, [], "2026-08-22", "2026-08-23")).toThrow(
      "no working days",
    );
  });
});

describe("Config.clientMapping", () => {
  test("resolves a known label, case-insensitively", () => {
    expect(Config.clientMapping(CONFIG, "acme").project).toBe("https://p/acme");
  });

  test("negative: an unknown client throws and names what is configured", () => {
    // No fallback project: hours on the wrong contract become a wrong invoice.
    expect(() => Config.clientMapping(CONFIG, "Initech")).toThrow(
      "Acme, Globex",
    );
  });

  test("negative: config without a task is rejected at parse", () => {
    expect(() =>
      Config.parse({ user: "u", clients: { X: { project: "p" } } }),
    ).toThrow("needs both project and task");
  });

  test("negative: config without a user is rejected", () => {
    expect(() => Config.parse({ clients: {} })).toThrow("`user` must be");
  });

  test("negative: a non-object config is rejected", () => {
    expect(() => Config.parse("not json")).toThrow("not an object");
    expect(() => Config.parse(null)).toThrow("not an object");
  });

  test("negative: clients must be an object of mappings", () => {
    expect(() => Config.parse({ user: "u", clients: [] })).toThrow(
      "label -> {project, task}",
    );
    expect(() => Config.parse({ user: "u" })).toThrow(
      "label -> {project, task}",
    );
  });

  test("defaults fill only what is safe to default", () => {
    // Working days and holidays have obvious defaults; project and task do not,
    // which is why those throw instead.
    const parsed = Config.parse({ user: "u", clients: {} });
    expect(parsed.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.holidays).toEqual([]);
  });

  test("an explicit holiday list is kept", () => {
    expect(
      Config.parse({ user: "u", clients: {}, holidays: ["2026-12-25"] })
        .holidays,
    ).toEqual(["2026-12-25"]);
  });

  test("negative: an empty working-day list falls back rather than booking nothing", () => {
    expect(
      Config.parse({ user: "u", clients: {}, workingDays: [] }).workingDays,
    ).toEqual([1, 2, 3, 4, 5]);
  });

  test("an explicit working-day set overrides the default", () => {
    expect(
      Config.parse({ user: "u", clients: {}, workingDays: [1, 2, 3] })
        .workingDays,
    ).toEqual([1, 2, 3]);
  });

  test("negative: an empty client map says so rather than naming nothing", () => {
    expect(() =>
      Config.clientMapping({ ...CONFIG, clients: {} }, "Acme"),
    ).toThrow("(none)");
  });
});

describe("TimesheetWriter", () => {
  test("reads the range before planning anything", async () => {
    const { http, writer } = build([OK({ timeslips: [] })]);
    await writer.plan("Acme", "2026-08-17", "2026-08-21", 40);
    expect(http.requests[0]?.method).toBe("GET");
    expect(http.requests[0]?.url).toContain("from_date=2026-08-17");
  });

  test("negative: an unmapped client never reaches the network", async () => {
    const { http, writer } = build([]);
    expect(
      writer.plan("Initech", "2026-08-17", "2026-08-21", 40),
    ).rejects.toThrow("no configuration for client");
    expect(http.requests).toHaveLength(0);
  });

  test("apply writes exactly the plan it was given", async () => {
    const { http, writer } = build([
      OK({ timeslips: [] }),
      ...Array.from({ length: 5 }, () => OK({ timeslip: { url: "new" } })),
    ]);
    const plan = await writer.plan("Acme", "2026-08-17", "2026-08-21", 40);
    const created = await writer.apply(plan);
    expect(created).toHaveLength(5);
    const posts = http.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(5);
    const first = JSON.parse(posts[0]?.body ?? "{}").timeslip;
    expect(first).toMatchObject({
      dated_on: "2026-08-17",
      hours: "8.00",
      project: "https://p/acme",
      task: "https://t/acme",
      user: CONFIG.user,
    });
  });

  test("negative: applying a plan with nothing to create writes nothing", async () => {
    const existing = [
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
    ].map((d) => ({
      dated_on: d,
      hours: "8.0",
      project: "https://p/acme",
      url: `u${d}`,
    }));
    const { http, writer } = build([OK({ timeslips: existing })]);
    const plan = await writer.plan("Acme", "2026-08-17", "2026-08-21", 40);
    await writer.apply(plan);
    expect(http.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  test("describe writes only the comment, to the matching timeslip", async () => {
    const slips = [
      {
        dated_on: "2026-08-17",
        hours: "8.0",
        project: "https://p/acme",
        url: "https://api.freeagent.com/v2/timeslips/11",
      },
      {
        dated_on: "2026-08-17",
        hours: "8.0",
        project: "https://p/globex",
        url: "https://api.freeagent.com/v2/timeslips/12",
      },
    ];
    const { http, writer } = build([
      OK({ timeslips: slips }),
      OK({ timeslip: { ...slips[1], comment: "Release work" } }),
    ]);
    const updated = await writer.describe([
      { client: "Globex", comment: " Release work ", date: "2026-08-17" },
    ]);
    expect(updated).toHaveLength(1);
    const put = http.requests.find((r) => r.method === "PUT");
    expect(put?.url).toBe("https://api.freeagent.com/v2/timeslips/12");
    expect(JSON.parse(put?.body ?? "{}")).toEqual({
      timeslip: { comment: "Release work" },
    });
  });

  test("negative: describe writes nothing when a day has no timeslip", async () => {
    const { http, writer } = build([OK({ timeslips: [] })]);
    expect(
      writer.describe([
        { client: "Acme", comment: "Work", date: "2026-08-17" },
      ]),
    ).rejects.toThrow("expected one timeslip, found 0");
    await Bun.sleep(0);
    expect(http.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  test("negative: an empty description never reaches the network", async () => {
    const { http, writer } = build([]);
    expect(
      writer.describe([{ client: "Acme", comment: " ", date: "2026-08-17" }]),
    ).rejects.toThrow("the description is empty");
    expect(http.requests).toHaveLength(0);
  });

  test("undescribed lists timeslips with no or a blank comment", () => {
    const missing = TimesheetWriter.undescribed([
      { comment: "Done", dated_on: "2026-08-17" },
      { comment: "  ", dated_on: "2026-08-18" },
      { dated_on: "2026-08-19" },
    ]);
    expect(missing.map((s) => s.dated_on)).toEqual([
      "2026-08-18",
      "2026-08-19",
    ]);
  });

  test("merge combines two clients into one grid", () => {
    const a = Timesheets.plan(
      CONFIG,
      "Acme",
      "https://p/acme",
      "https://t/acme",
      "2026-08-17",
      "2026-08-21",
      40,
      [],
    );
    const b = Timesheets.plan(
      CONFIG,
      "Globex",
      "https://p/globex",
      "https://t/globex",
      "2026-08-17",
      "2026-08-21",
      40,
      [],
    );
    const merged = TimesheetWriter.merge([a, b]);
    expect(merged.toCreate).toHaveLength(10);
    expect(merged.totals).toEqual({ Acme: 40, Globex: 40 });
    expect(merged.skipped).toHaveLength(0);
  });
});
