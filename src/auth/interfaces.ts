import type { TokenCache } from "./types.ts";

/** Port for the token cache; the system layer backs it with a file. */
export interface ITokenStore {
  /** Current cache contents, or an empty object when absent or unreadable. */
  read(): Promise<TokenCache>;
  /** Persist the cache. Implementations restrict it to the owner. */
  write(cache: TokenCache): Promise<void>;
}

/** Minimal HTTP port: enough for form posts and JSON API calls. */
export interface IHttpClient {
  /**
   * Send a request and return the status and raw body. Transport errors throw;
   * a non-2xx status is data, not an exception, so callers can read the body
   * FreeAgent sends with it.
   */
  send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ body: string; status: number }>;
}
