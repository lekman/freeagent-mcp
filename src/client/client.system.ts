import type { OAuthCredentials } from "../auth/index.ts";
import type { IEnvironment } from "./interfaces.ts";

import { FetchHttpClient, FileTokenStore } from "../auth/index.ts";
import { FreeAgentClient } from "./client.ts";
import { PRODUCTION_BASE_URL } from "./types.ts";

/** Environment adapter over `process.env`. */
export class ProcessEnvironment implements IEnvironment {
  /** Value of an environment variable, or undefined when unset. */
  get(name: string): string | undefined {
    return process.env[name];
  }
}

/**
 * Builds a client from the environment. Thin wiring only — the token
 * lifecycle lives in FreeAgentClient, and the OAuth rules in Auth.
 */
export class ClientFactory {
  /**
   * Client configured from `FREEAGENT_CLIENT_ID`, `FREEAGENT_CLIENT_SECRET`,
   * and optionally `FREEAGENT_REFRESH_TOKEN`, `FREEAGENT_BASE_URL` and
   * `FREEAGENT_TOKEN_CACHE`.
   *
   * A missing client id or secret throws here rather than surfacing later as
   * a 401 from the token endpoint, which reads like a revoked credential.
   */
  static fromEnvironment(env: IEnvironment = new ProcessEnvironment()) {
    const clientId = env.get("FREEAGENT_CLIENT_ID");
    const clientSecret = env.get("FREEAGENT_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      throw new Error(
        "FREEAGENT_CLIENT_ID and FREEAGENT_CLIENT_SECRET must be set — see the bootstrap command",
      );
    }

    const refreshToken = env.get("FREEAGENT_REFRESH_TOKEN");
    const credentials: OAuthCredentials = {
      clientId,
      clientSecret,
      ...(refreshToken ? { refreshToken } : {}),
    };

    const cachePath = env.get("FREEAGENT_TOKEN_CACHE");
    return new FreeAgentClient({
      baseUrl: env.get("FREEAGENT_BASE_URL") ?? PRODUCTION_BASE_URL,
      credentials,
      http: new FetchHttpClient(),
      tokens: cachePath ? new FileTokenStore(cachePath) : new FileTokenStore(),
    });
  }
}
