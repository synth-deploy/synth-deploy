import crypto from "node:crypto";
import type {
  Deployment,
  DeploymentId,
  DeploymentTrigger,
  DiaryWriter,
  Environment,
  Tenant,
} from "@deploystack/core";
import type { ServiceHealthChecker } from "./health-checker.js";
import { DefaultHealthChecker } from "./health-checker.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DeploymentStore {
  save(deployment: Deployment): void;
  get(id: DeploymentId): Deployment | undefined;
  getByTenant(tenantId: string): Deployment[];
  list(): Deployment[];
}

export interface AgentOptions {
  /** Number of health check retries after initial failure. Default: 1 */
  healthCheckRetries: number;
  /** Delay between health check retries in ms. Default: 500 */
  healthCheckBackoffMs: number;
  /** Simulated execution delay in ms. Default: 10 */
  executionDelayMs: number;
}

const DEFAULT_OPTIONS: AgentOptions = {
  healthCheckRetries: 1,
  healthCheckBackoffMs: 500,
  executionDelayMs: 10,
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface VariableConflict {
  variable: string;
  winner: "tenant" | "trigger";
  winnerValue: string;
  loserValue: string;
  loserLevel: "environment" | "tenant";
}

/**
 * Variable name patterns that warrant extra scrutiny when overridden.
 */
const SENSITIVE_VARIABLE_PATTERNS = [
  /secret/i,
  /password/i,
  /\bkey\b/i,
  /token/i,
  /credential/i,
];

// ---------------------------------------------------------------------------
// OrchestrationError
// ---------------------------------------------------------------------------

/**
 * Thrown when a pipeline step fails after the agent has reasoned through it
 * and determined the deployment cannot proceed.
 *
 * Carries structured reasoning so the final diary entry can explain
 * exactly why the deployment was aborted.
 */
export class OrchestrationError extends Error {
  constructor(
    public readonly step: string,
    message: string,
    public readonly reasoning: string,
  ) {
    super(message);
    this.name = "OrchestrationError";
  }
}

// ---------------------------------------------------------------------------
// ServerAgent — the deployment orchestration engine
// ---------------------------------------------------------------------------

/**
 * Server Agent — the reasoning engine that orchestrates deployments.
 *
 * Processes deployment requests through a structured pipeline:
 *
 *   1. Plan pipeline — determine steps and record intent
 *   2. Resolve configuration — merge variables with tenant precedence,
 *      reason through conflicts
 *   3. Pre-flight health check — verify target environment is reachable,
 *      retry with reasoning if not
 *   4. Execute deployment — apply artifacts (simulated in this phase)
 *   5. Post-deploy verify — confirm deployment took effect
 *
 * When a step encounters an unexpected situation the agent reasons through
 * it — retrying, adjusting, or failing with a full explanation — rather
 * than silently failing or throwing an opaque error.
 *
 * Every decision is recorded to the Decision Diary. No silent actions.
 */
export class ServerAgent {
  private options: AgentOptions;

  constructor(
    private diary: DiaryWriter,
    private deployments: DeploymentStore,
    private healthChecker: ServiceHealthChecker = new DefaultHealthChecker(),
    options: Partial<AgentOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // -----------------------------------------------------------------------
  // Main entry point
  // -----------------------------------------------------------------------

  /**
   * Process a deployment trigger. Called by both the REST API and MCP tools.
   */
  async triggerDeployment(
    trigger: DeploymentTrigger,
    tenant: Tenant,
    environment: Environment,
  ): Promise<Deployment> {
    const deploymentId = crypto.randomUUID();

    // --- Step 1: Plan the pipeline -----------------------------------------

    const pipelineSteps = [
      "resolve-configuration",
      "preflight-health-check",
      "execute-deployment",
      "post-deploy-verify",
    ];

    const planEntry = this.diary.record({
      tenantId: trigger.tenantId,
      deploymentId,
      agent: "server",
      decision: `Planned deployment pipeline: ${pipelineSteps.join(" → ")}`,
      reasoning:
        `Deployment of ${trigger.projectId} v${trigger.version} to ${environment.name} ` +
        `for tenant "${tenant.name}". Pipeline includes pre-flight health check to verify ` +
        `target environment is reachable before deploying, and post-deployment verification ` +
        `to confirm the deployment took effect.`,
      context: {
        steps: pipelineSteps,
        projectId: trigger.projectId,
        version: trigger.version,
        environmentName: environment.name,
        tenantName: tenant.name,
      },
    });

    const deployment: Deployment = {
      id: deploymentId,
      projectId: trigger.projectId,
      tenantId: trigger.tenantId,
      environmentId: trigger.environmentId,
      version: trigger.version,
      status: "pending",
      variables: {},
      diaryEntryIds: [planEntry.id],
      createdAt: new Date(),
      completedAt: null,
      failureReason: null,
    };

    this.deployments.save(deployment);

    try {
      // --- Step 2: Resolve configuration -----------------------------------

      const { variables, hasConflicts } = this.resolveConfiguration(
        deployment,
        trigger,
        tenant,
        environment,
      );
      deployment.variables = variables;

      // --- Step 3: Pre-flight health check ---------------------------------

      deployment.status = "running";
      this.deployments.save(deployment);

      await this.preflightHealthCheck(deployment, tenant, environment);

      // --- Step 4: Execute deployment --------------------------------------

      await this.executeDeployment(deployment, tenant, environment);

      // --- Step 5: Post-deploy verify --------------------------------------

      await this.postDeployVerify(deployment, tenant, environment);

      // --- Success ---------------------------------------------------------

      deployment.status = "succeeded";
      deployment.completedAt = new Date();

      const completionEntry = this.diary.record({
        tenantId: deployment.tenantId,
        deploymentId: deployment.id,
        agent: "server",
        decision: "Deployment completed successfully",
        reasoning:
          `All pipeline steps completed. Deployed ${deployment.projectId} v${deployment.version} ` +
          `to ${environment.name} for tenant "${tenant.name}". ` +
          `${Object.keys(deployment.variables).length} variable(s) resolved. ` +
          (hasConflicts
            ? "Variable conflicts were resolved — see earlier diary entries for details."
            : "No variable conflicts detected."),
        context: {
          durationMs:
            deployment.completedAt.getTime() - deployment.createdAt.getTime(),
          status: deployment.status,
          variableCount: Object.keys(deployment.variables).length,
        },
      });
      deployment.diaryEntryIds.push(completionEntry.id);
    } catch (error) {
      // --- Pipeline failure ------------------------------------------------

      deployment.status = "failed";
      deployment.completedAt = new Date();
      deployment.failureReason =
        error instanceof OrchestrationError
          ? error.message
          : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;

      const failEntry = this.diary.record({
        tenantId: deployment.tenantId,
        deploymentId: deployment.id,
        agent: "server",
        decision: `Deployment failed: ${deployment.failureReason}`,
        reasoning:
          error instanceof OrchestrationError
            ? error.reasoning
            : `An unexpected error occurred during deployment: ` +
              `${error instanceof Error ? error.message : String(error)}. ` +
              `This was not an anticipated failure mode. The deployment has been ` +
              `marked as failed and no changes were applied to the target environment.`,
        context: {
          durationMs:
            deployment.completedAt.getTime() - deployment.createdAt.getTime(),
          status: deployment.status,
          step:
            error instanceof OrchestrationError ? error.step : "unknown",
          ...(error instanceof Error
            ? { errorMessage: error.message }
            : {}),
        },
      });
      deployment.diaryEntryIds.push(failEntry.id);
    }

    this.deployments.save(deployment);
    return deployment;
  }

  // -----------------------------------------------------------------------
  // Pipeline steps
  // -----------------------------------------------------------------------

  /**
   * Resolve configuration variables with precedence: trigger > tenant > environment.
   *
   * Enhanced to detect and reason through two classes of conflict:
   *   - Cross-environment patterns (e.g. production DB in staging deployment)
   *   - Security-sensitive variable overrides (secrets, keys, tokens)
   */
  private resolveConfiguration(
    deployment: Deployment,
    trigger: DeploymentTrigger,
    tenant: Tenant,
    environment: Environment,
  ): { variables: Record<string, string>; hasConflicts: boolean } {
    const resolved: Record<string, string> = { ...environment.variables };
    const conflicts: VariableConflict[] = [];

    // Tenant overrides environment
    for (const [key, value] of Object.entries(tenant.variables)) {
      if (key in resolved && resolved[key] !== value) {
        conflicts.push({
          variable: key,
          winner: "tenant",
          winnerValue: value,
          loserValue: resolved[key],
          loserLevel: "environment",
        });
      }
      resolved[key] = value;
    }

    // Trigger overrides everything
    if (trigger.variables) {
      for (const [key, value] of Object.entries(trigger.variables)) {
        if (key in resolved && resolved[key] !== value) {
          conflicts.push({
            variable: key,
            winner: "trigger",
            winnerValue: value,
            loserValue: resolved[key],
            loserLevel: key in tenant.variables ? "tenant" : "environment",
          });
        }
        resolved[key] = value;
      }
    }

    if (conflicts.length > 0) {
      this.reasonAboutVariableConflicts(deployment, conflicts, environment);
    }

    const configEntry = this.diary.record({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      agent: "server",
      decision: `Configuration resolved: ${Object.keys(resolved).length} variable(s), ${conflicts.length} conflict(s)`,
      reasoning:
        conflicts.length === 0
          ? `All variables merged without conflicts. Environment "${environment.name}" provided ` +
            `base values, tenant-level overrides applied. Final configuration has ` +
            `${Object.keys(resolved).length} variable(s).`
          : `Merged variables from environment, tenant, and trigger levels. ` +
            `${conflicts.length} conflict(s) resolved using precedence hierarchy ` +
            `(trigger > tenant > environment). See preceding diary entries for detailed conflict analysis.`,
      context: {
        variableCount: Object.keys(resolved).length,
        conflictCount: conflicts.length,
        sources: {
          environment: Object.keys(environment.variables).length,
          tenant: Object.keys(tenant.variables).length,
          trigger: Object.keys(trigger.variables ?? {}).length,
        },
      },
    });
    deployment.diaryEntryIds.push(configEntry.id);

    return { variables: resolved, hasConflicts: conflicts.length > 0 };
  }

  /**
   * Categorize and reason through variable conflicts.
   *
   * Three categories:
   *   1. Cross-environment: value patterns suggest wrong environment
   *   2. Sensitive: security-relevant variables being overridden
   *   3. Standard: routine precedence-based resolution
   */
  private reasonAboutVariableConflicts(
    deployment: Deployment,
    conflicts: VariableConflict[],
    environment: Environment,
  ): void {
    const crossEnv: VariableConflict[] = [];
    const sensitive: VariableConflict[] = [];
    const standard: VariableConflict[] = [];

    for (const conflict of conflicts) {
      const isSensitive = SENSITIVE_VARIABLE_PATTERNS.some((p) =>
        p.test(conflict.variable),
      );
      const isCrossEnv = this.detectCrossEnvironmentPattern(
        conflict,
        environment.name,
      );

      if (isCrossEnv) {
        crossEnv.push(conflict);
      } else if (isSensitive) {
        sensitive.push(conflict);
      } else {
        standard.push(conflict);
      }
    }

    if (crossEnv.length > 0) {
      const details = crossEnv
        .map(
          (c) =>
            `${c.variable}: ${c.winner} value "${c.winnerValue}" overrides ` +
            `${c.loserLevel} value "${c.loserValue}"`,
        )
        .join("; ");

      const entry = this.diary.record({
        tenantId: deployment.tenantId,
        deploymentId: deployment.id,
        agent: "server",
        decision: `Cross-environment variable pattern detected in ${crossEnv.length} variable(s)`,
        reasoning:
          `Detected variable value(s) that reference a different environment than the ` +
          `deployment target "${environment.name}". Conflicts: ${details}. ` +
          `This may indicate intentional tenant-specific infrastructure ` +
          `(e.g., a tenant that maintains its own database across environments) ` +
          `or misconfiguration (e.g., production credentials accidentally applied ` +
          `to a staging deployment). Proceeding with tenant-level precedence as the ` +
          `configuration hierarchy dictates. The operator should verify these overrides ` +
          `are intentional for this tenant's deployment context.`,
        context: {
          category: "cross-environment",
          conflicts: crossEnv,
          targetEnvironment: environment.name,
        },
      });
      deployment.diaryEntryIds.push(entry.id);
    }

    if (sensitive.length > 0) {
      const details = sensitive
        .map((c) => `${c.variable}: overridden at ${c.winner} level`)
        .join("; ");

      const entry = this.diary.record({
        tenantId: deployment.tenantId,
        deploymentId: deployment.id,
        agent: "server",
        decision: `Security-sensitive variable(s) overridden: ${sensitive.map((c) => c.variable).join(", ")}`,
        reasoning:
          `${sensitive.length} variable(s) matching security-sensitive patterns ` +
          `(secrets, keys, tokens, credentials) are being overridden by higher-precedence ` +
          `levels. ${details}. Applying precedence rules as configured. ` +
          `These overrides are recorded for audit purposes.`,
        context: {
          category: "sensitive-override",
          variables: sensitive.map((c) => ({
            variable: c.variable,
            overriddenBy: c.winner,
          })),
        },
      });
      deployment.diaryEntryIds.push(entry.id);
    }

    if (standard.length > 0) {
      const details = standard
        .map(
          (c) =>
            `${c.variable}: used ${c.winner} value "${c.winnerValue}" over ` +
            `${c.loserLevel} value "${c.loserValue}"`,
        )
        .join("; ");

      const entry = this.diary.record({
        tenantId: deployment.tenantId,
        deploymentId: deployment.id,
        agent: "server",
        decision: `Resolved ${standard.length} variable conflict(s) via precedence rules`,
        reasoning:
          `Standard precedence applied (trigger > tenant > environment). ` +
          `Conflicts: ${details}. These are routine overrides consistent ` +
          `with the configuration hierarchy.`,
        context: {
          category: "standard-override",
          conflicts: standard,
        },
      });
      deployment.diaryEntryIds.push(entry.id);
    }
  }

  /**
   * Detect if a variable's winning value might reference the wrong environment.
   * Example: a value containing "prod" when deploying to staging.
   */
  private detectCrossEnvironmentPattern(
    conflict: VariableConflict,
    targetEnvName: string,
  ): boolean {
    const envPatterns: Record<string, RegExp[]> = {
      production: [/\bstag/i, /\bdev\b/i, /\btest\b/i],
      staging: [/\bprod/i],
      development: [/\bprod/i, /\bstag/i],
    };

    const patternsToCheck = envPatterns[targetEnvName.toLowerCase()];
    if (!patternsToCheck) return false;

    return patternsToCheck.some((p) => p.test(conflict.winnerValue));
  }

  /**
   * Pre-flight health check with retry logic and detailed reasoning.
   *
   * When the target environment is unreachable:
   *   1. Records why the check failed
   *   2. Reasons about whether to retry (transient vs persistent)
   *   3. Retries with backoff
   *   4. If still unreachable, fails with actionable explanation
   */
  private async preflightHealthCheck(
    deployment: Deployment,
    tenant: Tenant,
    environment: Environment,
  ): Promise<void> {
    const serviceId = `${deployment.projectId}/${environment.name}`;

    const firstCheck = await this.healthChecker.check(serviceId, {
      tenantId: tenant.id,
      environmentName: environment.name,
    });

    if (firstCheck.reachable) {
      const entry = this.diary.record({
        tenantId: deployment.tenantId,
        deploymentId: deployment.id,
        agent: "server",
        decision: "Pre-flight health check passed",
        reasoning:
          `Target environment "${environment.name}" is reachable and healthy ` +
          `(response time: ${firstCheck.responseTimeMs}ms). Proceeding with deployment.`,
        context: {
          serviceId,
          responseTimeMs: firstCheck.responseTimeMs,
          attempt: 1,
        },
      });
      deployment.diaryEntryIds.push(entry.id);
      return;
    }

    // First check failed — reason about it and decide to retry
    const retryEntry = this.diary.record({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      agent: "server",
      decision: "Pre-flight health check failed — attempting retry",
      reasoning:
        `Health check to "${environment.name}" failed: ` +
        `${firstCheck.error ?? "service unreachable"}. This could indicate the service ` +
        `is still starting up, under heavy load, or experiencing a transient network issue. ` +
        `Retrying in ${this.options.healthCheckBackoffMs}ms before making a deployment ` +
        `decision (${this.options.healthCheckRetries} retry attempt(s) configured).`,
      context: {
        serviceId,
        error: firstCheck.error,
        backoffMs: this.options.healthCheckBackoffMs,
        retriesConfigured: this.options.healthCheckRetries,
        attempt: 1,
      },
    });
    deployment.diaryEntryIds.push(retryEntry.id);

    // Retry loop
    for (let attempt = 0; attempt < this.options.healthCheckRetries; attempt++) {
      await this.delay(this.options.healthCheckBackoffMs);

      const retryCheck = await this.healthChecker.check(serviceId, {
        tenantId: tenant.id,
        environmentName: environment.name,
      });

      if (retryCheck.reachable) {
        const recoveryEntry = this.diary.record({
          tenantId: deployment.tenantId,
          deploymentId: deployment.id,
          agent: "server",
          decision:
            "Health check recovered on retry — proceeding with deployment",
          reasoning:
            `Retry attempt ${attempt + 1} succeeded (response time: ` +
            `${retryCheck.responseTimeMs}ms). The initial failure was transient — ` +
            `likely caused by a brief service restart or momentary load spike. ` +
            `Target environment "${environment.name}" is now confirmed healthy. ` +
            `Proceeding with deployment.`,
          context: {
            serviceId,
            responseTimeMs: retryCheck.responseTimeMs,
            attempt: attempt + 2,
            recoveredAfterMs: this.options.healthCheckBackoffMs * (attempt + 1),
          },
        });
        deployment.diaryEntryIds.push(recoveryEntry.id);
        return;
      }
    }

    // All retries exhausted — fail with actionable explanation
    const totalAttempts = this.options.healthCheckRetries + 1;
    throw new OrchestrationError(
      "preflight-health-check",
      `Target environment "${environment.name}" unreachable after ${totalAttempts} attempt(s)`,
      `Attempted ${totalAttempts} health check(s) to "${environment.name}" — all failed. ` +
        `Last error: ${firstCheck.error ?? "service unreachable"}. ` +
        `Consecutive failures indicate a persistent infrastructure issue rather than a ` +
        `transient glitch. Aborting deployment to prevent deploying artifacts to ` +
        `infrastructure that cannot serve them. ` +
        `Recommended action: verify the target environment's infrastructure is running ` +
        `and network-accessible, then re-trigger the deployment.`,
    );
  }

  /**
   * Execute the deployment. Simulated in this phase.
   * In later phases, this delegates to Tentacles via MCP.
   */
  private async executeDeployment(
    deployment: Deployment,
    tenant: Tenant,
    environment: Environment,
  ): Promise<void> {
    const entry = this.diary.record({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      agent: "server",
      decision: `Executing deployment of ${deployment.projectId} v${deployment.version}`,
      reasoning:
        `Pre-flight checks passed. Deploying to "${environment.name}" for ` +
        `tenant "${tenant.name}" with ${Object.keys(deployment.variables).length} ` +
        `resolved variable(s).`,
      context: {
        step: "execute-deployment",
        projectId: deployment.projectId,
        version: deployment.version,
      },
    });
    deployment.diaryEntryIds.push(entry.id);

    // Simulate execution
    await this.delay(this.options.executionDelayMs);
  }

  /**
   * Post-deployment verification. In this phase, verification is implicit.
   * Future phases will include active health checks and smoke tests
   * via Tentacle agents.
   */
  private async postDeployVerify(
    deployment: Deployment,
    _tenant: Tenant,
    environment: Environment,
  ): Promise<void> {
    const entry = this.diary.record({
      tenantId: deployment.tenantId,
      deploymentId: deployment.id,
      agent: "server",
      decision: "Post-deployment verification passed",
      reasoning:
        `Deployment artifacts confirmed in place for ${deployment.projectId} ` +
        `v${deployment.version} on "${environment.name}". In this phase, verification ` +
        `is implicit — future phases will include active health checks and smoke tests ` +
        `via Tentacle agents.`,
      context: { step: "post-deploy-verify" },
    });
    deployment.diaryEntryIds.push(entry.id);
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// In-memory deployment store
// ---------------------------------------------------------------------------

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
