import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the bootstrap skill stores the OAuth credentials. */
export const DEFAULT_ENV_PATH = join(homedir(), ".config", "freeagent", ".env");

/**
 * Load KEY=VALUE lines into the environment, without overriding what is
 * already set. An MCP server is started by the client, not by a shell that
 * sourced the file, so it reads the file itself. Values are never printed.
 */
export function loadEnvFile(
  path: string = DEFAULT_ENV_PATH,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!existsSync(path)) return 0;
  let loaded = 0;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (env[key] === undefined) {
      env[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}
