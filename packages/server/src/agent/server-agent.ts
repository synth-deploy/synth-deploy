import crypto from "node:crypto";
import type {
  Deployment,
  DeploymentId,
  DeploymentTrigger,
  DebriefWriter,
  Environment,
  Partition,
  Project,
  Order,
  AppSettings,
} from "@deploystack/core";
import type { OrderStore } from "@deploystack/core";
import type {
  ServiceHealthChecker,
  HealthCheckResult,
} from "./health-checker.js";
import { DefaultHealthChecker } from "./health-checker.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DeploymentStore {
  save(deployment: Deployment): void;
  get(id: DeploymentId): Deployment | undefined;
  getByPartition(partitionId: string): Deployment[];
  list(): Deployment[];
}

export interface AgentOptions {
  /** Number of health check retries after initial failure. Default: 1 */
  healthCheckRetries: number;
  /** Base delay between health check retries in ms. Default: 500 */
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
// Internal types — reasoning inputs and outputs
// ---------------------------------------------------------------------------

interface VariableConflict {
  variable: string;
  winner: "partition" | "trigger";
  winnerValue: string;
  loserValue: string;
  loserLevel: "environment" | "partition";
}

type ErrorCategory =
  | "dns"
  | "timeout"
  | "connection_refused"
  | "server_error"
  | "unknown";

interface HealthDecision {
  action: "retry" | "abort";
  delayMs: number;
  reasoning: string;
}

interface ConflictRiskAssessment {
  action: "proceed" | "block";
  riskLevel: "low" | "medium" | "high";
  reasoning: string;
  details: ConflictDetail[];
}

interface ConflictDetail {
  conflict: VariableConflict;
  category: "cross-env-connectivity" | "cross-env" | "sensitive" | "standard";
  riskContribution: string;
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

/**
 * Variable name patterns indicating network connectivity configuration.
 * Overriding these cross-environment can route traffic or data to the
 * wrong infrastructure.
 */
const CONNECTIVITY_VARIABLE_PATTERNS = [
  /host/i,
  /\burl\b/i,
  /endpoint/i,
  /\bport\b/i,
  /\baddr/i,
  /\buri\b/i,
  /\bconn/i,
];

// ---------------------------------------------------------------------------
// OrchestrationError
// ---------------------------------------------------------------------------

/**
 * Thrown when a pipeline step fails after the agent has reasoned through it
 * and determined the deployment cannot proceed.
 *
 * Carries structured reasoning so the final debrief entry can explain
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
 * Processes deployment requests through a structured pipeline. When a step
 * encounters an unexpected situation, the agent evaluates the specifics —
 * error type, environment context, conflict severity — and makes a
 * context-dependent decision about how to proceed.
 *
 * Key reasoning behaviors:
 *
 *   Health check failures:
 *   - DNS errors abort immediately (retrying won't resolve infrastructure config)
 *   - Timeouts on production get extended backoff (service may be under load)
 *   - Connection refused gets standard retry (process may be restarting)
 *
 *   Variable conflicts:
 *   - Multiple connectivity vars pointing cross-environment → block deployment
 *   - Single cross-env connectivity var → proceed with operator warning
 *   - Sensitive variable overrides → proceed, log for audit without exposing values
 *   - Standard overrides → proceed with precedence rules
 *
 * Every decision is recorded to the Debrief. No silent actions.
 */
export class ServerAgent {
  private options: AgentOptions;
  private explicitOptions: Partial<AgentOptions>;

