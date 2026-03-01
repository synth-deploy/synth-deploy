import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DebriefWriter, DebriefReader, PartitionStore, OperationStore } from "@deploystack/core";
import type { CommandAgent, DeploymentStore } from "../agent/command-agent.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

interface EnvironmentStore {
  get(id: string): { id: string; name: string; variables: Record<string, string> } | undefined;
}

/**
 * Create and configure the MCP server with all DeployStack tools and resources.
 */
export function createMcpServer(deps: {
  agent: CommandAgent;
  debrief: DebriefWriter & DebriefReader;
  partitions: PartitionStore;
  environments: EnvironmentStore;
  deployments: DeploymentStore;
  operations: OperationStore;
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

  registerTools(mcp, deps.agent, deps.partitions, deps.environments, deps.deployments, deps.operations);
  registerResources(mcp, deps.debrief, deps.deployments);

  return mcp;
}
