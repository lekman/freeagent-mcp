import { describe, expect, test } from "bun:test";

import { ClientFactory, FreeAgentClient } from "../src/client";
import { HttpMock } from "./mocks/http.mock";
import { TokenStoreMock } from "./mocks/token-store.mock";

const NOW = 1_800_000_000;
const CREDENTIALS = { clientId: "id", clientSecret: "secret" };

const build = (
  responses: { body: string; status: number }[],
  cache = {},
): { client: FreeAgentClient; http: HttpMock; tokens: TokenStoreMock } => {
  const http = new HttpMock(responses);
  const tokens = new TokenStoreMock(cache);
  const client = new FreeAgentClient({
    credentials: CREDENTIALS,
    http,
    now: () => NOW,
    tokens,
  });
  return { client, http, tokens };
};

const OK = (body: unknown) => ({ body: JSON.stringify(body), status: 200 });
const TOKEN = OK({ access_token: "fresh", expires_in: 3600 });

describe("FreeAgentClient.accessToken", () => {
  test("reuses a live cached token without calling the network", async () => {
    const { client, http } = build([], {
      access_token: "cached",
      expires_at: NOW + 3600,
    });
    expect(await client.accessToken()).toBe("cached");
    expect(http.requests).toHaveLength(0);
  });

  test("refreshes an expired token and persists the result", async () => {
    // The live cache had expired five days before the port ran; this is that
    // case, and it must self-heal without re-authorisation.
    const { client, http, tokens } = build([TOKEN], {
      access_token: "stale",
      expires_at: NOW - 432_000,
      refresh_token: "r",
    });
    expect(await client.accessToken()).toBe("fresh");
    expect(http.requests[0]?.url).toBe(
      "https://api.freeagent.com/v2/token_endpoint",
    );
    expect(http.requests[0]?.body).toContain("grant_type=refresh_token");
    expect(tokens.writes).toHaveLength(1);
    expect(tokens.cache.expires_at).toBe(NOW + 3600);
    expect(tokens.cache.refresh_token).toBe("r");
  });

  test("refreshes using the cache alone when no env token is set", async () => {
    const { client } = build([TOKEN], { refresh_token: "from-cache" });
    expect(await client.accessToken()).toBe("fresh");
  });

  test("negative: no refresh token anywhere names the remedy", async () => {
    const { client } = build([]);
    expect(client.accessToken()).rejects.toThrow("no refresh token");
  });

  test("negative: a rejected refresh does not overwrite the cache", async () => {
    const { client, tokens } = build([{ body: "invalid_grant", status: 401 }], {
      refresh_token: "revoked",
    });
    expect(client.accessToken()).rejects.toThrow("401");
    // A revoked credential must leave the old cache intact, not blank it.
    expect(tokens.writes).toHaveLength(0);
  });
});

describe("FreeAgentClient.request", () => {
  test("sends the bearer token and decodes the body", async () => {
    const { client, http } = build([OK({ user: { url: "u" } })], {
      access_token: "cached",
      expires_at: NOW + 3600,
    });
    const body = await client.request<{ user: { url: string } }>({
      path: "/v2/users/me",
    });
    expect(body.user.url).toBe("u");
    expect(http.requests[0]?.headers["Authorization"]).toBe("Bearer cached");
    expect(http.requests[0]?.method).toBe("GET");
  });

  test("builds query strings and drops undefined values", async () => {
    const { client, http } = build([OK([])], {
      access_token: "c",
      expires_at: NOW + 3600,
    });
    await client.request({
      path: "/v2/invoices",
      query: { nested: undefined, per_page: 100, view: "overdue" },
    });
    const url = http.requests[0]?.url ?? "";
    expect(url).toContain("view=overdue");
    expect(url).toContain("per_page=100");
    expect(url).not.toContain("nested");
  });

  test("refreshes first, then sends the request with the new token", async () => {
    const { client, http } = build([TOKEN, OK({ ok: true })], {
      refresh_token: "r",
    });
    await client.request({ path: "/v2/users/me" });
    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]?.headers["Authorization"]).toBe("Bearer fresh");
  });

  test("sets a JSON content type only when there is a payload", async () => {
    const { client, http } = build([OK({}), OK({})], {
      access_token: "c",
      expires_at: NOW + 3600,
    });
    await client.request({ path: "/v2/expenses" });
    expect(http.requests[0]?.headers["Content-Type"]).toBeUndefined();
    await client.request({
      method: "POST",
      path: "/v2/expenses",
      payload: { expense: {} },
    });
    expect(http.requests[1]?.headers["Content-Type"]).toBe("application/json");
  });

  test("an empty 200 body decodes as an empty object", async () => {
    const { client } = build([{ body: "", status: 200 }], {
      access_token: "c",
      expires_at: NOW + 3600,
    });
    expect(
      await client.request<Record<string, unknown>>({ path: "/v2/anything" }),
    ).toEqual({});
  });

  test("negative: a non-2xx response throws with method, path and body", async () => {
    const { client } = build([{ body: "Not Found", status: 404 }], {
      access_token: "c",
      expires_at: NOW + 3600,
    });
    expect(client.request({ path: "/v2/nope" })).rejects.toThrow(
      "GET /v2/nope -> 404: Not Found",
    );
  });

  test("the default clock is the real one, in seconds not milliseconds", async () => {
    // Every other test injects `now`, so the production default would
    // otherwise never run. A millisecond clock here would read as an expiry
    // a thousand times too far away and no token would ever refresh.
    const http = new HttpMock([OK({})]);
    const client = new FreeAgentClient({
      credentials: CREDENTIALS,
      http,
      tokens: new TokenStoreMock({
        access_token: "c",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
    await client.request({ path: "/v2/users/me" });
    expect(http.requests[0]?.headers["Authorization"]).toBe("Bearer c");
  });

  test("a trailing slash on the base URL does not double up", async () => {
    const http = new HttpMock([OK({})]);
    const client = new FreeAgentClient({
      baseUrl: "https://api.sandbox.freeagent.com/",
      credentials: CREDENTIALS,
      http,
      now: () => NOW,
      tokens: new TokenStoreMock({ access_token: "c", expires_at: NOW + 3600 }),
    });
    await client.request({ path: "/v2/users/me" });
    expect(http.requests[0]?.url).toBe(
      "https://api.sandbox.freeagent.com/v2/users/me",
    );
  });
});

describe("ClientFactory.fromEnvironment", () => {
  const env = (values: Record<string, string>) => ({
    get: (name: string) => values[name],
  });

  test("negative: a missing client id fails at construction, not at 401", async () => {
    expect(() =>
      ClientFactory.fromEnvironment(env({ FREEAGENT_CLIENT_SECRET: "s" })),
    ).toThrow("FREEAGENT_CLIENT_ID");
  });

  test("negative: a missing secret fails the same way", () => {
    expect(() =>
      ClientFactory.fromEnvironment(env({ FREEAGENT_CLIENT_ID: "i" })),
    ).toThrow("FREEAGENT_CLIENT_SECRET");
  });

  test("builds a client when both credentials are present", () => {
    const client = ClientFactory.fromEnvironment(
      env({ FREEAGENT_CLIENT_ID: "i", FREEAGENT_CLIENT_SECRET: "s" }),
    );
    expect(client).toBeInstanceOf(FreeAgentClient);
  });
});