  constructor(
    private debrief: DebriefWriter,
    private deployments: DeploymentStore,
    private orders: OrderStore,
    private healthChecker: ServiceHealthChecker = new DefaultHealthChecker(),
    options: Partial<AgentOptions> = {},
    private settingsReader?: { get(): AppSettings },
  ) {
    this.explicitOptions = options;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Returns effective agent options. Precedence (highest wins):
   *   1. Explicit constructor options
   *   2. Global settings from SettingsStore
   *   3. DEFAULT_OPTIONS
   */
  private getEffectiveOptions(): AgentOptions {
    if (!this.settingsReader) return this.options;
    const settings = this.settingsReader.get();
    return {
      ...DEFAULT_OPTIONS,
      healthCheckRetries: settings.agent.defaultHealthCheckRetries,
      ...this.explicitOptions,
    };
  }

  // -----------------------------------------------------------------------
  // Main entry point
  // -----------------------------------------------------------------------

  async triggerDeployment(
    trigger: DeploymentTrigger,
    partition: Partition,
    environment: Environment,
    project: Project,
    existingOrder?: Order,
  ): Promise<Deployment> {
    const deploymentId = crypto.randomUUID();

    // --- Step 0: Create or reuse Order -------------------------------------

    let order: Order;
    if (existingOrder) {
      order = existingOrder;
      this.debrief.record({
        partitionId: trigger.partitionId,
        deploymentId,
        agent: "server",
        decisionType: "order-created",
        decision: `Re-executing existing Order ${order.id.slice(0, 8)}`,
        reasoning:
          `An existing Order was provided for re-execution. Using frozen snapshot from ` +
          `${order.createdAt.toISOString()} instead of reading current Project configuration. ` +
          `This guarantees the deployment reproduces exactly what was captured in the Order.`,
        context: { orderId: order.id, reused: true },
      });
    } else {
      order = this.createOrderFromCurrentState(
        deploymentId,
        trigger,
        partition,
        environment,
        project,
      );
    }

    // --- Step 1: Plan the pipeline -----------------------------------------

    const pipelineSteps = [
      "resolve-configuration",
      "preflight-health-check",
      "execute-deployment",
      "post-deploy-verify",
    ];

    const planEntry = this.debrief.record({
      partitionId: trigger.partitionId,
      deploymentId,
      agent: "server",
      decisionType: "pipeline-plan",
      decision: `Planned deployment pipeline: ${pipelineSteps.join(" → ")}`,
      reasoning:
        `Deployment of ${trigger.projectId} v${trigger.version} to ${environment.name} ` +
        `for partition "${partition.name}". Pipeline includes pre-flight health check to verify ` +
        `target environment is reachable before deploying, and post-deployment verification ` +
        `to confirm the deployment took effect.`,
      context: {
        steps: pipelineSteps,
        projectId: trigger.projectId,
        version: trigger.version,
        environmentName: environment.name,
        partitionName: partition.name,
        orderId: order.id,
      },
    });

    const deployment: Deployment = {
      id: deploymentId,
      projectId: trigger.projectId,
      partitionId: trigger.partitionId,
      environmentId: trigger.environmentId,
      version: trigger.version,
      status: "pending",
      variables: {},
      debriefEntryIds: [planEntry.id],
      orderId: order.id,
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
        partition,
        environment,
      );
      deployment.variables = variables;

      // --- Step 3: Pre-flight health check ---------------------------------

      deployment.status = "running";
      this.deployments.save(deployment);

      await this.preflightHealthCheck(deployment, partition, environment);

      // --- Step 4: Execute deployment --------------------------------------

      await this.executeDeployment(deployment, partition, environment);

      // --- Step 5: Post-deploy verify --------------------------------------

      await this.postDeployVerify(deployment, partition, environment);

      // --- Success ---------------------------------------------------------

      deployment.status = "succeeded";
      deployment.completedAt = new Date();

      const completionEntry = this.debrief.record({
        partitionId: deployment.partitionId,
        deploymentId: deployment.id,
        agent: "server",
        decisionType: "deployment-completion",
        decision: `Marking deployment of ${deployment.projectId} v${deployment.version} as succeeded on "${environment.name}"`,
        reasoning:
          `All four pipeline steps completed: configuration accepted, health check passed, ` +
          `execution finished, post-deploy verification confirmed. ` +
          `${Object.keys(deployment.variables).length} variable(s) applied for partition "${partition.name}". ` +
          (hasConflicts
            ? "Variable conflicts were resolved via precedence rules — see earlier debrief entries for per-conflict reasoning."
            : "No variable conflicts encountered — configuration was unambiguous.") +
          ` Total duration: ${deployment.completedAt!.getTime() - deployment.createdAt.getTime()}ms.`,
        context: {
          durationMs:
            deployment.completedAt.getTime() - deployment.createdAt.getTime(),
          status: deployment.status,
          variableCount: Object.keys(deployment.variables).length,
        },
      });
      deployment.debriefEntryIds.push(completionEntry.id);
    } catch (error) {
      deployment.status = "failed";
      deployment.completedAt = new Date();
      deployment.failureReason =
        error instanceof OrchestrationError
          ? error.message
          : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;

      const failEntry = this.debrief.record({
        partitionId: deployment.partitionId,
        deploymentId: deployment.id,
        agent: "server",
        decisionType: "deployment-failure",
        decision: `Deployment failed: ${deployment.failureReason}`,
        reasoning:
          error instanceof OrchestrationError
            ? error.reasoning
            : `Unexpected error during ${deployment.projectId} v${deployment.version} ` +
              `deployment to "${environment.name}" for partition "${partition.name}": ` +
              `${error instanceof Error ? error.message : String(error)}. ` +
              `This error did not come from the orchestration pipeline (not a health check, ` +
              `configuration, or execution failure) — it may indicate a server-side bug or ` +
              `infrastructure issue. The deployment has been marked as failed and no changes ` +
              `were applied to the target environment. Recommended action: check the server ` +
              `process logs for a stack trace, then re-trigger the deployment. If the error ` +
              `recurs, investigate the server runtime environment.`,
        context: {
          durationMs:
            deployment.completedAt.getTime() - deployment.createdAt.getTime(),
          status: deployment.status,
          step: error instanceof OrchestrationError ? error.step : "unknown",
          ...(error instanceof Error ? { errorMessage: error.message } : {}),
        },
      });
      deployment.debriefEntryIds.push(failEntry.id);
    }

    this.deployments.save(deployment);
    return deployment;
  }

