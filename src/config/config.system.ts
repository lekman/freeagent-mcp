import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { FinanceConfig } from "./types.ts";

import { Config } from "./config.ts";

/** Where operator configuration lives — outside the repo, by design. */
export const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "freeagent",
  "finance.json",
);

/** Reads finance.json from disk. */
export class ConfigStore {
  /**
   * Load and validate the config. A missing file throws with the path and the
   * reason it is not in the repo, because that is the question the error
   * otherwise prompts.
   */
  static load(path: string = DEFAULT_CONFIG_PATH): FinanceConfig {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new Error(
        `no config at ${path} — it lives outside the repo so a git operation cannot change which project your hours land on. Create it from the README template`,
      );
    }
    try {
      return Config.parse(JSON.parse(text));
    } catch (error) {
      throw new Error(`${path}: ${(error as Error).message}`, { cause: error });
    }
  }
}
