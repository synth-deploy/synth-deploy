import crypto from "node:crypto";
import type {
  Deployment,
  DeploymentId,
  DeploymentTrigger,
  DiaryWriter,
  Environment,
  Tenant,
} from "@deploystack/core";

export interface DeploymentStore {
  save(deployment: Deployment): void;
  get(id: DeploymentId): Deployment | undefined;
  getByTenant(tenantId: string): Deployment[];
  list(): Deployment[];
}

/**
 * Server Agent — the reasoning engine that orchestrates deployments.
 *
 * In this scaffold, reasoning is deterministic. The structure is designed so
 * LLM-backed reasoning can replace any step without changing the interface.
 *
 * Every decision writes to the Decision Diary. No silent actions.
 */
export class ServerAgent {
  constructor(
    private diary: DiaryWriter,
    private deployments: DeploymentStore,
  ) {}

  /**
   * Process a deployment trigger. This is the main entry point — called by
   * both the REST API and MCP tools.
   */
  async triggerDeployment(
    trigger: DeploymentTrigger,
    tenant: Tenant,
    environment: Environment,
  ): Promise<Deployment> {
    const deploymentId = crypto.randomUUID();

    // Step 1: Resolve variables (tenant-level overrides environment defaults)
    const resolvedVariables = this.resolveVariables(
      deploymentId,
      trigger,
      tenant,
      environment,
    );

    // Step 2: Create deployment record
    const deployment: Deployment = {
      id: deploymentId,
      projectId: trigger.projectId,
      tenantId: trigger.tenantId,
      environmentId: trigger.environmentId,
      version: trigger.version,
      status: "pending",
      variables: resolvedVariables,
      diaryEntryIds: [],
      createdAt: new Date(),
      completedAt: null,
    };

    const initEntry = this.diary.record({
      tenantId: trigger.tenantId,
      deploymentId,
      agent: "server",
      decision: `Initiated deployment of ${trigger.projectId} v${trigger.version} to ${environment.name}`,
      reasoning: `Deployment triggered for tenant "${tenant.name}" targeting environment "${environment.name}". Variables resolved with tenant-level precedence.`,
      context: {
        projectId: trigger.projectId,
        version: trigger.version,
        environmentName: environment.name,
        tenantName: tenant.name,
        variableCount: Object.keys(resolvedVariables).length,
      },
    });
    deployment.diaryEntryIds.push(initEntry.id);

    // Step 3: Execute deployment (simulated in scaffold)
    deployment.status = "running";
    this.deployments.save(deployment);

    const result = await this.executeDeployment(deployment, tenant, environment);
    return result;
  }

  /**
   * Resolve variables with precedence: trigger > tenant > environment.
   * Records conflict resolutions to the diary.
   */
  private resolveVariables(
    deploymentId: string,
    trigger: DeploymentTrigger,
    tenant: Tenant,
    environment: Environment,
  ): Record<string, string> {
    const resolved: Record<string, string> = { ...environment.variables };
    const conflicts: string[] = [];

    // Tenant overrides environment
    for (const [key, value] of Object.entries(tenant.variables)) {
      if (key in resolved && resolved[key] !== value) {
        conflicts.push(
          `${key}: used tenant value "${value}" over environment value "${resolved[key]}"`,
        );
      }
      resolved[key] = value;
    }

    // Trigger overrides everything
    if (trigger.variables) {
      for (const [key, value] of Object.entries(trigger.variables)) {
        if (key in resolved && resolved[key] !== value) {
          conflicts.push(
            `${key}: used trigger value "${value}" over existing value "${resolved[key]}"`,
          );
        }
        resolved[key] = value;
      }
    }

    if (conflicts.length > 0) {
      this.diary.record({
        tenantId: trigger.tenantId,
        deploymentId,
        agent: "server",
        decision: `Resolved ${conflicts.length} variable conflict(s)`,
        reasoning: `Variable precedence applied: trigger > tenant > environment. Conflicts: ${conflicts.join("; ")}`,
        context: { conflicts },
      });
    }

    return resolved;
  }

  /**
   * Execute the deployment. In this scaffold, execution is simulated.
   * In later phases, this delegates to Tentacles via MCP.
   */
  private async executeDeployment(
    deployment: Deployment,
    tenant: Tenant,
    environment: Environment,
  ): Promise<Deployment> {
    // Simulate execution time
    await new Promise((resolve) => setTimeout(resolve, 100));

    deployment.status = "succeeded";
    deployment.completedAt = new Date();

    const completionEntry = this.diary.record({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      agent: "server",
      decision: `Deployment completed successfully`,
      reasoning: `Deployed ${deployment.projectId} v${deployment.version} to ${environment.name} for tenant "${tenant.name}". All steps completed without errors.`,
      context: {
        durationMs:
          deployment.completedAt.getTime() - deployment.createdAt.getTime(),
        status: deployment.status,
      },
    });
    deployment.diaryEntryIds.push(completionEntry.id);

    this.deployments.save(deployment);
    return deployment;
  }
}

/**
 * In-memory deployment store. Partitioned by tenant for isolation.
 */
export class InMemoryDeploymentStore implements DeploymentStore {
  private deployments: Map<DeploymentId, Deployment> = new Map();

  save(deployment: Deployment): void {
    this.deployments.set(deployment.id, deployment);
  }

  get(id: DeploymentId): Deployment | undefined {
    return this.deployments.get(id);
  }

  getByTenant(tenantId: string): Deployment[] {
    return [...this.deployments.values()].filter(
      (d) => d.tenantId === tenantId,
    );
  }

  list(): Deployment[] {
    return [...this.deployments.values()];
  }
}
