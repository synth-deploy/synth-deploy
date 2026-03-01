import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommandAgent, DeploymentStore } from "../agent/command-agent.js";
import type { IPartitionStore, IOperationStore, IEnvironmentStore } from "@deploystack/core";

/**
 * Register MCP tools on the server. These are the actions MCP clients
 * (Claude, agents, CLI tools) can invoke.
 */
export function registerTools(
  mcp: McpServer,
  agent: CommandAgent,
  partitions: IPartitionStore,
  environments: IEnvironmentStore,
  deployments: DeploymentStore,
  operations: IOperationStore,
): void {
  mcp.registerTool(
    "trigger-deployment",
    {
      title: "Trigger Deployment",
      description:
        "Trigger a deployment from an Order (or create one on the fly from an operation + version). " +
        "The server agent will resolve variables, make decisions, and record everything to the Debrief.",
      inputSchema: {
        operationId: z.string().describe("The operation to deploy"),
        partitionId: z.string().describe("Target partition ID"),
        environmentId: z.string().describe("Target environment ID"),
        version: z.string().describe("Version to deploy"),
        variables: z.record(z.string()).optional().describe("Override variables for this deployment"),
      },
    },
    async ({ operationId, partitionId, environmentId, version, variables }) => {
      const partition = partitions.get(partitionId);
      if (!partition) {
        return {
          content: [{ type: "text", text: `Error: Partition not found: ${partitionId}` }],
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

      const operation = operations.get(operationId);
      if (!operation) {
        return {
          content: [{ type: "text", text: `Error: Operation not found: ${operationId}` }],
          isError: true,
        };
      }

      // Create an Order snapshot, then trigger deployment from it
      const order = agent.createOrderSnapshot(version, partition, environment, operation);

      const deployment = await agent.triggerDeployment(
        { orderId: order.id, partitionId, environmentId, triggeredBy: "agent", variables },
        partition,
        environment,
        operation,
        order,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                deploymentId: deployment.id,
                orderId: order.id,
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