  // -----------------------------------------------------------------------
  // Order creation — snapshot current project/env/partition state
  // -----------------------------------------------------------------------

  private createOrderFromCurrentState(
    deploymentId: string,
    trigger: DeploymentTrigger,
    partition: Partition,
    environment: Environment,
    project: Project,
  ): Order {
    // Merge global deployment defaults under project-level config.
    // Project-specific values win; global defaults fill gaps.
    const globalDefaults = this.settingsReader?.get()?.deploymentDefaults?.defaultPipelineConfig;
    const effectivePipelineConfig = globalDefaults
      ? { ...globalDefaults, ...project.pipelineConfig }
      : project.pipelineConfig;

    const order = this.orders.create({
      projectId: project.id,
      projectName: project.name,
      partitionId: partition.id,
      environmentId: environment.id,
      environmentName: environment.name,
      version: trigger.version,
      steps: project.steps,
      pipelineConfig: effectivePipelineConfig,
      variables: {}, // populated after resolve — we snapshot inputs here
    });

    this.debrief.record({
      partitionId: trigger.partitionId,
      deploymentId,
      agent: "server",
      decisionType: "order-created",
      decision: `Created Order ${order.id.slice(0, 8)} — immutable snapshot of "${project.name}" configuration`,
      reasoning:
        `Snapshotted project "${project.name}" (${project.steps.length} step(s), ` +
        `verification: ${effectivePipelineConfig.verificationStrategy}) for deployment ` +
        `v${trigger.version} to "${environment.name}". ` +
        (globalDefaults
          ? `Global deployment defaults were merged as a base under project-level pipeline config. `
          : ``) +
        `This Order freezes the project configuration so the deployment can be reproduced ` +
        `exactly, even if the project is modified later.`,
      context: {
        orderId: order.id,
        reused: false,
        stepCount: project.steps.length,
        pipelineConfig: effectivePipelineConfig,
        appliedGlobalDefaults: !!globalDefaults,
      },
    });

    return order;
  }

  // -----------------------------------------------------------------------
  // Pipeline step: resolve configuration
  // -----------------------------------------------------------------------

  private resolveConfiguration(
    deployment: Deployment,
    trigger: DeploymentTrigger,
    partition: Partition,
    environment: Environment,
  ): { variables: Record<string, string>; hasConflicts: boolean } {
    const resolved: Record<string, string> = { ...environment.variables };
    const conflicts: VariableConflict[] = [];

    // Partition overrides environment
    for (const [key, value] of Object.entries(partition.variables)) {
      if (key in resolved && resolved[key] !== value) {
        conflicts.push({
          variable: key,
          winner: "partition",
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
            loserLevel: key in partition.variables ? "partition" : "environment",
          });
        }
        resolved[key] = value;
      }
    }

    if (conflicts.length > 0) {
      // Assess risk across ALL conflicts together, then act on the assessment
      const assessment = this.assessConflictRisk(conflicts, environment);
      this.recordConflictReasoning(deployment, assessment, environment);

      if (assessment.action === "block") {
        throw new OrchestrationError(
          "resolve-configuration",
          `Deployment blocked: ${assessment.riskLevel}-risk variable configuration detected`,
          assessment.reasoning,
        );
      }
    }

    const configEntry = this.debrief.record({
      partitionId: deployment.partitionId,
      deploymentId: deployment.id,
      agent: "server",
      decisionType: "configuration-resolved",
      decision:
        conflicts.length === 0
          ? `Accepted configuration for "${environment.name}" — ${Object.keys(resolved).length} variable(s) merged, no conflicts`
          : `Accepted configuration for "${environment.name}" — ${conflicts.length} conflict(s) resolved via precedence, proceeding with merged result`,
      reasoning:
        conflicts.length === 0
          ? `Environment "${environment.name}" provided ${Object.keys(environment.variables).length} base variable(s), ` +
            `partition added ${Object.keys(partition.variables).length}, trigger added ${Object.keys(trigger.variables ?? {}).length}. ` +
            `No values collided across levels, so the merged configuration is unambiguous. ` +
            `Accepting ${Object.keys(resolved).length} final variable(s) as the deployment configuration.`
          : `${conflicts.length} variable(s) had different values at multiple precedence levels. ` +
            `Resolved using the hierarchy trigger > partition > environment. ` +
            `See preceding debrief entries for per-conflict risk assessment and reasoning. ` +
            `Accepting the merged result as the deployment configuration.`,
      context: {
        variableCount: Object.keys(resolved).length,
        conflictCount: conflicts.length,
        sources: {
          environment: Object.keys(environment.variables).length,
          partition: Object.keys(partition.variables).length,
          trigger: Object.keys(trigger.variables ?? {}).length,
        },
      },
    });
    deployment.debriefEntryIds.push(configEntry.id);

