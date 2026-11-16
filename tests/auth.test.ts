import { describe, expect, test } from "bun:test";

import { Auth } from "../src/auth";

const CREDENTIALS = { clientId: "id", clientSecret: "secret" };
const NOW = 1_800_000_000;

describe("Auth.isUsable", () => {
  test("a token well inside its lifetime is usable", () => {
    expect(
      Auth.isUsable({ access_token: "t", expires_at: NOW + 600 }, NOW),
    ).toBe(true);
  });

  test("negative: a token inside the leeway window is not usable", () => {
    // 119s left, leeway is 120s: refresh rather than risk a request that
    // starts valid and completes expired.
    expect(
      Auth.isUsable({ access_token: "t", expires_at: NOW + 119 }, NOW),
    ).toBe(false);
  });

  test("negative: an expiry with no token is not usable", () => {
    expect(Auth.isUsable({ expires_at: NOW + 9999 }, NOW)).toBe(false);
  });

  test("negative: an empty cache is not usable", () => {
    expect(Auth.isUsable({}, NOW)).toBe(false);
  });
});

describe("Auth.nextCache", () => {
  test("expiry is now plus the stated lifetime, in whole seconds", () => {
    const next = Auth.nextCache(
      {},
      { access_token: "new", expires_in: 3600 },
      NOW,
    );
    expect(next.expires_at).toBe(NOW + 3600);
    expect(next.access_token).toBe("new");
  });

  test("a fractional clock still writes an integer expiry", () => {
    const next = Auth.nextCache({}, { access_token: "new" }, NOW + 0.75);
    expect(Number.isInteger(next.expires_at)).toBe(true);
  });

  test("keeps the old refresh token when the response omits one", () => {
    const next = Auth.nextCache(
      { refresh_token: "keep-me" },
      { access_token: "new" },
      NOW,
    );
    // Dropping it would strand the machine at the next expiry.
    expect(next.refresh_token).toBe("keep-me");
  });

  test("takes a rotated refresh token when the response carries one", () => {
    const next = Auth.nextCache(
      { refresh_token: "old" },
      { access_token: "new", refresh_token: "rotated" },
      NOW,
    );
    expect(next.refresh_token).toBe("rotated");
  });

  test("defaults to an hour when expires_in is absent", () => {
    expect(Auth.nextCache({}, { access_token: "n" }, NOW).expires_at).toBe(
      NOW + 3600,
    );
  });
});

describe("Auth.refreshTokenFor", () => {
  test("the environment wins over the cache", () => {
    const value = Auth.refreshTokenFor(
      { ...CREDENTIALS, refreshToken: "from-env" },
      { refresh_token: "from-cache" },
    );
    // A deliberately rotated credential must beat a stale copy on disk.
    expect(value).toBe("from-env");
  });

  test("falls back to the cache so no env entry is needed", () => {
    expect(
      Auth.refreshTokenFor(CREDENTIALS, { refresh_token: "from-cache" }),
    ).toBe("from-cache");
  });

  test("negative: null when neither source has one", () => {
    expect(Auth.refreshTokenFor(CREDENTIALS, {})).toBeNull();
  });
});

describe("Auth.parseTokenResponse", () => {
  test("returns the token on success", () => {
    const parsed = Auth.parseTokenResponse(
      200,
      JSON.stringify({ access_token: "t", expires_in: 60 }),
    );
    expect(parsed).toEqual({ access_token: "t", expires_in: 60 });
  });

  test("negative: a non-2xx status throws with the body", () => {
    expect(() => Auth.parseTokenResponse(401, "denied")).toThrow("401");
  });

  test("negative: unparseable JSON throws", () => {
    expect(() => Auth.parseTokenResponse(200, "<html>")).toThrow("unparseable");
  });

  test("negative: a 200 with no access_token throws", () => {
    // Writing a partial token to the cache fails later, further from the cause.
    expect(() => Auth.parseTokenResponse(200, "{}")).toThrow("no access_token");
  });
});

describe("Auth request shaping", () => {
  test("basic auth header encodes id and secret", () => {
    expect(Auth.basicAuthHeader(CREDENTIALS)).toBe(
      `Basic ${Buffer.from("id:secret").toString("base64")}`,
    );
  });

  test("refresh body carries the grant type and token", () => {
    expect(Auth.refreshBody("r")).toBe(
      "grant_type=refresh_token&refresh_token=r",
    );
  });

  test("authorize URL targets approve_app with the redirect", () => {
    const url = Auth.authorizeUrl("https://api.freeagent.com", "cid");
    expect(url).toContain("/v2/approve_app?");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("response_type=code");
    expect(url).toContain(encodeURIComponent("http://localhost:8923/callback"));
  });

  test("exchange body carries the code and grant type", () => {
    expect(Auth.exchangeBody("abc")).toContain("grant_type=authorization_code");
    expect(Auth.exchangeBody("abc")).toContain("code=abc");
  });
});
