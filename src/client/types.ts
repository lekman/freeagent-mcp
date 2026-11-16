/** Production API host. */
export const PRODUCTION_BASE_URL = "https://api.freeagent.com";

/** Sandbox API host; write paths are qualified here before production. */
export const SANDBOX_BASE_URL = "https://api.sandbox.freeagent.com";

/** One API call. */
export interface ApiRequest {
  /** HTTP method; defaults to GET at the call site. */
  method?: string;
  /** Path below the host, starting with a slash, e.g. `/v2/invoices`. */
  path: string;
  /** JSON request body, for writes. */
  payload?: unknown;
  /** Query parameters; undefined values are dropped. */
  query?: Record<string, string | number | undefined>;
}