    return { variables: resolved, hasConflicts: conflicts.length > 0 };
  }

  // -----------------------------------------------------------------------
  // Reasoning: variable conflict risk assessment
  // -----------------------------------------------------------------------

  /**
   * Analyze all variable conflicts together and produce a risk assessment.
   *
   * This is where genuine reasoning happens — the decision depends on
   * the combination of factors across all conflicts, not just individual
   * pattern matches:
   *
   *   - A single cross-env connectivity var might be intentional partition config
   *   - Multiple cross-env connectivity vars are almost certainly misconfiguration
   *   - Sensitive vars get audit logging regardless of other factors
   *   - The assessed risk level determines whether to proceed or block
   */
  private assessConflictRisk(
    conflicts: VariableConflict[],
    environment: Environment,
  ): ConflictRiskAssessment {
    const details: ConflictDetail[] = [];
    let crossEnvConnectivityCount = 0;
    const crossEnvConnectivityVars: string[] = [];

    for (const conflict of conflicts) {
      const isCrossEnv = this.detectCrossEnvironmentPattern(
        conflict,
        environment.name,
      );
      const isConnectivity = CONNECTIVITY_VARIABLE_PATTERNS.some((p) =>
        p.test(conflict.variable),
      );
      const isSensitive = SENSITIVE_VARIABLE_PATTERNS.some((p) =>
        p.test(conflict.variable),
      );

      if (isCrossEnv && isConnectivity) {
        crossEnvConnectivityCount++;
        crossEnvConnectivityVars.push(conflict.variable);
        details.push({
          conflict,
          category: "cross-env-connectivity",
          riskContribution:
            `${conflict.variable} is a connectivity variable pointing to ` +
            `"${conflict.winnerValue}" in a ${environment.name} deployment — ` +
            `this could route traffic or data to the wrong environment`,
        });
      } else if (isCrossEnv) {
        details.push({
          conflict,
          category: "cross-env",
          riskContribution:
            `${conflict.variable} value "${conflict.winnerValue}" references ` +
            `a different environment than target "${environment.name}"`,
        });
      } else if (isSensitive) {
        details.push({
          conflict,
          category: "sensitive",
          riskContribution:
            `${conflict.variable} is security-sensitive and overridden at ${conflict.winner} level`,
        });
      } else {
        details.push({
          conflict,
          category: "standard",
          riskContribution:
            `${conflict.variable}: ${conflict.winner} value overrides ${conflict.loserLevel} value`,
        });
      }
    }

    // --- Decision logic: compound risk assessment ---

    // Multiple connectivity variables pointing cross-environment = block.
    // One might be intentional. Two or more is a pattern that indicates
    // the partition's variable bindings are wrong for this environment.
    if (crossEnvConnectivityCount >= 2) {
      return {
        action: "block",
        riskLevel: "high",
        reasoning:
          `${crossEnvConnectivityCount} connectivity variables ` +
          `(${crossEnvConnectivityVars.join(", ")}) are overridden with values ` +
          `referencing a different environment than the deployment target ` +
          `"${environment.name}". ${details.filter((d) => d.category === "cross-env-connectivity").map((d) => d.riskContribution).join(". ")}. ` +
          `A single cross-environment connectivity override might reflect ` +
          `intentional partition-specific infrastructure, but multiple overrides ` +
          `strongly suggest the partition's variable bindings are misconfigured ` +
          `for this environment. Blocking deployment to prevent cross-environment ` +
          `data access or traffic routing. To deploy with this configuration, ` +
          `verify the partition's variables are correct and re-trigger with explicit ` +
          `overrides at the trigger level.`,
        details,
      };
    }

    // Single cross-env connectivity var: proceed but flag as medium risk.
    if (crossEnvConnectivityCount === 1) {
      return {
        action: "proceed",
        riskLevel: "medium",
        reasoning:
          `One connectivity variable (${crossEnvConnectivityVars[0]}) is overridden ` +
          `with a value referencing a different environment than "${environment.name}". ` +
          `This may reflect intentional partition-specific infrastructure (e.g., a partition ` +
          `that maintains a shared database across environments) or may be ` +
          `misconfiguration. Proceeding with partition-level precedence because a single ` +
          `override does not establish a pattern of misconfiguration. The operator ` +
          `should verify this override is intentional.`,
        details,
      };
    }

    // Cross-env non-connectivity or sensitive-only: low risk, proceed
    return {
      action: "proceed",
      riskLevel: "low",
      reasoning:
        `Variable conflicts resolved via standard precedence rules ` +
        `(trigger > partition > environment). No high-risk cross-environment ` +
        `connectivity patterns detected.`,
      details,
    };
  }

