/** OAuth app credentials, registered at dev.freeagent.com/apps. */
export interface OAuthCredentials {
  /** OAuth identifier for the registered app. */
  clientId: string;
  /** OAuth secret for the registered app. */
  clientSecret: string;
  /**
   * Long-lived refresh token from the one-time bootstrap. Optional: the token
   * cache carries a copy, so a machine that has authorised once needs no
   * environment entry.
   */
  refreshToken?: string;
}

/**
 * On-disk token cache. Field names and types match the Python implementation
 * byte for byte — both read and write the same file during the port, and a
 * shape change would force a re-authorisation for no benefit.
 */
export interface TokenCache {
  /** Short-lived bearer token. */
  access_token?: string;
  /** Absolute expiry as UNIX **seconds**, not milliseconds. */
  expires_at?: number;
  /** Long-lived refresh token, kept so it survives without an env entry. */
  refresh_token?: string;
}

/** Token endpoint response body. */
export interface TokenResponse {
  /** The new bearer token. */
  access_token: string;
  /** Lifetime in seconds; FreeAgent omits it in some responses. */
  expires_in?: number;
  /** A rotated refresh token, when the provider issues one. */
  refresh_token?: string;
}
