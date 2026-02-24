import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DecisionDiary } from "@deploystack/core";
import type { DeploymentStore } from "../agent/server-agent.js";

/**
 * Register MCP resources. These expose DeployStack state to MCP clients
 * as readable data — Decision Diary entries, deployment records, etc.
 */
export function registerResources(
  mcp: McpServer,
  diary: DecisionDiary,
  deployments: DeploymentStore,
): void {
  // Recent diary entries
  mcp.registerResource(
    "recent-diary-entries",
    "diary://recent",
    {
      title: "Recent Decision Diary Entries",
      description:
        "The most recent Decision Diary entries across all deployments. " +
        "Each entry records what the agent decided and why, in plain language.",
      mimeType: "application/json",
    },
    async () => ({
      contents: [
        {
          uri: "diary://recent",
          text: JSON.stringify(diary.getRecent(20), null, 2),
        },
      ],
    }),
  );

  // Diary entries for a specific deployment
  mcp.registerResource(
    "deployment-diary",
    new ResourceTemplate("diary://deployment/{deploymentId}", {
      list: undefined,
    }),
    {
      title: "Deployment Decision Diary",
      description:
        "All Decision Diary entries for a specific deployment, showing the full reasoning chain.",
      mimeType: "application/json",
    },
    async (uri, { deploymentId }) => {
      const entries = diary.getByDeployment(deploymentId as string);
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
          name: `${d.projectId} v${d.version} → ${d.environmentId}`,
        })),
      }),
    }),
    {
      title: "Deployment Record",
      description: "Full deployment record including status, variables, and diary entry references.",
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