  /**
   * Record debrief entries for each conflict category found in the assessment.
   */
  private recordConflictReasoning(
    deployment: Deployment,
    assessment: ConflictRiskAssessment,
    environment: Environment,
  ): void {
    // Group details by category for debrief entries
    const byCategory = new Map<string, ConflictDetail[]>();
    for (const detail of assessment.details) {
      const existing = byCategory.get(detail.category) ?? [];
      existing.push(detail);
      byCategory.set(detail.category, existing);
    }

    // Cross-env connectivity (the high-risk ones)
    const crossEnvConn = byCategory.get("cross-env-connectivity");
    if (crossEnvConn) {
      const entry = this.debrief.record({
        partitionId: deployment.partitionId,
        deploymentId: deployment.id,
        agent: "server",
        decisionType: "variable-conflict",
        decision:
          assessment.action === "block"
            ? `Blocking deployment: ${crossEnvConn.length} cross-environment connectivity conflict(s)`
            : `Cross-environment connectivity override detected in ${crossEnvConn.length} variable(s)`,
        reasoning: assessment.reasoning,
        context: {
          category: "cross-environment",
          riskLevel: assessment.riskLevel,
          action: assessment.action,
          conflicts: crossEnvConn.map((d) => ({
            variable: d.conflict.variable,
            winnerValue: d.conflict.winnerValue,
            loserValue: d.conflict.loserValue,
          })),
          targetEnvironment: environment.name,
        },
      });
      deployment.debriefEntryIds.push(entry.id);
    }

    // Cross-env non-connectivity
    const crossEnv = byCategory.get("cross-env");
    if (crossEnv) {
      const details = crossEnv
        .map((d) => d.riskContribution)
        .join("; ");
      const entry = this.debrief.record({
        partitionId: deployment.partitionId,
        deploymentId: deployment.id,
        agent: "server",
        decisionType: "variable-conflict",
        decision: `Cross-environment variable pattern in ${crossEnv.length} non-connectivity variable(s)`,
        reasoning:
          `Detected non-connectivity variable(s) referencing a different environment: ${details}. ` +
          `These are lower risk than connectivity variables because they don't affect ` +
          `data routing. Proceeding with standard precedence.`,
        context: {
          category: "cross-environment-non-connectivity",
          conflicts: crossEnv.map((d) => ({
            variable: d.conflict.variable,
            winnerValue: d.conflict.winnerValue,
            loserValue: d.conflict.loserValue,
          })),
        },
      });
      deployment.debriefEntryIds.push(entry.id);
    }

    // Sensitive overrides
    const sensitiveDetails = byCategory.get("sensitive");
    if (sensitiveDetails) {
      const entry = this.debrief.record({
        partitionId: deployment.partitionId,
        deploymentId: deployment.id,
        agent: "server",
        decisionType: "variable-conflict",
        decision: `Security-sensitive variable(s) overridden: ${sensitiveDetails.map((d) => d.conflict.variable).join(", ")}`,
        reasoning:
          `${sensitiveDetails.length} variable(s) matching security-sensitive patterns ` +
          `(secrets, keys, tokens, credentials) are being overridden by higher-precedence ` +
          `levels. ${sensitiveDetails.map((d) => d.riskContribution).join("; ")}. ` +
          `Applying precedence rules as configured. These overrides are recorded for ` +
          `audit purposes.`,
        context: {
          category: "sensitive-override",
          // Intentionally omit actual values for sensitive variables
          variables: sensitiveDetails.map((d) => ({
            variable: d.conflict.variable,
            overriddenBy: d.conflict.winner,
          })),
        },
      });
      deployment.debriefEntryIds.push(entry.id);
    }

    // Standard overrides
    const standardDetails = byCategory.get("standard");
    if (standardDetails) {
      const details = standardDetails
        .map(
          (d) =>
            `${d.conflict.variable}: used ${d.conflict.winner} value ` +
            `"${d.conflict.winnerValue}" over ${d.conflict.loserLevel} value ` +
            `"${d.conflict.loserValue}"`,
        )
        .join("; ");
      const entry = this.debrief.record({
        partitionId: deployment.partitionId,
        deploymentId: deployment.id,
        agent: "server",
        decisionType: "variable-conflict",
        decision: `Resolved ${standardDetails.length} variable conflict(s) via precedence rules`,
        reasoning:
          `Standard precedence applied (trigger > partition > environment). ` +
          `Conflicts: ${details}. These are routine overrides consistent ` +
          `with the configuration hierarchy.`,
        context: {
          category: "standard-override",
          conflicts: standardDetails.map((d) => ({
            variable: d.conflict.variable,
            winner: d.conflict.winner,
            winnerValue: d.conflict.winnerValue,
            loserLevel: d.conflict.loserLevel,
            loserValue: d.conflict.loserValue,
          })),
        },
      });
      deployment.debriefEntryIds.push(entry.id);
    }
  }

