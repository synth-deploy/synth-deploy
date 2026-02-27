import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerAgent, DeploymentStore } from "../agent/server-agent.js";
import type { TenantStore, ProjectStore } from "@deploystack/core";

interface EnvironmentStore {
  get(id: string): { id: string; name: string; variables: Record<string, string> } | undefined;
}

/**
 * Register MCP tools on the server. These are the actions MCP clients
 * (Claude, agents, CLI tools) can invoke.
 */
export function registerTools(
  mcp: McpServer,
  agent: ServerAgent,
  tenants: TenantStore,
  environments: EnvironmentStore,
  deployments: DeploymentStore,
  projects: ProjectStore,
): void {
  mcp.registerTool(
    "trigger-deployment",
    {
      title: "Trigger Deployment",
      description:
        "Trigger a deployment for a project to a specific tenant and environment. " +
        "The server agent will resolve variables, make decisions, and record everything to the Debrief.",
      inputSchema: {
        projectId: z.string().describe("The project to deploy"),
        tenantId: z.string().describe("Target tenant ID"),
        environmentId: z.string().describe("Target environment ID"),
        version: z.string().describe("Version to deploy"),
        variables: z.record(z.string()).optional().describe("Override variables for this deployment"),
      },
    },
    async ({ projectId, tenantId, environmentId, version, variables }) => {
      const tenant = tenants.get(tenantId);
      if (!tenant) {
        return {
          content: [{ type: "text", text: `Error: Tenant not found: ${tenantId}` }],
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

      const project = projects.get(projectId);
      if (!project) {
        return {
          content: [{ type: "text", text: `Error: Project not found: ${projectId}` }],
          isError: true,
        };
      }

      const deployment = await agent.triggerDeployment(
        { projectId, tenantId, environmentId, version, variables },
        tenant,
        environment,
        project,
      );

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
