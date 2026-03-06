import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SynthAgent, DeploymentStore } from "../agent/synth-agent.js";
import type { IArtifactStore, IEnvironmentStore, IPartitionStore } from "@synth-deploy/core";

/**
 * Register MCP tools on the server. These are the actions MCP clients
 * (Claude, agents, CLI tools) can invoke.
 */
export function registerTools(
  mcp: McpServer,
  agent: SynthAgent,
  partitions: IPartitionStore,
  environments: IEnvironmentStore,
  deployments: DeploymentStore,
  artifactStore: IArtifactStore,
): void {
  mcp.registerTool(
    "trigger-deployment",
    {
      title: "Trigger Deployment",
      description:
        "Trigger a deployment of an artifact to an environment. " +
        "The server agent will resolve variables, make decisions, and record everything to the Debrief.",
      inputSchema: {
        artifactId: z.string().describe("The artifact to deploy"),
        environmentId: z.string().describe("Target environment ID"),
        partitionId: z.string().optional().describe("Target partition ID (optional)"),
        version: z.string().describe("Version to deploy"),
        variables: z.record(z.string()).optional().describe("Override variables for this deployment"),
      },
    },
    async ({ artifactId, environmentId, partitionId, version, variables }) => {
      const artifact = artifactStore.get(artifactId);
      if (!artifact) {
        return {
          content: [{ type: "text", text: `Error: Artifact not found: ${artifactId}` }],
          isError: true,
        };
      }

      const environment = environments.get(environmentId);
      if (!environment) {
        return {
          content: [{ type: "text", text: `Error: Environment not found: ${environmentId}` }],
          isError: true,
        };
      }

      if (partitionId) {
        const partition = partitions.get(partitionId);
        if (!partition) {
          return {
            content: [{ type: "text", text: `Error: Partition not found: ${partitionId}` }],
            isError: true,
          };
        }
      }

      const deployment = await agent.triggerDeployment({
        artifactId,
        artifactVersionId: version,
        environmentId,
        partitionId,
        triggeredBy: "agent",
        variables,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                deploymentId: deployment.id,
                status: deployment.status,
                version: deployment.version,
                debriefEntries: deployment.debriefEntryIds.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  mcp.registerTool(
    "get-deployment-status",
    {
      title: "Get Deployment Status",
      description: "Get the current status and Debrief entries for a deployment.",
      inputSchema: {
        deploymentId: z.string().describe("The deployment ID to check"),
      },
    },
    async ({ deploymentId }) => {
      const deployment = deployments.get(deploymentId);
      if (!deployment) {
        return {
          content: [{ type: "text", text: `Error: Deployment not found: ${deploymentId}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(deployment, null, 2),
          },
        ],
      };
    },
  );
}