  /**
   * Detect if a variable's winning value might reference the wrong environment.
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

  // -----------------------------------------------------------------------
  // Pipeline step: pre-flight health check
  // -----------------------------------------------------------------------

  /**
   * Pre-flight health check with context-dependent retry logic.
   *
   * The retry strategy depends on the error type:
   *   - DNS failure → abort immediately (retrying won't fix infrastructure config)
   *   - Timeout in production → retry with extended backoff (service under load)
   *   - Connection refused → retry with standard backoff (process restarting)
   *   - After retries exhausted → fail with environment-appropriate reasoning
   */
  private async preflightHealthCheck(
    deployment: Deployment,
    partition: Partition,
    environment: Environment,
  ): Promise<void> {
    const serviceId = `${deployment.projectId}/${environment.name}`;
    const opts = this.getEffectiveOptions();
    const maxAttempts = opts.healthCheckRetries + 1;
    let attempt = 1;

    const firstCheck = await this.healthChecker.check(serviceId, {
      partitionId: partition.id,
      environmentName: environment.name,
    });

    if (firstCheck.reachable) {
      const entry = this.debrief.record({
        partitionId: deployment.partitionId,
        deploymentId: deployment.id,
        agent: "server",
        decisionType: "health-check",
        decision: `Proceeding with deployment — target environment "${environment.name}" confirmed healthy in ${firstCheck.responseTimeMs}ms`,
        reasoning:
          `Health check to "${environment.name}" returned a successful response ` +
          `in ${firstCheck.responseTimeMs}ms on the first attempt. This confirms ` +
          `the target infrastructure is running and network-accessible. No reason ` +
          `to delay — proceeding to deployment execution.`,
        context: {
          serviceId,
          responseTimeMs: firstCheck.responseTimeMs,
          attempt: 1,
        },
      });
      deployment.debriefEntryIds.push(entry.id);
      return;
    }

    // First check failed — reason about what to do
    const decision = this.reasonAboutHealthFailure(
      firstCheck,
      environment,
      attempt,
      maxAttempts,
      opts,
    );

    if (decision.action === "abort") {
      // Reasoning determined retrying won't help (e.g., DNS failure)
      const abortEntry = this.debrief.record({
        partitionId: deployment.partitionId,
        deploymentId: deployment.id,
        agent: "server",
        decisionType: "health-check",
        decision: "Pre-flight health check failed — aborting without retry",
        reasoning: decision.reasoning,
        context: {
          serviceId,
          error: firstCheck.error,
          errorCategory: this.categorizeError(firstCheck.error),
          attempt,
          retriesSkipped: true,
        },
      });
      deployment.debriefEntryIds.push(abortEntry.id);

      throw new OrchestrationError(
        "preflight-health-check",
        `Target environment "${environment.name}" unreachable: ${firstCheck.error}`,
        decision.reasoning,
      );
    }

    // Decision is to retry
    const retryEntry = this.debrief.record({
      partitionId: deployment.partitionId,
      deploymentId: deployment.id,
      agent: "server",
      decisionType: "health-check",
      decision: "Pre-flight health check failed — attempting retry",
      reasoning: decision.reasoning,
      context: {
        serviceId,
        error: firstCheck.error,
        errorCategory: this.categorizeError(firstCheck.error),
        backoffMs: decision.delayMs,
        retriesRemaining: maxAttempts - attempt,
        attempt,
      },
    });
    deployment.debriefEntryIds.push(retryEntry.id);

    // Retry loop — each iteration re-evaluates the situation
    for (let i = 0; i < opts.healthCheckRetries; i++) {
      attempt++;
      await this.delay(decision.delayMs);

      const retryCheck = await this.healthChecker.check(serviceId, {
        partitionId: partition.id,
        environmentName: environment.name,
      });

      if (retryCheck.reachable) {
        const recoveryEntry = this.debrief.record({
          partitionId: deployment.partitionId,
          deploymentId: deployment.id,
          agent: "server",
          decisionType: "health-check",
          decision:
            "Health check recovered on retry — proceeding with deployment",
          reasoning:
            `Retry attempt ${i + 1} succeeded (response time: ` +
            `${retryCheck.responseTimeMs}ms). The initial failure was transient — ` +
            `likely caused by a brief service restart or momentary load spike. ` +
            `Target environment "${environment.name}" is now confirmed healthy. ` +
            `Proceeding with deployment.`,
          context: {
            serviceId,
            responseTimeMs: retryCheck.responseTimeMs,
            attempt,
            recoveredAfterMs: decision.delayMs * (i + 1),
          },
        });
        deployment.debriefEntryIds.push(recoveryEntry.id);
        return;
      }
    }

    // All retries exhausted — produce context-aware failure
    const exhaustedDecision = this.reasonAboutHealthFailure(
      firstCheck,
      environment,
      maxAttempts,
      maxAttempts,
      opts,
    );

    throw new OrchestrationError(
      "preflight-health-check",
      `Target environment "${environment.name}" unreachable after ${maxAttempts} attempt(s)`,
      exhaustedDecision.reasoning,
    );
  }

