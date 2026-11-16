import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { IHttpClient, ITokenStore } from "./interfaces.ts";
import type { TokenCache } from "./types.ts";

/** Token cache location when `FREEAGENT_TOKEN_CACHE` is unset. */
export const DEFAULT_TOKEN_CACHE = join(
  homedir(),
  ".config",
  "freeagent",
  "token.json",
);

/**
 * File-backed token cache, owner-readable only. Shares its path and JSON shape
 * with the Python helper so both can run against one authorisation.
 */
export class FileTokenStore implements ITokenStore {
  private readonly path: string;

  constructor(path: string = DEFAULT_TOKEN_CACHE) {
    this.path = path;
  }

  /** Cache contents; an absent or corrupt file reads as empty, never throws. */
  async read(): Promise<TokenCache> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as TokenCache;
    } catch {
      return {};
    }
  }

  /** Write the cache at mode 600, creating the directory if needed. */
  async write(cache: TokenCache): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(cache), { mode: 0o600 });
  }
}

/** HTTP client over global fetch. */
export class FetchHttpClient implements IHttpClient {
  /** Send the request and return status and raw body. */
  async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ body: string; status: number }> {
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    return { body: await response.text(), status: response.status };
  }
}
