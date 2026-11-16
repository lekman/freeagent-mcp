import type { ApiRequest } from "./types.ts";

/** Port for authenticated FreeAgent API access. */
export interface IFreeAgentClient {
  /** Send an authenticated request and return the decoded JSON body. */
  request<T>(request: ApiRequest): Promise<T>;
}

/** Port for reading process configuration; keeps env access out of logic. */
export interface IEnvironment {
  /** Value of an environment variable, or undefined when unset. */
  get(name: string): string | undefined;
}