  // -----------------------------------------------------------------------
  // Reasoning: health check failure analysis
  // -----------------------------------------------------------------------

  /**
   * Analyze a health check failure and decide what to do.
   *
   * The decision depends on three factors:
   *   1. Error type (DNS vs timeout vs connection refused vs server error)
   *   2. Environment context (production gets more patience)
   *   3. Whether retries remain
   *
   * Different factor combinations produce different actions:
   *   - DNS failure → abort immediately regardless of retries remaining
   *   - Timeout + production + retries remaining → retry with extended backoff
   *   - Connection refused + retries remaining → retry with standard backoff
   *   - Any error + no retries remaining → abort with environment-specific message
   */
  private reasonAboutHealthFailure(
    checkResult: HealthCheckResult,
    environment: Environment,
    attempt: number,
    maxAttempts: number,
    opts: AgentOptions = this.options,
  ): HealthDecision {
    const errorCategory = this.categorizeError(checkResult.error);
    const isProduction =
      environment.name.toLowerCase() === "production";
    const retriesRemaining = maxAttempts - attempt;

    // DNS failures are infrastructure-level — retrying won't help
    if (errorCategory === "dns") {
      return {
        action: "abort",
        delayMs: 0,
        reasoning:
          `DNS resolution failed for "${environment.name}" (${checkResult.error}). ` +
          `This is an infrastructure configuration issue, not a transient failure — ` +
          `retrying will not resolve it. The environment's hostname cannot be resolved, ` +
          `which typically indicates the service has not been provisioned or DNS records ` +
          `are misconfigured. Recommended action: verify DNS configuration for the ` +
          `target environment.`,
      };
    }

    // No retries remaining — produce context-aware abort
    if (retriesRemaining <= 0) {
      const envContext = isProduction
        ? `This is a production environment — deploying to unreachable production ` +
          `infrastructure would create a silent failure with no running service ` +
          `to handle traffic.`
        : `Aborting to prevent deploying artifacts to infrastructure that ` +
          `cannot serve them.`;

      return {
        action: "abort",
        delayMs: 0,
        reasoning:
          `${attempt} health check attempt(s) to "${environment.name}" all failed ` +
          `(error: ${checkResult.error ?? "service unreachable"}, ` +
          `category: ${errorCategory}). Consecutive failures indicate a persistent ` +
          `infrastructure issue rather than a transient glitch. ${envContext} ` +
          `Recommended action: verify the target environment's infrastructure is ` +
          `running and network-accessible, then re-trigger the deployment.`,
      };
    }

    // Timeout in production → extended backoff (service may be under load)
    if (errorCategory === "timeout" && isProduction) {
      const extendedDelay = opts.healthCheckBackoffMs * 2;
      return {
        action: "retry",
        delayMs: extendedDelay,
        reasoning:
          `Health check to production environment "${environment.name}" timed out ` +
          `(${checkResult.error}). Production services under heavy load may respond ` +
          `slowly rather than refusing connections outright. Using extended backoff ` +
          `(${extendedDelay}ms instead of ${opts.healthCheckBackoffMs}ms) ` +
          `to allow the service time to recover before retrying. ` +
          `${retriesRemaining} retry attempt(s) remaining.`,
      };
    }

    // Server error (5xx) → the service is running but unhealthy
    if (errorCategory === "server_error") {
      return {
        action: "retry",
        delayMs: opts.healthCheckBackoffMs,
        reasoning:
          `Health check to "${environment.name}" returned a server error ` +
          `(${checkResult.error}). The service is running and network-reachable ` +
          `but reporting unhealthy status — this could be a transient condition ` +
          `during startup or a cascading failure from an upstream dependency. ` +
          `Retrying in ${opts.healthCheckBackoffMs}ms. ` +
          `${retriesRemaining} retry attempt(s) remaining.`,
      };
    }

    // Connection refused or unknown → standard retry
    return {
      action: "retry",
      delayMs: opts.healthCheckBackoffMs,
      reasoning:
        `Health check to "${environment.name}" failed ` +
        `(${checkResult.error ?? "service unreachable"}, category: ${errorCategory}). ` +
        `The service process may be restarting or not yet started. ` +
        `Retrying in ${opts.healthCheckBackoffMs}ms. ` +
        `${retriesRemaining} retry attempt(s) remaining.`,
    };
  }

