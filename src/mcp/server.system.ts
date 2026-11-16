import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ClientFactory } from "../client/index.ts";
import { ConfigStore } from "../config/index.ts";
import { TimesheetWriter } from "../timesheets/index.ts";
import { loadEnvFile } from "./env.system.ts";
import { registerTimesheetTools } from "./tools.ts";

/** Start the FreeAgent MCP server on stdio. */
export async function serveStdio(version: string): Promise<void> {
  loadEnvFile();
  const server = new McpServer({ name: "freeagent", version });
  registerTimesheetTools(server, {
    writer: () =>
      new TimesheetWriter(ClientFactory.fromEnvironment(), ConfigStore.load()),
  });
  await server.connect(new StdioServerTransport());
}
