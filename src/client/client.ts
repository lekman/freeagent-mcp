import type {
  IHttpClient,
  ITokenStore,
  OAuthCredentials,
} from "../auth/index.ts";
import type { IFreeAgentClient } from "./interfaces.ts";
import type { ApiRequest } from "./types.ts";

import { Auth } from "../auth/index.ts";
import { PRODUCTION_BASE_URL } from "./types.ts";

const JSON_TYPE = "application/json";
const FORM_TYPE = "application/x-www-form-urlencoded";

/** Everything the client needs, all of it injectable for tests. */
export interface FreeAgentClientOptions {
  /** API host; the sandbox constant swaps environments. */
  baseUrl?: string;
  /** OAuth app credentials. */
  credentials: OAuthCredentials;
  /** HTTP port. */
  http: IHttpClient;
  /** Clock, in UNIX seconds. Injected so expiry logic is deterministic. */
  now?: () => number;
  /** Token cache port. */
  tokens: ITokenStore;
}

/**
 * Authenticated FreeAgent API access. All I/O arrives through ports, so the
 * token lifecycle — reuse while valid, refresh once expired, persist the
 * result — is testable with fakes and no network.
 *
 * Not a `.system.ts` file on purpose: deciding *when* to refresh is the logic
 * worth testing, and it never touches a socket or the filesystem itself.
 */
export class FreeAgentClient implements IFreeAgentClient {
  private readonly baseUrl: string;
  private readonly credentials: OAuthCredentials;
  private readonly http: IHttpClient;
  private readonly now: () => number;
  private readonly tokens: ITokenStore;

  constructor(options: FreeAgentClientOptions) {
    this.baseUrl = (options.baseUrl ?? PRODUCTION_BASE_URL).replace(/\/+$/, "");
    this.credentials = options.credentials;
    this.http = options.http;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.tokens = options.tokens;
  }

  /**
   * A usable bearer token: the cached one while it lives, otherwise a fresh
   * one. Exposed because callers occasionally need the token itself, and
   * because it is the single place a refresh can happen.
   */
  async accessToken(): Promise<string> {
    const cache = await this.tokens.read();
    if (Auth.isUsable(cache, this.now())) {
      return cache.access_token as string;
    }

    const refreshToken = Auth.refreshTokenFor(this.credentials, cache);
    if (refreshToken === null) {
      throw new Error(
        "no refresh token — run the bootstrap, or set FREEAGENT_REFRESH_TOKEN",
      );
    }

    const response = await this.http.send(
      "POST",
      `${this.baseUrl}/v2/token_endpoint`,
      {
        Accept: JSON_TYPE,
        Authorization: Auth.basicAuthHeader(this.credentials),
        "Content-Type": FORM_TYPE,
      },
      Auth.refreshBody(refreshToken),
    );

    const parsed = Auth.parseTokenResponse(response.status, response.body);
    const next = Auth.nextCache(cache, parsed, this.now());
    await this.tokens.write(next);
    return next.access_token as string;
  }

  /** Send an authenticated request and return the decoded JSON body. */
  async request<T>(request: ApiRequest): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = {
      Accept: JSON_TYPE,
      Authorization: `Bearer ${token}`,
    };
    if (request.payload !== undefined) headers["Content-Type"] = JSON_TYPE;

    const response = await this.http.send(
      request.method ?? "GET",
      this.url(request),
      headers,
      request.payload === undefined
        ? undefined
        : JSON.stringify(request.payload),
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `${request.method ?? "GET"} ${request.path} -> ${response.status}: ${response.body}`,
      );
    }
    return (response.body ? JSON.parse(response.body) : {}) as T;
  }

  /** Absolute URL for a request, with undefined query values dropped. */
  private url(request: ApiRequest): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) query.set(key, String(value));
    }
    const suffix = query.toString();
    return `${this.baseUrl}${request.path}${suffix ? `?${suffix}` : ""}`;
  }
}