  /**
   * Categorize a health check error string into a semantic type.
   * This drives the retry/abort decision tree.
   */
  private categorizeError(error: string | null): ErrorCategory {
    if (!error) return "unknown";
    const lower = error.toLowerCase();
    if (
      lower.includes("dns") ||
      lower.includes("enotfound") ||
      lower.includes("getaddrinfo")
    )
      return "dns";
    if (
      lower.includes("timeout") ||
      lower.includes("etimedout") ||
      lower.includes("timed out")
    )
      return "timeout";
    if (
      lower.includes("econnrefused") ||
      lower.includes("connection refused")
    )
      return "connection_refused";
    if (
      lower.includes("500") ||
      lower.includes("502") ||
      lower.includes("503")
    )
      return "server_error";
    return "unknown";
  }

  // -----------------------------------------------------------------------
  // Pipeline steps: execute and verify
  // -----------------------------------------------------------------------

  private async executeDeployment(
    deployment: Deployment,
    partition: Partition,
    environment: Environment,
  ): Promise<void> {
    const entry = this.debrief.record({
      partitionId: deployment.partitionId,
      deploymentId: deployment.id,
      agent: "server",
      decisionType: "deployment-execution",
      decision: `Executing ${deployment.projectId} v${deployment.version} on "${environment.name}" for partition "${partition.name}" — delegating to Envoy`,
      reasoning:
        `All preconditions passed: configuration accepted (${Object.keys(deployment.variables).length} variable(s), ` +
        `conflicts resolved), health check confirmed "${environment.name}" is reachable. ` +
        `Delegating execution to the Envoy agent on the target machine. The Envoy will ` +
        `write deployment artifacts (manifest, variables, version marker), verify them locally, ` +
        `and report back. If the Envoy is unreachable, this step will fail with a connection ` +
        `error — check that the Envoy process is running on the target host.`,
      context: {
        step: "execute-deployment",
        projectId: deployment.projectId,
        version: deployment.version,
        variableCount: Object.keys(deployment.variables).length,
        partitionName: partition.name,
        environmentName: environment.name,
      },
    });
    deployment.debriefEntryIds.push(entry.id);

    await this.delay(this.getEffectiveOptions().executionDelayMs);
  }

  private async postDeployVerify(
    deployment: Deployment,
    partition: Partition,
    environment: Environment,
  ): Promise<void> {
    const entry = this.debrief.record({
      partitionId: deployment.partitionId,
      deploymentId: deployment.id,
      agent: "server",
      decisionType: "deployment-verification",
      decision: `Verified: ${deployment.projectId} v${deployment.version} deployed successfully to "${environment.name}" for partition "${partition.name}"`,
      reasoning:
        `Deployment execution completed without errors. Verification confirms: (1) no ` +
        `execution errors were raised, (2) no rollback was triggered, (3) the Envoy ` +
        `reported successful artifact placement. ${Object.keys(deployment.variables).length} ` +
        `variable(s) applied. Note: this is server-side verification based on execution ` +
        `outcome — the Envoy's own local verification (artifact checksums, service ` +
        `health) provides the ground-truth confirmation in its debrief entries.`,
      context: {
        step: "post-deploy-verify",
        variableCount: Object.keys(deployment.variables).length,
        projectId: deployment.projectId,
        version: deployment.version,
      },
    });
    deployment.debriefEntryIds.push(entry.id);
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

export class InMemoryDeploymentStore implements DeploymentStore {
  private deployments: Map<DeploymentId, Deployment> = new Map();

  save(deployment: Deployment): void {
    this.deployments.set(deployment.id, deployment);
  }

  get(id: DeploymentId): Deployment | undefined {
    return this.deployments.get(id);
  }

  getByPartition(partitionId: string): Deployment[] {
    return [...this.deployments.values()].filter(
      (d) => d.partitionId === partitionId,
    );
  }

  list(): Deployment[] {
    return [...this.deployments.values()];
  }
}
