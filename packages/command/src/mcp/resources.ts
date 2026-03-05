import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DebriefReader } from "@deploystack/core";
import type { DeploymentStore } from "../agent/command-agent.js";

/**
 * Register MCP resources. These expose DeployStack state to MCP clients
 * as readable data — Debrief entries, deployment records, etc.
 */
export function registerResources(
  mcp: McpServer,
  debrief: DebriefReader,
  deployments: DeploymentStore,
): void {
  // Recent debrief entries — scoped to a specific partition
  mcp.registerResource(
    "recent-debrief-entries",
    new ResourceTemplate("debrief://partition/{partitionId}/recent", {
      list: undefined,
    }),
    {
      title: "Recent Debrief Entries (Partition-Scoped)",
      description:
        "The most recent Debrief entries for a specific partition. " +
        "Each entry records what the agent decided and why, in plain language.",
      mimeType: "application/json",
    },
    async (uri, { partitionId }) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(debrief.getByPartition(partitionId as string).slice(-20), null, 2),
        },
      ],
    }),
  );

  // Debrief entries for a specific deployment
  mcp.registerResource(
    "deployment-debrief",
    new ResourceTemplate("debrief://deployment/{deploymentId}", {
      list: undefined,
    }),
    {
      title: "Deployment Debrief",
      description:
        "All Debrief entries for a specific deployment, showing the full reasoning chain.",
      mimeType: "application/json",
    },
    async (uri, { deploymentId }) => {
      const deployment = deployments.get(deploymentId as string);
      if (!deployment) {
        return { contents: [{ uri: uri.href, text: JSON.stringify({ error: "Deployment not found" }) }] };
      }
      const entries = debrief.getByDeployment(deploymentId as string);
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(entries, null, 2),
          },
        ],
      };
    },
  );

  // Deployment record
  mcp.registerResource(
    "deployment",
    new ResourceTemplate("deployment://{deploymentId}", {
      list: async () => ({
        resources: deployments.list().map((d) => ({
          uri: `deployment://${d.id}`,
          name: `${d.artifactId} v${d.version} → ${d.environmentId}`,
        })),
      }),
    }),
    {
      title: "Deployment Record",
      description: "Full deployment record including status, variables, and debrief entry references.",
      mimeType: "application/json",
    },
    async (uri, { deploymentId }) => {
      const deployment = deployments.get(deploymentId as string);
      if (!deployment) {
        return { contents: [{ uri: uri.href, text: "Not found" }] };
      }
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(deployment, null, 2),
          },
        ],
      };
    },
  );
}
