import type { OAuthCredentials, TokenCache, TokenResponse } from "./types.ts";

/**
 * Seconds before stated expiry at which a token counts as spent. A request
 * that starts inside the leeway can still be in flight when the token dies,
 * so the margin is the difference between a refresh and a 401.
 */
const TOKEN_LEEWAY_SECONDS = 120;

/** Lifetime assumed when the token endpoint omits `expires_in`. */
const DEFAULT_LIFETIME_SECONDS = 3600;

/** Authorisation redirect target registered with the OAuth app. */
const DEFAULT_REDIRECT_URI = "http://localhost:8923/callback";

/**
 * Pure OAuth logic: expiry decisions, URL and form construction, response
 * validation. No I/O — the token store and HTTP client are ports, so every
 * rule here is testable by passing values in.
 */
export class Auth {
  /** Authorisation URL the operator opens to approve the app. */
  static authorizeUrl(
    baseUrl: string,
    clientId: string,
    redirectUri: string = DEFAULT_REDIRECT_URI,
  ): string {
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
    });
    return `${baseUrl}/v2/approve_app?${query.toString()}`;
  }

  /** HTTP Basic header for the token endpoint. */
  static basicAuthHeader(credentials: OAuthCredentials): string {
    const raw = `${credentials.clientId}:${credentials.clientSecret}`;
    return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }

  /** Form body swapping an authorisation code for tokens. */
  static exchangeBody(
    code: string,
    redirectUri = DEFAULT_REDIRECT_URI,
  ): string {
    return new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }).toString();
  }

  /**
   * Whether the cached access token can still be used. False when absent, and
   * false once inside the leeway window — the caller then refreshes.
   */
  static isUsable(cache: TokenCache, nowSeconds: number): boolean {
    if (!cache.access_token) return false;
    return (cache.expires_at ?? 0) - TOKEN_LEEWAY_SECONDS > nowSeconds;
  }

  /**
   * Merge a token response into the cache. The refresh token is preserved
   * when the response omits one: FreeAgent does not always rotate it, and
   * dropping it would strand the machine at the next expiry.
   */
  static nextCache(
    previous: TokenCache,
    response: TokenResponse,
    nowSeconds: number,
  ): TokenCache {
    return {
      access_token: response.access_token,
      expires_at:
        Math.floor(nowSeconds) +
        (response.expires_in ?? DEFAULT_LIFETIME_SECONDS),
      refresh_token: response.refresh_token ?? previous.refresh_token,
    };
  }

  /**
   * Validate a token endpoint body. Throws rather than returning a partial
   * token: a cache written from a malformed response fails later, somewhere
   * further from the cause.
   */
  static parseTokenResponse(status: number, body: string): TokenResponse {
    if (status < 200 || status >= 300) {
      throw new Error(`token endpoint returned ${status}: ${body}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`token endpoint returned unparseable JSON: ${body}`);
    }
    const candidate = parsed as Partial<TokenResponse>;
    if (typeof candidate.access_token !== "string") {
      throw new Error("token endpoint response has no access_token");
    }
    return {
      access_token: candidate.access_token,
      ...(typeof candidate.expires_in === "number"
        ? { expires_in: candidate.expires_in }
        : {}),
      ...(typeof candidate.refresh_token === "string"
        ? { refresh_token: candidate.refresh_token }
        : {}),
    };
  }

  /** Form body renewing an access token. */
  static refreshBody(refreshToken: string): string {
    return new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString();
  }

  /**
   * The refresh token to present, preferring the environment over the cache
   * so a deliberately rotated credential wins over a stale copy on disk.
   */
  static refreshTokenFor(
    credentials: OAuthCredentials,
    cache: TokenCache,
  ): string | null {
    return credentials.refreshToken ?? cache.refresh_token ?? null;
  }
}
