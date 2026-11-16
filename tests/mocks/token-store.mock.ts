import type { ITokenStore, TokenCache } from "../../src/auth";

/** In-memory token cache recording every write. */
export class TokenStoreMock implements ITokenStore {
  /** Current contents. */
  cache: TokenCache;
  /** Every cache written, in order. */
  readonly writes: TokenCache[] = [];

  constructor(initial: TokenCache = {}) {
    this.cache = initial;
  }

  /** Current cache contents. */
  async read(): Promise<TokenCache> {
    return this.cache;
  }

  /** Replace the cache and record the write. */
  async write(cache: TokenCache): Promise<void> {
    this.cache = cache;
    this.writes.push(cache);
  }
}
