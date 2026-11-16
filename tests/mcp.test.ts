import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FreeAgentClient } from "../src/client";
import { loadEnvFile, registerTimesheetTools } from "../src/mcp";
import { TimesheetWriter } from "../src/timesheets";
import { HttpMock } from "./mocks/http.mock";
import { TokenStoreMock } from "./mocks/token-store.mock";

const NOW = 1_800_000_000;
const OK = (body: unknown) => ({ body: JSON.stringify(body), status: 200 });
const CONFIG = {
  clients: { Acme: { project: "https://p/acme", task: "https://t/acme" } },
  holidays: [] as string[],
  user: "https://api.freeagent.com/v2/users/1",
  workingDays: [1, 2, 3, 4, 5],
};

async function connect(responses: { body: string; status: number }[]) {
  const http = new HttpMock(responses);
  const api = new FreeAgentClient({
    credentials: { clientId: "id", clientSecret: "secret" },
    http,
    now: () => NOW,
    tokens: new TokenStoreMock({ access_token: "c", expires_at: NOW + 3600 }),
  });
  const server = new McpServer({ name: "freeagent", version: "test" });
  registerTimesheetTools(server, {
    writer: () => new TimesheetWriter(api, CONFIG),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "test" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ arguments: args, name });
    const content = r.content as { text: string }[];
    return { body: JSON.parse(content[0]?.text ?? "null"), isError: r.isError };
  };
  return { call, client, http };
}

describe("MCP timesheet tools", () => {
  test("lists the four tools, with show and plan read-only", async () => {
    const { client } = await connect([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "timesheets_apply",
      "timesheets_describe",
      "timesheets_plan",
      "timesheets_show",
    ]);
    const ro = tools.filter((t) => t.annotations?.readOnlyHint);
    expect(ro.map((t) => t.name).sort()).toEqual([
      "timesheets_plan",
      "timesheets_show",
    ]);
  });

  test("show reports the timeslips without a description", async () => {
    const { call } = await connect([
      OK({
        timeslips: [
          { comment: "Done", dated_on: "2026-08-17" },
          { dated_on: "2026-08-18" },
        ],
      }),
    ]);
    const { body } = await call("timesheets_show", {
      from: "2026-08-17",
      to: "2026-08-18",
    });
    expect(body.slips).toHaveLength(2);
    expect(body.undescribed).toEqual([{ dated_on: "2026-08-18" }]);
  });

  test("plan writes nothing", async () => {
    const { call, http } = await connect([OK({ timeslips: [] })]);
    const { body } = await call("timesheets_plan", {
      from: "2026-08-17",
      hours: { Acme: 40 },
      to: "2026-08-21",
    });
    expect(body.toCreate).toHaveLength(5);
    expect(http.requests.every((r) => r.method === "GET")).toBe(true);
  });

  test("negative: apply writes nothing when a recorded day conflicts", async () => {
    const { call, http } = await connect([
      OK({
        timeslips: [
          {
            dated_on: "2026-08-17",
            hours: "6.0",
            project: "https://p/acme",
            url: "u1",
          },
        ],
      }),
    ]);
    const r = await call("timesheets_apply", {
      from: "2026-08-17",
      hours: { Acme: 40 },
      to: "2026-08-21",
    });
    expect(r.isError).toBe(true);
    expect(r.body.created).toBe(0);
    expect(http.requests.filter((q) => q.method === "POST")).toHaveLength(0);
  });

  test("negative: an unknown client is a tool error, not a crash", async () => {
    const { call, http } = await connect([]);
    const r = await call("timesheets_plan", {
      from: "2026-08-17",
      hours: { Initech: 8 },
      to: "2026-08-21",
    }).catch(() => ({ body: null, isError: true }));
    expect(r.isError).toBe(true);
    expect(http.requests).toHaveLength(0);
  });
});

describe("loadEnvFile", () => {
  test("loads KEY=VALUE lines, strips quotes and export, never overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "fa-env-"));
    const path = join(dir, ".env");
    writeFileSync(
      path,
      "# comment\nexport A=\"one\"\nB=two\nC='three'\nbad line\nA2=x=y\n",
    );
    const env: NodeJS.ProcessEnv = { B: "kept" };
    expect(loadEnvFile(path, env)).toBe(3);
    expect(env).toEqual({ A: "one", A2: "x=y", B: "kept", C: "three" });
  });

  test("a missing file loads nothing", () => {
    expect(loadEnvFile("/nonexistent/.env", {})).toBe(0);
  });
});
