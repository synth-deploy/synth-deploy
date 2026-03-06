import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DebriefWriter, DebriefReader, IPartitionStore, IEnvironmentStore, IArtifactStore } from "@synth-deploy/core";
import type { CommandAgent, DeploymentStore } from "../agent/command-agent.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";

/**
 * Create and configure the MCP server with all Synth tools and resources.
 */
export function createMcpServer(deps: {
  agent: CommandAgent;
  debrief: DebriefWriter & DebriefReader;
  partitions: IPartitionStore;
  environments: IEnvironmentStore;
  deployments: DeploymentStore;
  artifactStore: IArtifactStore;
}): McpServer {
  const mcp = new McpServer(
    {
      name: "synth",
      version: "0.1.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  registerTools(mcp, deps.agent, deps.partitions, deps.environments, deps.deployments, deps.artifactStore);
  registerResources(mcp, deps.debrief, deps.deployments);

  return mcp;
}
