import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DecisionDebrief, TenantStore } from "@deploystack/core";
import type { ServerAgent, DeploymentStore } from "../agent/server-agent.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

interface EnvironmentStore {
  get(id: string): { id: string; name: string; variables: Record<string, string> } | undefined;
}

/**
 * Create and configure the MCP server with all DeployStack tools and resources.
 */
export function createMcpServer(deps: {
  agent: ServerAgent;
  debrief: DecisionDebrief;
  tenants: TenantStore;
  environments: EnvironmentStore;
  deployments: DeploymentStore;
}): McpServer {
  const mcp = new McpServer(
    {
      name: "deploystack",
      version: "0.1.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  registerTools(mcp, deps.agent, deps.tenants, deps.environments, deps.deployments);
  registerResources(mcp, deps.debrief, deps.deployments);

  return mcp;
}
