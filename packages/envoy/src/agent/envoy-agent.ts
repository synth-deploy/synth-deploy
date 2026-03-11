import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  DebriefWriter,
  DebriefEntry,
  DeploymentId,
  PartitionId,
  EnvironmentId,
  PlannedStep,
  SecurityBoundary,
  ArtifactAnalysis,
  DeploymentPlan,
} from "@synth-deploy/core";
import { LlmClient } from "@synth-deploy/core";
import type { EnvoyKnowledgeStore, LocalDeploymentRecord } from "../state/knowledge-store.js";
import { EnvironmentScanner } from "./environment-scanner.js";
import type { ServerReporter } from "./server-reporter.js";
import { DiagnosticInvestigator } from "./diagnostic-investigator.js";
import type { DiagnosticReport } from "./diagnostic-investigator.js";
import {
  DefaultOperationExecutor,
  DefaultOperationRegistry,
  BoundaryValidator,
  createPlatformAdapter,
  ServiceHandler,
  FileHandler,
  ConfigHandler,
  ProcessHandler,
  ContainerHandler,
  VerifyHandler,
} from "../execution/index.js";
import type { DryRunPlanResult } from "../execution/operation-executor.js";
import { createCallbackReporter } from "../execution/progress-reporter.js";

// ---------------------------------------------------------------------------
// Types — lifecycle state and deployment instruction/result
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of the Envoy.
 * - "active": accepting and executing deployments normally
 * - "draining": finishing in-flight deployments but rejecting new ones
 * - "paused": rejecting all new deployments immediately
 */
export type LifecycleState = "active" | "draining" | "paused";

// ---------------------------------------------------------------------------
// Types — the Envoy's deployment instruction and result
// ---------------------------------------------------------------------------

/**
 * What the Server sends to the Envoy when it wants a deployment executed.
 */
export interface DeploymentInstruction {
  deploymentId: DeploymentId;
  partitionId: PartitionId;
  environmentId: EnvironmentId;
  operationId: string;
  version: string;
  variables: Record<string, string>;
  /** Name of the environment (for reasoning — "production" vs "staging" matters) */
  environmentName: string;
  /** Name of the partition (for debrief entries) */
  partitionName: string;
  /** Optional planned steps from the Command agent — when provided, the
   *  OperationExecutor runs these through platform-aware handlers with
   *  boundary validation and automatic rollback on failure */
  plan?: PlannedStep[];
  /** Security boundaries to validate plan steps against */
  boundaries?: SecurityBoundary[];
  /** URL to POST progress events to during execution (provided by Command) */
  progressCallbackUrl?: string;
}

/**
 * What the Envoy returns to the Server after executing a deployment.
 */
export interface DeploymentResult {
  deploymentId: DeploymentId;
  success: boolean;
  /** Where the deployment artifacts live on this machine */
  workspacePath: string;
  /** Files created during deployment */
  artifacts: string[];
  /** Duration of the execution phase */
  executionDurationMs: number;
  /** Duration of the full process (scan + execute + verify) */
  totalDurationMs: number;
  /** Whether post-deploy verification passed */
  verificationPassed: boolean;
  /** Detailed verification checks */
  verificationChecks: Array<{ name: string; passed: boolean; detail: string }>;
  /** If failed, why */
  failureReason: string | null;
  /** Detailed diagnostic investigation — populated when a failure is investigated */
  diagnostic: DiagnosticReport | null;
  /** IDs of all debrief entries created during this deployment */
  debriefEntryIds: string[];
  /** Full debrief entries — the Envoy's reasoning, sent back to the Server */
  debriefEntries: DebriefEntry[];
}

// ---------------------------------------------------------------------------
// Types — planning instruction (plan+execute two-phase flow)
// ---------------------------------------------------------------------------

/**
 * What the Command agent sends when it wants the Envoy to reason about
 * how to deploy an artifact. The Envoy produces a DeploymentPlan that
 * the user can review and approve before execution begins.
 *
 * This is the input to the planning phase — read-only, zero side effects.
 */
export interface PlanningInstruction {
  deploymentId: string;
  artifact: {
    id: string;
    name: string;
    type: string;
    analysis: ArtifactAnalysis;
  };
  environment: {
    id: string;
    name: string;
    variables: Record<string, string>;
  };
  partition?: {
    id: string;
    name: string;
    variables: Record<string, string>;
  };
  version: string;
  resolvedVariables: Record<string, string>;
  /**
   * LLM API key forwarded from the Server's runtime configuration.
   * Used when the Envoy process started without SYNTH_LLM_API_KEY set.
   * Never recorded in debrief or persisted — used for this call only.
   */
  llmApiKey?: string;
}

/**
 * What the Envoy returns after planning — includes the deployment plan,
 * a rollback plan, and an optional delta summary comparing to the last
 * successful plan for this artifact type + environment.
 *
 * When `blocked` is true the plan cannot be executed — the user must resolve
 * the infrastructure issues listed in `blockReason` before proceeding.
 * The server must not transition to awaiting_approval in this case.
 */
export interface PlanningResult {
  plan: DeploymentPlan;
  rollbackPlan: DeploymentPlan;
  delta?: string;
  /** True when unrecoverable precondition failures prevent execution */
  blocked?: boolean;
  /** Human-readable explanation of what must be fixed before proceeding */
  blockReason?: string;
}

/**
 * Input for post-hoc rollback plan generation — used when the user requests
 * a rollback plan from the Debrief, after a deployment has already run.
 *
 * Unlike PlanningInstruction (which is forward-planning before execution),
 * this is backward-planning based on what actually happened.
 */
export interface RollbackPlanningInstruction {
  deploymentId: string;
  artifact: {
    name: string;
    type: string;
    analysis: ArtifactAnalysis;
  };
  environment: {
    id: string;
    name: string;
  };
  /** Steps that actually executed during the deployment (from executionRecord). */
  completedSteps: Array<{
    description: string;
    action: string;
    target: string;
    status: "completed" | "failed" | "rolled_back";
    output?: string;
  }>;
  /** The variables that were active when the deployment ran. */
  deployedVariables: Record<string, string>;
  version: string;
  /** If the deployment failed, the reason — informs what needs undoing. */
  failureReason?: string;
  /**
   * LLM API key forwarded from the Server's runtime configuration.
   * Used when the Envoy process started without SYNTH_LLM_API_KEY set.
   * Never recorded in debrief or persisted — used for this call only.
   */
  llmApiKey?: string;
}

/**
 * Verification result for workspace artifact checks.
 */
interface VerificationResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

/**
 * Result of executing workspace artifacts or deployment operations.
 */
export interface ExecutionResult {
  success: boolean;
  workspacePath: string;
  artifacts: string[];
  durationMs: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// EnvoyAgent — the local reasoning engine
// ---------------------------------------------------------------------------

/**
 * The Envoy Agent is the local intelligence on the machine where
 * software actually runs.
 *
 * Unlike a passive deployment agent that receives and executes instructions
 * blindly, the EnvoyAgent:
 *
 * 1. Scans the local environment before deploying — what's already here?
 *    Is this machine ready? Are there conflicts with what's deployed?
 *
 * 2. Executes the deployment — either writing workspace artifacts (default)
 *    or running a full plan through the OperationExecutor when the Command
 *    agent provides planned steps with platform-aware handlers, boundary
 *    validation, and automatic rollback on failure.
 *
 * 3. Verifies locally — checks that what was supposed to be deployed is
 *    actually deployed and in the expected state.
 *
 * 4. Records everything to its own Debrief — the Envoy's reasoning
 *    about local events, separate from the Server's reasoning about
 *    orchestration decisions.
 *
 * Every decision is recorded with agent type "envoy" so the debrief
 * clearly shows which agent made which decision.
 */
export class EnvoyAgent {
  private operationExecutor: DefaultOperationExecutor | null = null;
  private operationRegistry: DefaultOperationRegistry | null = null;
  private scanner: EnvironmentScanner;
  private investigator: DiagnosticInvestigator;
  private reporter: ServerReporter | null;
  private llmClient: LlmClient | null;
  private _lifecycleState: LifecycleState = "active";
  private executorReady: Promise<void>;

  constructor(
    private debrief: DebriefWriter,
    private state: EnvoyKnowledgeStore,
    private baseDir: string,
    reporter?: ServerReporter,
    llm?: LlmClient,
  ) {
    this.scanner = new EnvironmentScanner(baseDir, state);
    this.investigator = new DiagnosticInvestigator(state, llm);
    this.reporter = reporter ?? null;
    this.llmClient = llm ?? null;

    // Initialize the operation executor asynchronously — platform detection
    // requires dynamic imports
    this.executorReady = this.initExecutor();
  }

  private async initExecutor(): Promise<void> {
    const adapter = await createPlatformAdapter();
    const registry = new DefaultOperationRegistry();

    // Register all handlers in order of specificity
    registry.register(new ServiceHandler(adapter));
    registry.register(new FileHandler(adapter));
    registry.register(new ConfigHandler());
    registry.register(new ContainerHandler());
    registry.register(new ProcessHandler());
    registry.register(new VerifyHandler());

    this.operationRegistry = registry;

    // Pass the registry to the validator so it derives classification
    // from registered handler vocabularies instead of a hardcoded list
    const validator = new BoundaryValidator(registry);
    this.operationExecutor = new DefaultOperationExecutor(
      registry,
      validator,
      adapter.platform,
      this.debrief,
    );

    // Probe for installed tools in background — results are cached
    // in the scanner for subsequent scan() calls
    await this.scanner.scanTools();
  }

  // -------------------------------------------------------------------------
  // Lifecycle management
  // -------------------------------------------------------------------------

  /** Current lifecycle state of this Envoy. */
  get lifecycleState(): LifecycleState {
    return this._lifecycleState;
  }

  /**
   * Transition to "draining" — finish in-flight deployments but reject new ones.
   */
  drain(): void {
    this._lifecycleState = "draining";
  }

  /**
   * Transition to "paused" — reject all new deployments immediately.
   */
  pause(): void {
    this._lifecycleState = "paused";
  }

  /**
   * Resume normal operation — accept deployments again.
   */
  resume(): void {
    this._lifecycleState = "active";
  }

  /**
   * Validate plan steps against security boundaries without executing.
   * Used by Command to verify user-modified plans are feasible.
   */
  async validatePlanSteps(
    steps: PlannedStep[],
    boundaries: SecurityBoundary[] = [],
  ): Promise<{
    valid: boolean;
    violations: Array<{ step: string; reason: string }>;
  }> {
    await this.executorReady;

    const result = new BoundaryValidator().validatePlan(steps, boundaries);

    return {
      valid: result.allowed,
      violations: result.violations.map((v) => ({
        step: v.step.description,
        reason: v.reason ?? "Violates security boundary",
      })),
    };
  }

  /**
   * Execute a deployment on this machine.
   *
   * Pipeline:
   * 1. Record receipt of deployment instruction
   * 2. Scan local environment — is this machine ready?
   * 3. Check for conflicts with current state
   * 4. Execute the deployment (workspace artifacts or full plan)
   * 5. Verify the deployment locally
   * 6. Update local state
   * 7. Report result
   *
   * When `instruction.plan` is provided, the OperationExecutor handles
   * step execution through platform-aware handlers with boundary
   * validation and automatic rollback. Otherwise, workspace artifacts
   * are written directly (manifest, variables, version, status markers).
   */
  async executeDeployment(
    instruction: DeploymentInstruction,
  ): Promise<DeploymentResult> {
    // Ensure executor is initialized
    await this.executorReady;

    // --- Lifecycle guard: reject new deployments when draining or paused ----
    if (this._lifecycleState !== "active") {
      const reason =
        this._lifecycleState === "draining"
          ? "Envoy is draining — finishing in-flight deployments but rejecting new ones"
          : "Envoy is paused — not accepting deployments";

      return {
        deploymentId: instruction.deploymentId,
        success: false,
        workspacePath: "",
        artifacts: [],
        executionDurationMs: 0,
        totalDurationMs: 0,
        verificationPassed: false,
        verificationChecks: [],
        failureReason: reason,
        diagnostic: null,
        debriefEntryIds: [],
        debriefEntries: [],
      };
    }

    const totalStart = Date.now();
    const debriefEntryIds: string[] = [];
    const debriefEntries: DebriefEntry[] = [];

    const recordEntry = (params: Parameters<DebriefWriter["record"]>[0]): DebriefEntry => {
      const entry = this.debrief.record(params);
      debriefEntryIds.push(entry.id);
      debriefEntries.push(entry);
      return entry;
    };

    // --- Step 1: Record receipt ------------------------------------------------

    recordEntry({
      partitionId: instruction.partitionId,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "pipeline-plan",
      decision:
        `Received deployment instruction: ${instruction.operationId} ` +
        `v${instruction.version} → ${instruction.environmentName}`,
      reasoning:
        `Server delegated execution of ${instruction.operationId} ` +
        `v${instruction.version} to this Envoy for partition ` +
        `"${instruction.partitionName}" on environment ` +
        `"${instruction.environmentName}". Beginning local execution ` +
        `pipeline: environment-scan → execute → verify → update-state.`,
      context: {
        operationId: instruction.operationId,
        version: instruction.version,
        environmentName: instruction.environmentName,
        partitionName: instruction.partitionName,
        variableCount: Object.keys(instruction.variables).length,
        hasPlan: !!instruction.plan,
      },
    });

    // --- Step 2: Scan local environment ----------------------------------------

    const readiness = this.scanner.checkReadiness();

    if (!readiness.ready) {
      recordEntry({
        partitionId: instruction.partitionId,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "environment-scan",
        decision: "Local environment not ready — aborting deployment",
        reasoning:
          `Environment scan failed: ${readiness.reason} ` +
          `The Envoy cannot execute deployments until the local ` +
          `workspace is available and writable. This is an infrastructure ` +
          `issue on the target machine, not a deployment configuration ` +
          `problem. Recommended action: verify the Envoy's workspace ` +
          `directory exists and has correct permissions.`,
        context: { ready: false, reason: readiness.reason },
      });

      return {
        deploymentId: instruction.deploymentId,
        success: false,
        workspacePath: "",
        artifacts: [],
        executionDurationMs: 0,
        totalDurationMs: Date.now() - totalStart,
        verificationPassed: false,
        verificationChecks: [],
        failureReason: `Local environment not ready: ${readiness.reason}`,
        diagnostic: null,
        debriefEntryIds,
        debriefEntries,
      };
    }

    const scanResult = this.scanner.scan();
    const existingEnv = this.state.getEnvironment(
      instruction.partitionId,
      instruction.environmentId,
    );

    recordEntry({
      partitionId: instruction.partitionId,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "environment-scan",
      decision: existingEnv
        ? `Environment scan complete — upgrading from v${existingEnv.currentVersion} to v${instruction.version}`
        : `Environment scan complete — first deployment to "${instruction.environmentName}"`,
      reasoning: existingEnv
        ? `Local environment "${instruction.environmentName}" currently has ` +
          `${instruction.operationId} v${existingEnv.currentVersion} deployed ` +
          `(deployment ${existingEnv.currentDeploymentId}). This deployment ` +
          `will upgrade to v${instruction.version}. ` +
          `${scanResult.disk.deploymentCount} previous deployment(s) exist ` +
          `on disk. Workspace is writable and ready.`
        : `No previous deployment found for "${instruction.environmentName}" ` +
          `on this machine. This is the first deployment of ` +
          `${instruction.operationId} to this environment for partition ` +
          `"${instruction.partitionName}". ` +
          `${scanResult.disk.deploymentCount} other deployment(s) exist on disk. ` +
          `Workspace is writable and ready.`,
      context: {
        hostname: scanResult.hostname,
        deploymentsDir: scanResult.deploymentsDir,
        writable: scanResult.deploymentsWritable,
        existingDeployments: scanResult.disk.deploymentCount,
        previousVersion: existingEnv?.currentVersion ?? null,
        previousDeploymentId: existingEnv?.currentDeploymentId ?? null,
      },
    });

    // --- Step 3: Record to local state -----------------------------------------

    const localRecord = this.state.recordDeployment({
      deploymentId: instruction.deploymentId,
      partitionId: instruction.partitionId,
      environmentId: instruction.environmentId,
      operationId: instruction.operationId,
      version: instruction.version,
      variables: instruction.variables,
      workspacePath: `${this.baseDir}/deployments/${instruction.deploymentId}`,
    });

    // --- Step 4: Execute -------------------------------------------------------

    // Branch: if a plan was provided by Command, use the OperationExecutor.
    // Otherwise, write workspace artifacts directly (the default path).
    if (instruction.plan && instruction.plan.length > 0) {
      return this.executePlan(
        instruction,
        localRecord,
        totalStart,
        debriefEntryIds,
        debriefEntries,
        recordEntry,
      );
    }

    return this.executeWorkspaceArtifacts(
      instruction,
      localRecord,
      totalStart,
      debriefEntryIds,
      debriefEntries,
      recordEntry,
    );
  }

  // -------------------------------------------------------------------------
  // Execution path: OperationExecutor (plan-based)
  // -------------------------------------------------------------------------

  /**
   * Execute a deployment plan through the OperationExecutor.
   * Used when the Command agent provides planned steps.
   */
  private async executePlan(
    instruction: DeploymentInstruction,
    localRecord: LocalDeploymentRecord,
    totalStart: number,
    debriefEntryIds: string[],
    debriefEntries: DebriefEntry[],
    recordEntry: (params: Parameters<DebriefWriter["record"]>[0]) => DebriefEntry,
  ): Promise<DeploymentResult> {
    const steps = instruction.plan!;
    const boundaries = instruction.boundaries ?? [];

    recordEntry({
      partitionId: instruction.partitionId,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "deployment-execution",
      decision:
        `Executing plan: ${steps.length} step(s) for ${instruction.operationId} ` +
        `v${instruction.version} via OperationExecutor`,
      reasoning:
        `Environment scan passed. Executing ${steps.length} planned step(s) ` +
        `via the OperationExecutor with ${boundaries.length} security boundary ` +
        `constraint(s). Steps: ${steps.map((s) => s.description).join("; ")}. ` +
        `All steps are validated against security boundaries before any execution begins. ` +
        `If any step fails, completed steps will be automatically rolled back in reverse order.`,
      context: {
        step: "execute",
        workspacePath: localRecord.workspacePath,
        stepCount: steps.length,
        boundaryCount: boundaries.length,
        steps: steps.map((s) => ({ action: s.action, target: s.target, description: s.description })),
      },
    });

    const execStart = Date.now();
    const planResult = await this.operationExecutor!.executePlan(
      steps,
      boundaries,
      undefined,
      instruction.deploymentId,
    );
    const execDurationMs = Date.now() - execStart;

    if (!planResult.success) {
      const failedResult = planResult.results.find((r) => r.status === "failed");
      const errorMsg = failedResult?.error ?? "Unknown execution error";

      this.state.completeDeployment(instruction.deploymentId, "failed", errorMsg);

      const diagnostic = this.investigator.investigate(
        localRecord.workspacePath,
        instruction,
        { success: false, workspacePath: localRecord.workspacePath, artifacts: [], durationMs: execDurationMs, error: errorMsg },
      );

      recordEntry({
        partitionId: instruction.partitionId,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "deployment-failure",
        decision: `Plan execution failed at step ${(planResult.failedStepIndex ?? 0) + 1}/${steps.length}: ${errorMsg}`,
        reasoning:
          `Execution failed on step "${steps[planResult.failedStepIndex ?? 0]?.description ?? "unknown"}". ` +
          `Error: ${errorMsg}. ` +
          `${planResult.rollbackResults ? `Automatic rollback was executed on ${planResult.rollbackResults.length} completed step(s). ` : ""}` +
          `The environment should be in its previous state. Total execution time: ${execDurationMs}ms.`,
        context: { step: "execute", error: errorMsg, durationMs: execDurationMs, failedStepIndex: planResult.failedStepIndex },
      });

      recordEntry({
        partitionId: instruction.partitionId,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "diagnostic-investigation",
        decision: `Investigation: ${diagnostic.summary}`,
        reasoning: `Root cause: ${diagnostic.rootCause} Recommendation: ${diagnostic.recommendation}`,
        context: { diagnostic, evidenceCount: diagnostic.evidence.length, failureType: diagnostic.failureType },
      });

      const failResult: DeploymentResult = {
        deploymentId: instruction.deploymentId,
        success: false,
        workspacePath: localRecord.workspacePath,
        artifacts: [],
        executionDurationMs: execDurationMs,
        totalDurationMs: Date.now() - totalStart,
        verificationPassed: false,
        verificationChecks: [],
        failureReason: errorMsg,
        diagnostic,
        debriefEntryIds,
        debriefEntries,
      };
      this.reportToServer(failResult);
      return failResult;
    }

    // Collect artifact names from completed steps
    const artifacts = planResult.results
      .filter((r) => r.status === "completed")
      .map((r) => r.step.description);

    // Update state and record completion
    this.state.completeDeployment(instruction.deploymentId, "succeeded");
    this.state.updateEnvironment(instruction.partitionId, instruction.environmentId, {
      currentVersion: instruction.version,
      currentDeploymentId: instruction.deploymentId,
      activeVariables: instruction.variables,
    });

    const totalDurationMs = Date.now() - totalStart;

    recordEntry({
      partitionId: instruction.partitionId,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "deployment-verification",
      decision: `Plan execution verified — all ${planResult.results.length} steps completed`,
      reasoning:
        `All ${planResult.results.length} planned steps executed successfully ` +
        `in ${execDurationMs}ms. Each step was validated against security boundaries ` +
        `and executed through platform-aware handlers.`,
      context: { step: "verify", passed: true, stepCount: planResult.results.length },
    });

    recordEntry({
      partitionId: instruction.partitionId,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "deployment-completion",
      decision:
        `Deployment complete: ${instruction.operationId} ` +
        `v${instruction.version} is now live on "${instruction.environmentName}"`,
      reasoning:
        `Full local pipeline completed successfully: environment scan ` +
        `confirmed readiness, ${planResult.results.length} execution step(s) ` +
        `completed via OperationExecutor. Local state updated — ` +
        `"${instruction.environmentName}" now runs v${instruction.version} ` +
        `for partition "${instruction.partitionName}". ` +
        `Total execution time: ${totalDurationMs}ms.`,
      context: {
        step: "complete",
        artifacts,
        executionDurationMs: execDurationMs,
        totalDurationMs,
        workspacePath: localRecord.workspacePath,
        executedSteps: planResult.results.length,
      },
    });

    const successResult: DeploymentResult = {
      deploymentId: instruction.deploymentId,
      success: true,
      workspacePath: localRecord.workspacePath,
      artifacts,
      executionDurationMs: execDurationMs,
      totalDurationMs,
      verificationPassed: true,
      verificationChecks: planResult.results.map((r) => ({
        name: r.step.action,
        passed: r.status === "completed",
        detail: r.output || r.step.description,
      })),
      failureReason: null,
      diagnostic: null,
      debriefEntryIds,
      debriefEntries,
    };
    this.reportToServer(successResult);
    return successResult;
  }

  // -------------------------------------------------------------------------
  // Execution path: workspace artifacts (default, backwards-compatible)
  // -------------------------------------------------------------------------

  /**
   * Write workspace artifacts directly — the default execution path when
   * no plan is provided. This is equivalent to what DeploymentExecutor did.
   */
  private async executeWorkspaceArtifacts(
    instruction: DeploymentInstruction,
    localRecord: LocalDeploymentRecord,
    totalStart: number,
    debriefEntryIds: string[],
    debriefEntries: DebriefEntry[],
    recordEntry: (params: Parameters<DebriefWriter["record"]>[0]) => DebriefEntry,
  ): Promise<DeploymentResult> {
    recordEntry({
      partitionId: instruction.partitionId,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "deployment-execution",
      decision:
        `Executing deployment: writing ${instruction.operationId} ` +
        `v${instruction.version} artifacts to ${localRecord.workspacePath}`,
      reasoning:
        `Environment scan passed. Local workspace is ready at ${localRecord.workspacePath}. ` +
        `Writing 4 artifacts: manifest.json (deployment metadata), variables.env ` +
        `(${Object.keys(instruction.variables).length} resolved variable(s)), VERSION ` +
        `(marker: ${instruction.version}), STATUS (marker: DEPLOYING). These artifacts ` +
        `represent the deployed state of ${instruction.operationId} v${instruction.version} ` +
        `on "${instruction.environmentName}" for partition ${instruction.partitionId}. If this ` +
        `step fails, check filesystem permissions on the workspace directory and available disk space.`,
      context: {
        step: "execute",
        workspacePath: localRecord.workspacePath,
        variableCount: Object.keys(instruction.variables).length,
      },
    });

    const execResult = this.writeWorkspaceArtifacts(instruction, localRecord);

    if (!execResult.success) {
      this.state.completeDeployment(
        instruction.deploymentId,
        "failed",
        execResult.error,
      );

      const diagnostic = this.investigator.investigate(
        execResult.workspacePath,
        instruction,
        execResult,
      );

      recordEntry({
        partitionId: instruction.partitionId,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "deployment-failure",
        decision: `Deployment execution failed: ${execResult.error}`,
        reasoning:
          `Failed to write deployment artifacts to local workspace at ` +
          `"${execResult.workspacePath}". Error: ${execResult.error}. ` +
          `This indicates a local filesystem issue — the Envoy was ` +
          `unable to create or write to the deployment directory. ` +
          `No artifacts were deployed. The environment remains in its ` +
          `previous state. Recommended action: check filesystem ` +
          `permissions and available disk space on the target machine.`,
        context: {
          step: "execute",
          error: execResult.error,
          workspacePath: execResult.workspacePath,
          durationMs: execResult.durationMs,
        },
      });

      recordEntry({
        partitionId: instruction.partitionId,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "diagnostic-investigation",
        decision: `Investigation: ${diagnostic.summary}`,
        reasoning:
          `Root cause: ${diagnostic.rootCause} ` +
          `Recommendation: ${diagnostic.recommendation}`,
        context: {
          diagnostic,
          evidenceCount: diagnostic.evidence.length,
          failureType: diagnostic.failureType,
        },
      });

      const failResult: DeploymentResult = {
        deploymentId: instruction.deploymentId,
        success: false,
        workspacePath: execResult.workspacePath,
        artifacts: [],
        executionDurationMs: execResult.durationMs,
        totalDurationMs: Date.now() - totalStart,
        verificationPassed: false,
        verificationChecks: [],
        failureReason: execResult.error,
        diagnostic,
        debriefEntryIds,
        debriefEntries,
      };
      this.reportToServer(failResult);
      return failResult;
    }

    // --- Verify locally ------------------------------------------------

    const verification = this.verifyWorkspace(
      execResult.workspacePath,
      instruction.version,
      instruction.operationId,
    );

    recordEntry({
      partitionId: instruction.partitionId,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "deployment-verification",
      decision: verification.passed
        ? `Local verification passed — all ${verification.checks.length} checks succeeded`
        : `Local verification failed — ${verification.checks.filter((c) => !c.passed).length} of ${verification.checks.length} checks failed`,
      reasoning: verification.passed
        ? `Post-deployment verification confirms all expected artifacts are ` +
          `present and contain correct content: ${verification.checks.map((c) => c.detail).join(". ")}. ` +
          `The deployment of ${instruction.operationId} v${instruction.version} ` +
          `is confirmed on this machine.`
        : `Post-deployment verification found issues: ` +
          `${verification.checks.filter((c) => !c.passed).map((c) => c.detail).join(". ")}. ` +
          `The deployment artifacts are incomplete or incorrect. ` +
          `The environment may be in an inconsistent state.`,
      context: {
        step: "verify",
        passed: verification.passed,
        checks: verification.checks,
        workspacePath: execResult.workspacePath,
      },
    });

    if (!verification.passed) {
      this.state.completeDeployment(
        instruction.deploymentId,
        "failed",
        "Post-deployment verification failed",
      );

      const diagnostic = this.investigator.investigate(
        execResult.workspacePath,
        instruction,
        execResult,
      );

      recordEntry({
        partitionId: instruction.partitionId,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "diagnostic-investigation",
        decision: `Investigation: ${diagnostic.summary}`,
        reasoning:
          `Root cause: ${diagnostic.rootCause} ` +
          `Recommendation: ${diagnostic.recommendation}`,
        context: {
          diagnostic,
          evidenceCount: diagnostic.evidence.length,
          failureType: diagnostic.failureType,
        },
      });

      const failResult: DeploymentResult = {
        deploymentId: instruction.deploymentId,
        success: false,
        workspacePath: execResult.workspacePath,
        artifacts: execResult.artifacts,
        executionDurationMs: execResult.durationMs,
        totalDurationMs: Date.now() - totalStart,
        verificationPassed: false,
        verificationChecks: verification.checks,
        failureReason: "Post-deployment verification failed",
        diagnostic,
        debriefEntryIds,
        debriefEntries,
      };
      this.reportToServer(failResult);
      return failResult;
    }

    // --- Update local state --------------------------------------------

    this.state.completeDeployment(instruction.deploymentId, "succeeded");
    this.state.updateEnvironment(
      instruction.partitionId,
      instruction.environmentId,
      {
        currentVersion: instruction.version,
        currentDeploymentId: instruction.deploymentId,
        activeVariables: instruction.variables,
      },
    );

    // --- Record completion ---------------------------------------------

    const totalDurationMs = Date.now() - totalStart;

    recordEntry({
      partitionId: instruction.partitionId,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "deployment-completion",
      decision:
        `Deployment complete: ${instruction.operationId} ` +
        `v${instruction.version} is now live on "${instruction.environmentName}"`,
      reasoning:
        `Full local pipeline completed successfully: environment scan ` +
        `confirmed readiness, ${execResult.artifacts.length} artifacts ` +
        `written to workspace, all ${verification.checks.length} ` +
        `verification checks passed. Local state updated — ` +
        `"${instruction.environmentName}" now runs v${instruction.version} ` +
        `for partition "${instruction.partitionName}". ` +
        `Total execution time: ${totalDurationMs}ms.`,
      context: {
        step: "complete",
        artifacts: execResult.artifacts,
        executionDurationMs: execResult.durationMs,
        totalDurationMs,
        verificationChecks: verification.checks.length,
        workspacePath: execResult.workspacePath,
      },
    });

    const successResult: DeploymentResult = {
      deploymentId: instruction.deploymentId,
      success: true,
      workspacePath: execResult.workspacePath,
      artifacts: execResult.artifacts,
      executionDurationMs: execResult.durationMs,
      totalDurationMs,
      verificationPassed: true,
      verificationChecks: verification.checks,
      failureReason: null,
      diagnostic: null,
      debriefEntryIds,
      debriefEntries,
    };
    this.reportToServer(successResult);
    return successResult;
  }

  // -------------------------------------------------------------------------
  // Internal: workspace artifact writing (migrated from DeploymentExecutor)
  // -------------------------------------------------------------------------

  /**
   * Write workspace artifacts — the deployment metadata files that
   * represent a deployed state on this machine.
   */
  private writeWorkspaceArtifacts(
    instruction: DeploymentInstruction,
    localRecord: LocalDeploymentRecord,
  ): ExecutionResult {
    const start = Date.now();
    const workspacePath = localRecord.workspacePath;

    try {
      fs.mkdirSync(workspacePath, { recursive: true });
      const artifacts: string[] = [];

      // Write deployment manifest
      const manifestPath = path.join(workspacePath, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify({
        deploymentId: instruction.deploymentId,
        operationId: instruction.operationId,
        partitionId: instruction.partitionId,
        environmentId: instruction.environmentId,
        version: instruction.version,
        variables: instruction.variables,
        receivedAt: localRecord.receivedAt.toISOString(),
      }, null, 2));
      artifacts.push("manifest.json");

      // Write resolved variables
      const varsPath = path.join(workspacePath, "variables.env");
      const varsContent = Object.entries(instruction.variables)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      fs.writeFileSync(varsPath, varsContent);
      artifacts.push("variables.env");

      // Write version marker
      const versionPath = path.join(workspacePath, "VERSION");
      fs.writeFileSync(versionPath, `${instruction.operationId}@${instruction.version}`);
      artifacts.push("VERSION");

      // Write deployment status
      const statusPath = path.join(workspacePath, "STATUS");
      fs.writeFileSync(statusPath, "DEPLOYED");
      artifacts.push("STATUS");

      return {
        success: true,
        workspacePath,
        artifacts,
        durationMs: Date.now() - start,
        error: null,
      };
    } catch (err) {
      return {
        success: false,
        workspacePath,
        artifacts: [],
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internal: workspace verification (migrated from DeploymentExecutor)
  // -------------------------------------------------------------------------

  /**
   * Verify a deployment workspace: check that the expected artifacts exist
   * and contain the right content.
   */
  private verifyWorkspace(
    workspacePath: string,
    expectedVersion: string,
    expectedOperationId: string,
  ): VerificationResult {
    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

    const wsExists = fs.existsSync(workspacePath);
    checks.push({
      name: "workspace-exists",
      passed: wsExists,
      detail: wsExists
        ? `Workspace directory exists at ${workspacePath}`
        : `Workspace directory missing at ${workspacePath}`,
    });

    if (!wsExists) {
      return { passed: false, checks };
    }

    const manifestPath = path.join(workspacePath, "manifest.json");
    const manifestExists = fs.existsSync(manifestPath);
    checks.push({
      name: "manifest-present",
      passed: manifestExists,
      detail: manifestExists ? "Deployment manifest found" : "Deployment manifest missing",
    });

    const versionPath = path.join(workspacePath, "VERSION");
    const versionExists = fs.existsSync(versionPath);
    if (versionExists) {
      const versionContent = fs.readFileSync(versionPath, "utf-8").trim();
      const versionCorrect = versionContent === `${expectedOperationId}@${expectedVersion}`;
      checks.push({
        name: "version-correct",
        passed: versionCorrect,
        detail: versionCorrect
          ? `Version marker reads "${versionContent}" — matches expected`
          : `Version marker reads "${versionContent}" — expected "${expectedOperationId}@${expectedVersion}"`,
      });
    } else {
      checks.push({ name: "version-correct", passed: false, detail: "VERSION file missing" });
    }

    const statusPath = path.join(workspacePath, "STATUS");
    const statusExists = fs.existsSync(statusPath);
    if (statusExists) {
      const statusContent = fs.readFileSync(statusPath, "utf-8").trim();
      const statusCorrect = statusContent === "DEPLOYED";
      checks.push({
        name: "status-deployed",
        passed: statusCorrect,
        detail: statusCorrect
          ? "STATUS marker reads DEPLOYED"
          : `STATUS marker reads "${statusContent}" — expected "DEPLOYED"`,
      });
    } else {
      checks.push({ name: "status-deployed", passed: false, detail: "STATUS file missing" });
    }

    const varsPath = path.join(workspacePath, "variables.env");
    const varsExists = fs.existsSync(varsPath);
    checks.push({
      name: "variables-present",
      passed: varsExists,
      detail: varsExists ? "Variables file found" : "Variables file missing",
    });

    const passed = checks.every((c) => c.passed);
    return { passed, checks };
  }

  // -------------------------------------------------------------------------
  // Phase 1: Planning — read-only, zero side effects
  // -------------------------------------------------------------------------

  /**
   * Plan a deployment: reason about how to deploy an artifact to a target
   * environment. This phase is entirely read-only — nothing is touched on
   * the system. The returned plan must be approved by the user before
   * executeApprovedPlan() is called.
   *
   * 1. Load context from knowledge store (previous plans, system knowledge)
   * 2. Scan local system state (read-only)
   * 3. Reason with LLM to produce a concrete deployment plan
   * 4. Generate a rollback plan for each step
   * 5. Record the planning decision to the debrief
   */
  async planDeployment(instruction: PlanningInstruction): Promise<PlanningResult> {
    const debriefEntries: DebriefEntry[] = [];

    const recordEntry = (params: Parameters<DebriefWriter["record"]>[0]): DebriefEntry => {
      const entry = this.debrief.record(params);
      debriefEntries.push(entry);
      return entry;
    };

    // --- 1. Load context from knowledge store --------------------------------

    const successfulPlans = this.state.getSuccessfulPlans(
      instruction.artifact.type,
      instruction.environment.id,
    );
    const failedPlans = this.state.getFailedPlans(
      instruction.artifact.type,
      instruction.environment.id,
    );
    const systemKnowledge = this.state.getAllSystemKnowledge();
    const latestPlan = this.state.getLatestPlan(
      instruction.artifact.type,
      instruction.environment.id,
    );

    // --- 2. Scan local system (read-only) ------------------------------------

    const scanResult = this.scanner.scan();

    // --- 3. Reason with LLM --------------------------------------------------

    // If the Envoy has no API key configured but the Server forwarded one,
    // set it in process.env for this and future calls. The key is not persisted
    // to disk — it lives only in the process environment.
    if (instruction.llmApiKey && !this.llmClient?.isAvailable()) {
      process.env.SYNTH_LLM_API_KEY = instruction.llmApiKey;
    }

    if (this.llmClient && this.llmClient.isAvailable()) {
      return this.planWithLlm(
        instruction,
        scanResult,
        successfulPlans,
        failedPlans,
        systemKnowledge,
        latestPlan,
        recordEntry,
      );
    }

    // --- Fallback: basic plan without LLM ------------------------------------

    recordEntry({
      partitionId: instruction.partition?.id ?? null,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "plan-generation",
      decision:
        `Generated basic deployment plan for ${instruction.artifact.name} ` +
        `v${instruction.version} → "${instruction.environment.name}" (LLM unavailable)`,
      reasoning:
        `LLM connection is not available. Falling back to a basic plan based on ` +
        `artifact type "${instruction.artifact.type}": copy artifact to workspace, ` +
        `write configuration, restart service. This plan lacks intelligent reasoning ` +
        `about the target environment and previous deployment history. ` +
        `Configure an LLM provider in Settings for intelligent plan generation.`,
      context: {
        artifactType: instruction.artifact.type,
        environmentName: instruction.environment.name,
        llmAvailable: false,
        previousSuccessfulPlans: successfulPlans.length,
        previousFailedPlans: failedPlans.length,
      },
    });

    return this.buildFallbackPlan(instruction);
  }

  /**
   * Produce a deployment plan using LLM reasoning.
   */
  private async planWithLlm(
    instruction: PlanningInstruction,
    scanResult: ReturnType<EnvironmentScanner["scan"]>,
    successfulPlans: ReturnType<EnvoyKnowledgeStore["getSuccessfulPlans"]>,
    failedPlans: ReturnType<EnvoyKnowledgeStore["getFailedPlans"]>,
    systemKnowledge: ReturnType<EnvoyKnowledgeStore["getAllSystemKnowledge"]>,
    latestPlan: ReturnType<EnvoyKnowledgeStore["getLatestPlan"]>,
    recordEntry: (params: Parameters<DebriefWriter["record"]>[0]) => DebriefEntry,
  ): Promise<PlanningResult> {
    // Build prompt sections
    const sections: string[] = [];

    sections.push(`## Artifact
Name: ${instruction.artifact.name}
Type: ${instruction.artifact.type}
Version: ${instruction.version}
Analysis summary: ${instruction.artifact.analysis.summary}
Dependencies: ${instruction.artifact.analysis.dependencies.join(", ") || "none"}
Configuration expectations: ${JSON.stringify(instruction.artifact.analysis.configurationExpectations)}
Deployment intent: ${instruction.artifact.analysis.deploymentIntent ?? "not specified"}
Confidence: ${instruction.artifact.analysis.confidence}`);

    sections.push(`## Target Environment
Name: ${instruction.environment.name}
ID: ${instruction.environment.id}
Variables: ${Object.keys(instruction.environment.variables).length} defined`);

    if (instruction.partition) {
      sections.push(`## Partition
Name: ${instruction.partition.name}
ID: ${instruction.partition.id}
Variables: ${Object.keys(instruction.partition.variables).length} defined`);
    }

    sections.push(`## Resolved Variables
${Object.entries(instruction.resolvedVariables).map(([k, v]) => `${k}=${v}`).join("\n")}`);

    sections.push(`## Local System State
Hostname: ${scanResult.hostname}
Deployments directory: ${scanResult.deploymentsDir}
Writable: ${scanResult.deploymentsWritable}
Existing deployments on disk: ${scanResult.disk.deploymentCount}
Known deployments in state: ${scanResult.knownState.totalDeployments}
Active environments: ${scanResult.knownState.activeEnvironments}`);

    // Include capability surface so the LLM only produces executable plans
    const capabilities = this.getCapabilities();
    const availableTools = capabilities.installedTools
      .filter((t) => t.available)
      .map((t) => `${t.name} (${t.version ?? "version unknown"})`)
      .join(", ");
    const unavailableTools = capabilities.installedTools
      .filter((t) => !t.available)
      .map((t) => t.name)
      .join(", ");

    sections.push(`## Envoy Capabilities — ONLY use actions and tools listed here
Action keywords the executor recognizes: ${capabilities.allActionKeywords.join(", ")}
Handlers: ${capabilities.handlers.map((h) => `${h.name} [${h.actionKeywords.join(", ")}]`).join("; ")}
Installed tools: ${availableTools || "none"}
Unavailable tools: ${unavailableTools || "none"}
Unsatisfied handler dependencies: ${capabilities.unsatisfiedDependencies.join(", ") || "none"}

IMPORTANT: Every step's "action" field MUST contain at least one of the recognized action keywords above, or the executor will reject it. Do NOT use tools that are listed as unavailable.`);

    if (systemKnowledge.length > 0) {
      sections.push(`## System Knowledge
${systemKnowledge.map((k) => `[${k.category}] ${k.key}: ${JSON.stringify(k.value)}`).join("\n")}`);
    }

    if (successfulPlans.length > 0) {
      const recent = successfulPlans.slice(0, 3);
      sections.push(`## Previous Successful Plans (${successfulPlans.length} total, showing ${recent.length})
${recent.map((p) => `- ${p.artifactName} → ${p.environmentId}: ${p.plan.steps.length} steps, ${p.executionDurationMs}ms`).join("\n")}`);
    }

    if (failedPlans.length > 0) {
      const recent = failedPlans.slice(0, 3);
      sections.push(`## Previous Failed Plans (${failedPlans.length} total, showing ${recent.length}) — AVOID THESE PATTERNS
${recent.map((p) => `- ${p.artifactName} → ${p.environmentId}: ${p.failureAnalysis ?? "no analysis"}`).join("\n")}`);
    }

    const systemPrompt =
      `You are the Envoy planning engine for Synth. Your job is to produce ` +
      `a concrete deployment plan: what to do, in what order, where, and how. ` +
      `Each step must have a clear action, target, description, and whether it is ` +
      `reversible (with rollback action if so). For steps that execute a shell command, ` +
      `include the exact literal command string in execPreview — this is what the user ` +
      `will see to verify what deterministically runs.\n\n` +
      `IMPORTANT: You must respond with valid JSON only. No markdown, no commentary.\n\n` +
      `Response format:\n` +
      `{\n` +
      `  "reasoning": "Your reasoning about why this plan is appropriate",\n` +
      `  "steps": [\n` +
      `    {\n` +
      `      "description": "Human-readable description of the step",\n` +
      `      "action": "The action type (e.g. copy-artifact, write-config, restart-service, verify-health)",\n` +
      `      "target": "What the action operates on (source path, service name, URL, or command binary)",\n` +
      `      "params": {\n` +
      `        "destination": "Required for copy/move: the destination path",\n` +
      `        "args": ["array", "of", "arguments for command/script actions"],\n` +
      `        "cwd": "Working directory for command/script actions (if not current dir)",\n` +
      `        "templatePath": "For config actions: path to the template file (if different from target)",\n` +
      `        "outputPath": "For config actions: output path (if different from target)",\n` +
      `        "variables": {"VAR": "value"},\n` +
      `        "composeFile": "For compose actions: path to docker-compose file",\n` +
      `        "linkTarget": "For symlink actions: the target the symlink should point to"\n` +
      `      },\n` +
      `      "reversible": true,\n` +
      `      "rollbackAction": "How to undo this step",\n` +
      `      "execPreview": "The exact literal command string that will execute, e.g. 'docker pull myapp:1.2.3', 'systemctl restart nginx', 'npm install --production'. Omit if this step doesn't invoke a shell command."\n` +
      `    }\n` +
      `  ],\n` +
      `  "delta": "If a previous successful plan exists, describe what changed and why. Omit if no previous plan."\n` +
      `}`;

    const prompt = sections.join("\n\n");

    const llmResult = await this.llmClient!.reason({
      prompt,
      systemPrompt,
      promptSummary:
        `Plan deployment of ${instruction.artifact.name} v${instruction.version} ` +
        `to "${instruction.environment.name}"`,
      partitionId: instruction.partition?.id ?? null,
      deploymentId: instruction.deploymentId,
      maxTokens: 4096,
    });

    if (!llmResult.ok) {
      // LLM call failed — fall back to basic plan
      recordEntry({
        partitionId: instruction.partition?.id ?? null,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "plan-generation",
        decision:
          `LLM reasoning failed — falling back to basic plan for ` +
          `${instruction.artifact.name} v${instruction.version}`,
        reasoning:
          `LLM call failed: ${llmResult.reason}. Producing a basic deployment plan ` +
          `based on artifact type "${instruction.artifact.type}" without intelligent ` +
          `reasoning. The plan will use a simple copy + configure + restart pattern.`,
        context: {
          artifactType: instruction.artifact.type,
          llmFailed: true,
          llmReason: llmResult.reason,
        },
      });

      return this.buildFallbackPlan(instruction);
    }

    // Parse LLM response
    let parsed: {
      reasoning: string;
      steps: Array<{
        description: string;
        action: string;
        target: string;
        params?: Record<string, unknown>;
        reversible: boolean;
        rollbackAction?: string;
        execPreview?: string;
      }>;
      delta?: string;
    };

    try {
      let text = llmResult.text.trim();
      if (text.startsWith("```")) {
        text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      const raw = JSON.parse(text);
      // Validate required step fields — LLM may omit action/target
      if (!Array.isArray(raw?.steps)) throw new Error("Plan missing steps array");
      for (const s of raw.steps) {
        if (typeof s.action !== "string" || !s.action) throw new Error(`Step "${s.description ?? "?"}" missing action`);
        if (typeof s.target !== "string") throw new Error(`Step "${s.description ?? "?"}" missing target`);
        if (typeof s.description !== "string") s.description = s.action;
      }
      parsed = raw;
    } catch {
      recordEntry({
        partitionId: instruction.partition?.id ?? null,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "plan-generation",
        decision:
          `LLM response could not be parsed — falling back to basic plan`,
        reasoning:
          `The LLM returned a response that could not be parsed as JSON. ` +
          `Falling back to a basic deployment plan. Raw response length: ${llmResult.text.length} chars.`,
        context: { parseError: true },
      });

      return this.buildFallbackPlan(instruction);
    }

    // Build plan and run dry-run validation loop (max 3 attempts)
    const MAX_DRY_RUN_ATTEMPTS = 3;
    let currentParsed = parsed;
    let lastDryRunResult: DryRunPlanResult | null = null;
    let previousFailures: Array<{ stepDescription: string; failures: string[] }> = [];

    for (let attempt = 1; attempt <= MAX_DRY_RUN_ATTEMPTS; attempt++) {
      const plan: DeploymentPlan = {
        steps: currentParsed.steps.map((s) => ({
          description: s.description,
          action: s.action,
          target: s.target,
          params: s.params,
          reversible: s.reversible ?? false,
          rollbackAction: s.rollbackAction,
          execPreview: s.execPreview,
        })),
        reasoning: currentParsed.reasoning,
        diffFromPreviousPlan: latestPlan
          ? currentParsed.delta
          : undefined,
      };

      // --- Dry-run precondition checks against real system state ---
      await this.executorReady;

      if (!this.operationExecutor) {
        // Executor not available — skip dry-run, return plan as-is
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          deploymentId: instruction.deploymentId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision:
            `Generated deployment plan (dry-run skipped — executor not initialized): ` +
            `${plan.steps.length} step(s) for ${instruction.artifact.name} v${instruction.version}`,
          reasoning: currentParsed.reasoning,
          context: { dryRunSkipped: true },
        });

        return {
          plan,
          rollbackPlan: this.buildRollbackPlan(plan, instruction),
          delta: currentParsed.delta,
        };
      }

      lastDryRunResult = await this.operationExecutor.executeDryRun(plan.steps);

      // --- All preconditions pass: return grounded plan ---
      if (lastDryRunResult.allPassed) {
        const rollbackPlan = this.buildRollbackPlan(plan, instruction);

        // Augment reasoning with dry-run confidence
        plan.reasoning =
          currentParsed.reasoning +
          ` [Dry-run validated: all ${lastDryRunResult.stepResults.length} step(s) passed ` +
          `precondition checks. Confidence: ${lastDryRunResult.overallFidelity}.` +
          `${lastDryRunResult.allUnknowns.length > 0 ? ` Unknowns: ${lastDryRunResult.allUnknowns.join("; ")}.` : ""}]`;

        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          deploymentId: instruction.deploymentId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision:
            `Generated and validated deployment plan: ${plan.steps.length} step(s) for ` +
            `${instruction.artifact.name} v${instruction.version} → "${instruction.environment.name}" ` +
            `(dry-run passed on attempt ${attempt})`,
          reasoning: currentParsed.reasoning,
          context: {
            artifactType: instruction.artifact.type,
            environmentName: instruction.environment.name,
            llmAvailable: true,
            stepCount: plan.steps.length,
            rollbackStepCount: rollbackPlan.steps.length,
            previousSuccessfulPlans: successfulPlans.length,
            previousFailedPlans: failedPlans.length,
            hasDelta: !!currentParsed.delta,
            dryRunAttempt: attempt,
            dryRunFidelity: lastDryRunResult.overallFidelity,
            dryRunUnknowns: lastDryRunResult.allUnknowns,
          },
        });

        return {
          plan,
          rollbackPlan,
          delta: currentParsed.delta,
        };
      }

      // --- Unrecoverable failure: exit immediately ---
      if (!lastDryRunResult.allRecoverable) {
        const unrecoverableFailures = lastDryRunResult.failures
          .filter((f) => !f.result.recoverable)
          .map((f) => {
            const failedChecks = f.result.preconditions
              .filter((p) => !p.passed)
              .map((p) => p.detail);
            return `Step ${f.stepIndex + 1} "${f.step.description}": ${failedChecks.join("; ")}`;
          });

        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          deploymentId: instruction.deploymentId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision:
            `Plan rejected — unrecoverable precondition failure(s) found during dry-run`,
          reasoning:
            `Dry-run found ${unrecoverableFailures.length} unrecoverable failure(s) that ` +
            `the planner cannot work around. Failures: ${unrecoverableFailures.join(". ")}. ` +
            `These require manual intervention or infrastructure changes before deployment ` +
            `can proceed.`,
          context: {
            dryRunAttempt: attempt,
            unrecoverableFailures,
            allFailures: lastDryRunResult.failures.length,
          },
        });

        const blockReason =
          `Unrecoverable precondition failures: ${unrecoverableFailures.join(". ")}. ` +
          `These require manual intervention or infrastructure changes before deployment can proceed.`;

        plan.reasoning = `PLAN BLOCKED — ${blockReason}`;

        return {
          plan,
          rollbackPlan: this.buildRollbackPlan(plan, instruction),
          delta: currentParsed.delta,
          blocked: true,
          blockReason,
        };
      }

      // --- Recoverable failure: check for stuck loop ---
      const currentFailureSummary = lastDryRunResult.failures.map((f) => ({
        stepDescription: f.step.description,
        failures: f.result.preconditions
          .filter((p) => !p.passed)
          .map((p) => p.detail),
      }));

      // Detect stuck: same failures repeating across iterations
      const isStuck =
        previousFailures.length > 0 &&
        JSON.stringify(currentFailureSummary) === JSON.stringify(previousFailures);

      if (isStuck) {
        const stuckDetails = currentFailureSummary
          .map((f) => `"${f.stepDescription}": ${f.failures.join("; ")}`)
          .join(". ");

        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          deploymentId: instruction.deploymentId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision:
            `Plan generation stuck — same precondition failures after ${attempt} attempts`,
          reasoning:
            `Re-planning produced the same failures as the previous attempt, indicating ` +
            `the LLM cannot resolve these issues. Stuck on: ${stuckDetails}. ` +
            `Returning the best available plan with failure annotations.`,
          context: { dryRunAttempt: attempt, stuckOn: currentFailureSummary },
        });

        plan.reasoning =
          `Plan has unresolved precondition issues (stuck after ${attempt} re-planning attempts): ` +
          `${stuckDetails}. Review these issues before approving.`;

        return {
          plan,
          rollbackPlan: this.buildRollbackPlan(plan, instruction),
          delta: currentParsed.delta,
        };
      }

      previousFailures = currentFailureSummary;

      // --- Last attempt: return with unresolved failures listed ---
      if (attempt === MAX_DRY_RUN_ATTEMPTS) {
        const failureDetails = currentFailureSummary
          .map((f) => `"${f.stepDescription}": ${f.failures.join("; ")}`)
          .join(". ");

        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          deploymentId: instruction.deploymentId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision:
            `Plan generated with unresolved precondition issues after ${MAX_DRY_RUN_ATTEMPTS} attempts`,
          reasoning:
            `Dry-run validation failed on all ${MAX_DRY_RUN_ATTEMPTS} attempts. ` +
            `Unresolved: ${failureDetails}. Returning the last plan with annotations.`,
          context: {
            dryRunAttempt: attempt,
            maxAttempts: MAX_DRY_RUN_ATTEMPTS,
            unresolvedFailures: currentFailureSummary,
          },
        });

        const blockReason =
          `Plan has unresolved precondition issues (stuck after ${MAX_DRY_RUN_ATTEMPTS - 1} re-planning attempts): ` +
          `${failureDetails}. Review these issues before approving.`;

        plan.reasoning = blockReason;

        return {
          plan,
          rollbackPlan: this.buildRollbackPlan(plan, instruction),
          delta: currentParsed.delta,
          blocked: true,
          blockReason,
        };
      }

      // --- Recoverable failure, not stuck, not last attempt: re-invoke LLM ---
      const failureFeedback = lastDryRunResult.failures.map((f) => {
        const failedChecks = f.result.preconditions
          .filter((p) => !p.passed)
          .map((p) => `[${p.check}] ${p.detail}`);
        return `Step ${f.stepIndex + 1} "${f.step.description}" (action: "${f.step.action}", target: "${f.step.target}"): FAILED — ${failedChecks.join("; ")}`;
      });

      recordEntry({
        partitionId: instruction.partition?.id ?? null,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "plan-generation",
        decision:
          `Dry-run found ${lastDryRunResult.failures.length} recoverable issue(s) — re-invoking LLM (attempt ${attempt + 1}/${MAX_DRY_RUN_ATTEMPTS})`,
        reasoning:
          `Precondition failures: ${failureFeedback.join(". ")}. ` +
          `All failures are recoverable. Re-invoking LLM with failure context to generate a corrected plan.`,
        context: { dryRunAttempt: attempt, failures: failureFeedback },
      });

      // Build re-planning prompt with failure context
      const replanPrompt =
        `Your previous deployment plan failed dry-run precondition checks against the real system state.\n\n` +
        `## Original Plan\n` +
        `${currentParsed.steps.map((s, i) => `${i + 1}. [${s.action}] ${s.description} → ${s.target}`).join("\n")}\n\n` +
        `## Precondition Failures\n` +
        `${failureFeedback.join("\n")}\n\n` +
        `## System State Evidence\n` +
        `${lastDryRunResult.failures.flatMap((f) => f.result.preconditions.map((p) => `- ${p.detail}`)).join("\n")}\n\n` +
        `Generate a corrected plan that avoids these failures. All other constraints from the original prompt still apply.\n\n` +
        `IMPORTANT: Respond with valid JSON only, same format as before.`;

      const replanResult = await this.llmClient!.reason({
        prompt: replanPrompt,
        systemPrompt:
          `You are the Envoy planning engine for Synth. A previous plan failed dry-run ` +
          `validation. Generate a corrected plan that addresses the precondition failures. ` +
          `Respond with valid JSON only, same format as before: ` +
          `{ "reasoning": "...", "steps": [...], "delta": "..." }`,
        promptSummary:
          `Re-plan deployment of ${instruction.artifact.name} v${instruction.version} ` +
          `(attempt ${attempt + 1} — addressing dry-run failures)`,
        partitionId: instruction.partition?.id ?? null,
        deploymentId: instruction.deploymentId,
        maxTokens: 4096,
      });

      if (!replanResult.ok) {
        // LLM re-planning failed — return current plan with annotations
        plan.reasoning =
          `Dry-run found issues but LLM re-planning failed (${replanResult.reason}). ` +
          `Original plan returned with known issues: ` +
          `${failureFeedback.join(". ")}`;

        return {
          plan,
          rollbackPlan: this.buildRollbackPlan(plan, instruction),
          delta: currentParsed.delta,
        };
      }

      // Parse re-planning response
      try {
        let text = replanResult.text.trim();
        if (text.startsWith("```")) {
          text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        }
        currentParsed = JSON.parse(text);
      } catch {
        // Parse failed — return current plan with annotations
        plan.reasoning =
          `Dry-run found issues but LLM re-planning response could not be parsed. ` +
          `Original plan returned with known issues: ` +
          `${failureFeedback.join(". ")}`;

        return {
          plan,
          rollbackPlan: this.buildRollbackPlan(plan, instruction),
          delta: currentParsed.delta,
        };
      }
    }

    // Should not reach here, but TypeScript needs it
    throw new Error("Unreachable: dry-run loop exited without returning");
  }

  /**
   * Build a rollback plan from a deployment plan — reverse order of
   * reversible steps.
   */
  private buildRollbackPlan(
    plan: DeploymentPlan,
    instruction: PlanningInstruction,
  ): DeploymentPlan {
    return {
      steps: plan.steps
        .filter((s) => s.reversible && s.rollbackAction)
        .reverse()
        .map((s) => ({
          description: `Rollback: ${s.description}`,
          action: s.rollbackAction!,
          target: s.target,
          reversible: false,
        })),
      reasoning:
        `Rollback plan for ${instruction.artifact.name} v${instruction.version}: ` +
        `undo ${plan.steps.filter((s) => s.reversible).length} reversible step(s) ` +
        `in reverse order.`,
    };
  }

  /**
   * Build a basic fallback plan when LLM is unavailable — simple copy +
   * configure + restart pattern based on artifact type.
   */
  private buildFallbackPlan(instruction: PlanningInstruction): PlanningResult {
    const workspacePath = `${this.baseDir}/deployments/${instruction.deploymentId}`;

    const plan: DeploymentPlan = {
      steps: [
        {
          description: `Create workspace directory for ${instruction.artifact.name} v${instruction.version}`,
          action: "mkdir",
          target: workspacePath,
          reversible: true,
          rollbackAction: "delete",
        },
        {
          description: `Write artifact metadata to workspace`,
          action: "write-config",
          target: `${workspacePath}/artifact.json`,
          params: {
            content: JSON.stringify({
              id: instruction.artifact.id,
              name: instruction.artifact.name,
              type: instruction.artifact.type,
              version: instruction.version,
              deploymentId: instruction.deploymentId,
            }, null, 2),
          },
          reversible: true,
          rollbackAction: "delete",
        },
        {
          description: `Write deployment configuration with ${Object.keys(instruction.resolvedVariables).length} resolved variable(s)`,
          action: "write-config",
          target: `${workspacePath}/variables.env`,
          params: {
            content: Object.entries(instruction.resolvedVariables)
              .map(([k, v]) => `${k}=${v}`)
              .join("\n"),
          },
          reversible: true,
          rollbackAction: "delete",
        },
        {
          description: `Write deployment manifest`,
          action: "write-config",
          target: `${workspacePath}/manifest.json`,
          params: {
            content: JSON.stringify({
              deploymentId: instruction.deploymentId,
              artifact: instruction.artifact.name,
              version: instruction.version,
              environment: instruction.environment.name,
              deployedAt: new Date().toISOString(),
            }, null, 2),
          },
          reversible: true,
          rollbackAction: "delete",
        },
        {
          description: `Mark deployment as active`,
          action: "write-config",
          target: `${workspacePath}/STATUS`,
          params: {
            content: "active",
          },
          reversible: true,
          rollbackAction: "delete",
        },
      ],
      reasoning:
        `Basic deployment plan for artifact type "${instruction.artifact.type}". ` +
        `LLM was unavailable so this plan uses a standard copy + configure pattern ` +
        `without intelligent reasoning about the target environment or previous history.`,
    };

    const rollbackPlan: DeploymentPlan = {
      steps: [...plan.steps].reverse().map((s) => ({
        description: `Rollback: ${s.description}`,
        action: s.rollbackAction ?? "noop",
        target: s.target,
        reversible: false,
      })),
      reasoning:
        `Rollback plan: remove all artifacts written during deployment in reverse order.`,
    };

    return { plan, rollbackPlan };
  }

  // -------------------------------------------------------------------------
  // Post-hoc rollback planning — generate a rollback plan after execution
  // -------------------------------------------------------------------------

  /**
   * Generate a rollback plan based on what actually ran during a deployment.
   *
   * Unlike buildRollbackPlan (which mechanically reverses forward plan steps
   * before execution), this method reasons about what was actually executed
   * and produces a targeted plan to undo it. Called when the user requests
   * a rollback from the Debrief panel after a deployment has completed.
   */
  async planRollback(instruction: RollbackPlanningInstruction): Promise<DeploymentPlan> {
    // Only consider steps that completed successfully — failed/rolled-back steps
    // didn't fully execute, so they may not need undoing.
    const executedSteps = instruction.completedSteps.filter((s) => s.status === "completed");

    if (instruction.llmApiKey && !this.llmClient?.isAvailable()) {
      process.env.SYNTH_LLM_API_KEY = instruction.llmApiKey;
    }

    if (this.llmClient && this.llmClient.isAvailable()) {
      return this.planRollbackWithLlm(instruction, executedSteps);
    }

    // Fallback: mechanically reverse the completed steps
    return this.buildMechanicalRollbackPlan(instruction, executedSteps);
  }

  private async planRollbackWithLlm(
    instruction: RollbackPlanningInstruction,
    executedSteps: RollbackPlanningInstruction["completedSteps"],
  ): Promise<DeploymentPlan> {
    const scanResult = this.scanner.scan();
    const capabilities = this.getCapabilities();
    const availableTools = capabilities.installedTools
      .filter((t) => t.available)
      .map((t) => `${t.name} (${t.version ?? "version unknown"})`)
      .join(", ");

    const sections: string[] = [];

    sections.push(`## Deployment Being Rolled Back
Artifact: ${instruction.artifact.name}
Type: ${instruction.artifact.type}
Version: ${instruction.version}
Environment: ${instruction.environment.name} (${instruction.environment.id})
Analysis: ${instruction.artifact.analysis.summary}
${instruction.failureReason ? `Failure reason: ${instruction.failureReason}` : "Deployment succeeded — manual rollback requested."}`);

    sections.push(`## Steps That Actually Executed (${executedSteps.length} completed)
${executedSteps.map((s, i) => `${i + 1}. [${s.status}] ${s.action} → ${s.target}: ${s.description}${s.output ? `\n   Output: ${s.output.slice(0, 200)}` : ""}`).join("\n")}`);

    const skippedSteps = instruction.completedSteps.filter((s) => s.status !== "completed");
    if (skippedSteps.length > 0) {
      sections.push(`## Steps That Did NOT Complete (do not undo these)
${skippedSteps.map((s, i) => `${i + 1}. [${s.status}] ${s.action} → ${s.target}: ${s.description}`).join("\n")}`);
    }

    sections.push(`## Active Variables at Deploy Time
${Object.entries(instruction.deployedVariables).map(([k, v]) => `${k}=${v}`).join("\n") || "(none)"}`);

    sections.push(`## Local System State
Hostname: ${scanResult.hostname}
Deployments directory: ${scanResult.deploymentsDir}
Writable: ${scanResult.deploymentsWritable}`);

    sections.push(`## Envoy Capabilities — ONLY use actions and tools listed here
Action keywords the executor recognizes: ${capabilities.allActionKeywords.join(", ")}
Handlers: ${capabilities.handlers.map((h) => `${h.name} [${h.actionKeywords.join(", ")}]`).join("; ")}
Installed tools: ${availableTools || "none"}
IMPORTANT: Every step's "action" field MUST contain at least one of the recognized action keywords above.`);

    const systemPrompt =
      `You are the Envoy rollback planning engine for Synth. Your job is to produce ` +
      `a concrete rollback plan: the minimal set of steps to safely undo a deployment ` +
      `and return the environment to its previous state.\n\n` +
      `Only undo steps that actually completed. Work in reverse order. ` +
      `Be specific about targets (paths, service names). ` +
      `Do not include steps for operations that did not execute.\n\n` +
      `IMPORTANT: You must respond with valid JSON only. No markdown, no commentary.\n\n` +
      `Response format:\n` +
      `{\n` +
      `  "reasoning": "Why these rollback steps are needed and what state they restore",\n` +
      `  "steps": [\n` +
      `    {\n` +
      `      "description": "Human-readable description of the rollback step",\n` +
      `      "action": "The action type (must use a recognized action keyword)",\n` +
      `      "target": "What the action operates on (source path, service name, command binary)",\n` +
      `      "params": {"destination": "required for copy/move", "args": [], "cwd": "optional"},\n` +
      `      "reversible": false,\n` +
      `      "execPreview": "The exact literal command string, if applicable"\n` +
      `    }\n` +
      `  ]\n` +
      `}`;

    const prompt = sections.join("\n\n");

    const llmResult = await this.llmClient!.reason({
      prompt,
      systemPrompt,
      promptSummary:
        `Generate rollback plan for ${instruction.artifact.name} v${instruction.version} ` +
        `in "${instruction.environment.name}"`,
      partitionId: null,
      deploymentId: instruction.deploymentId,
      maxTokens: 2048,
    });

    if (!llmResult.ok) {
      return this.buildMechanicalRollbackPlan(instruction, executedSteps);
    }

    try {
      let text = llmResult.text.trim();
      if (text.startsWith("```")) {
        text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      const parsed = JSON.parse(text) as {
        reasoning: string;
        steps: Array<{
          description: string;
          action: string;
          target: string;
          params?: Record<string, unknown>;
          reversible?: boolean;
          execPreview?: string;
        }>;
      };

      this.debrief.record({
        partitionId: null,
        deploymentId: instruction.deploymentId,
        agent: "envoy",
        decisionType: "plan-generation",
        decision: `Generated rollback plan for ${instruction.artifact.name} v${instruction.version}: ${parsed.steps.length} step(s)`,
        reasoning: parsed.reasoning,
        context: {
          stepCount: parsed.steps.length,
          executedStepsConsidered: executedSteps.length,
          llmGenerated: true,
        },
      });

      return {
        steps: parsed.steps.map((s) => ({
          description: s.description,
          action: s.action,
          target: s.target,
          params: s.params,
          reversible: false,
          execPreview: s.execPreview,
        })),
        reasoning: parsed.reasoning,
      };
    } catch {
      return this.buildMechanicalRollbackPlan(instruction, executedSteps);
    }
  }

  private buildMechanicalRollbackPlan(
    instruction: RollbackPlanningInstruction,
    executedSteps: RollbackPlanningInstruction["completedSteps"],
  ): DeploymentPlan {
    const steps = [...executedSteps].reverse().map((s) => ({
      description: `Undo: ${s.description}`,
      action: `undo-${s.action}`,
      target: s.target,
      reversible: false as const,
    }));

    return {
      steps,
      reasoning:
        `Mechanical rollback for ${instruction.artifact.name} v${instruction.version}: ` +
        `reverses ${executedSteps.length} completed step(s) in reverse order. ` +
        `LLM was unavailable — review steps carefully before executing.`,
    };
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute approved plan — deterministic, no reasoning
  // -------------------------------------------------------------------------

  /**
   * Execute a plan that was previously approved by the user.
   *
   * This method is entirely deterministic: it runs the approved steps in
   * order, exactly as specified. No re-reasoning, no improvisation. If a
   * step fails, the rollback plan is executed for completed steps.
   *
   * After execution, the plan is stored in the knowledge store for future
   * planning context.
   */
  async executeApprovedPlan(
    deploymentId: string,
    plan: DeploymentPlan,
    rollbackPlan: DeploymentPlan,
    artifactContext?: { artifactType: string; artifactName: string; environmentId: string },
    progressCallbackUrl?: string,
    callbackToken?: string,
  ): Promise<DeploymentResult> {
    await this.executorReady;

    // --- Lifecycle guard ---
    if (this._lifecycleState !== "active") {
      const reason =
        this._lifecycleState === "draining"
          ? "Envoy is draining — finishing in-flight deployments but rejecting new ones"
          : "Envoy is paused — not accepting deployments";

      return {
        deploymentId,
        success: false,
        workspacePath: "",
        artifacts: [],
        executionDurationMs: 0,
        totalDurationMs: 0,
        verificationPassed: false,
        verificationChecks: [],
        failureReason: reason,
        diagnostic: null,
        debriefEntryIds: [],
        debriefEntries: [],
      };
    }

    const totalStart = Date.now();
    const debriefEntryIds: string[] = [];
    const debriefEntries: DebriefEntry[] = [];

    const recordEntry = (params: Parameters<DebriefWriter["record"]>[0]): DebriefEntry => {
      const entry = this.debrief.record(params);
      debriefEntryIds.push(entry.id);
      debriefEntries.push(entry);
      return entry;
    };

    recordEntry({
      partitionId: null,
      deploymentId,
      agent: "envoy",
      decisionType: "deployment-execution",
      decision:
        `Executing approved plan: ${plan.steps.length} step(s) for deployment ${deploymentId}`,
      reasoning:
        `User approved the deployment plan. Executing ${plan.steps.length} step(s) ` +
        `deterministically — no re-reasoning. Rollback plan has ` +
        `${rollbackPlan.steps.length} step(s) ready if any step fails.`,
      context: {
        stepCount: plan.steps.length,
        rollbackStepCount: rollbackPlan.steps.length,
        steps: plan.steps.map((s) => ({ action: s.action, target: s.target })),
      },
    });

    const execStart = Date.now();
    const completedSteps: PlannedStep[] = [];
    let failedStepIndex: number | null = null;
    let failureError: string | null = null;

    // Execute each step through the OperationExecutor if available
    if (this.operationExecutor && plan.steps.length > 0) {
      // Set up progress callback to stream events to Command if URL provided
      const progressCallback = progressCallbackUrl
        ? createCallbackReporter(progressCallbackUrl, callbackToken)
        : undefined;

      const planResult = await this.operationExecutor.executePlan(
        plan.steps,
        [],
        progressCallback,
        deploymentId,
      );

      if (!planResult.success) {
        failedStepIndex = planResult.failedStepIndex ?? 0;
        const failedResult = planResult.results.find((r) => r.status === "failed");
        failureError = failedResult?.error ?? "Unknown execution error";

        // Collect completed steps for debrief context
        planResult.results
          .filter((r) => r.status === "completed")
          .forEach((r) => completedSteps.push(r.step));
      } else {
        planResult.results.forEach((r) => completedSteps.push(r.step));
      }
    }

    const execDurationMs = Date.now() - execStart;

    if (failureError !== null) {
      // --- Failure path: execute rollback for completed steps ---

      recordEntry({
        partitionId: null,
        deploymentId,
        agent: "envoy",
        decisionType: "deployment-failure",
        decision:
          `Plan execution failed at step ${(failedStepIndex ?? 0) + 1}/${plan.steps.length}: ${failureError}`,
        reasoning:
          `Step "${plan.steps[failedStepIndex ?? 0]?.description ?? "unknown"}" failed. ` +
          `Error: ${failureError}. ${completedSteps.length} step(s) completed before failure. ` +
          `Executing rollback plan to restore previous state.`,
        context: {
          failedStepIndex,
          error: failureError,
          completedSteps: completedSteps.length,
          durationMs: execDurationMs,
        },
      });

      // Execute rollback
      if (this.operationExecutor && rollbackPlan.steps.length > 0) {
        await this.operationExecutor.executePlan(
          rollbackPlan.steps,
          [],
          undefined,
          deploymentId,
        );

        recordEntry({
          partitionId: null,
          deploymentId,
          agent: "envoy",
          decisionType: "rollback-execution",
          decision:
            `Rollback executed: ${rollbackPlan.steps.length} step(s) to restore previous state`,
          reasoning:
            `Executed rollback plan with ${rollbackPlan.steps.length} step(s) ` +
            `to undo the ${completedSteps.length} completed step(s). ` +
            `The environment should be in its previous state.`,
          context: {
            rollbackSteps: rollbackPlan.steps.length,
            completedStepsRolledBack: completedSteps.length,
          },
        });
      }

      const failResult: DeploymentResult = {
        deploymentId,
        success: false,
        workspacePath: "",
        artifacts: [],
        executionDurationMs: execDurationMs,
        totalDurationMs: Date.now() - totalStart,
        verificationPassed: false,
        verificationChecks: [],
        failureReason: failureError,
        diagnostic: null,
        debriefEntryIds,
        debriefEntries,
      };
      this.reportToServer(failResult, callbackToken);

      // Store the failed plan in knowledge store for future planning context
      this.storePlanOutcome(deploymentId, plan, rollbackPlan, false, failureError, execDurationMs, artifactContext);

      return failResult;
    }

    // --- Success path ---

    const totalDurationMs = Date.now() - totalStart;
    const artifacts = completedSteps.map((s) => s.description);

    recordEntry({
      partitionId: null,
      deploymentId,
      agent: "envoy",
      decisionType: "deployment-completion",
      decision:
        `Approved plan executed: all ${plan.steps.length} step(s) completed for deployment ${deploymentId}`,
      reasoning:
        `All ${plan.steps.length} planned steps executed deterministically in ${execDurationMs}ms. ` +
        `No re-reasoning was performed — the plan was executed exactly as approved. ` +
        `Total pipeline time: ${totalDurationMs}ms.`,
      context: {
        stepCount: plan.steps.length,
        executionDurationMs: execDurationMs,
        totalDurationMs,
        artifacts,
      },
    });

    const successResult: DeploymentResult = {
      deploymentId,
      success: true,
      workspacePath: "",
      artifacts,
      executionDurationMs: execDurationMs,
      totalDurationMs,
      verificationPassed: true,
      verificationChecks: plan.steps.map((s) => ({
        name: s.action,
        passed: true,
        detail: s.description,
      })),
      failureReason: null,
      diagnostic: null,
      debriefEntryIds,
      debriefEntries,
    };
    this.reportToServer(successResult, callbackToken);

    // Store the successful plan in knowledge store for future planning context
    this.storePlanOutcome(deploymentId, plan, rollbackPlan, true, undefined, execDurationMs, artifactContext);

    return successResult;
  }

  /**
   * Store a plan outcome (success or failure) in the knowledge store
   * for future planning context.
   */
  private storePlanOutcome(
    deploymentId: string,
    plan: DeploymentPlan,
    rollbackPlan: DeploymentPlan,
    success: boolean,
    failureReason?: string,
    executionDurationMs?: number,
    artifactContext?: { artifactType: string; artifactName: string; environmentId: string },
  ): void {
    try {
      this.state.storePlan({
        id: crypto.randomUUID(),
        deploymentId,
        artifactType: artifactContext?.artifactType ?? "unknown",
        artifactName: artifactContext?.artifactName ?? "unknown",
        environmentId: artifactContext?.environmentId ?? "unknown",
        plan,
        rollbackPlan,
        outcome: success ? "succeeded" : "failed",
        failureAnalysis: success ? undefined : failureReason,
        executedAt: new Date(),
        executionDurationMs: executionDurationMs ?? 0,
      });
    } catch {
      // Non-critical — don't fail the deployment over a storage issue
    }
  }

  /**
   * Remove old deployment workspaces beyond retention limits.
   * Keeps the most recent `maxCount` workspaces and removes any older than `maxAgeMs`.
   * Returns the number of workspaces removed.
   */
  cleanupOldWorkspaces(maxAgeMs: number, maxCount: number): number {
    const deploymentsDir = path.join(this.baseDir, "deployments");
    if (!fs.existsSync(deploymentsDir)) return 0;

    let entries: { name: string; mtimeMs: number }[];
    try {
      entries = fs.readdirSync(deploymentsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const stat = fs.statSync(path.join(deploymentsDir, d.name));
          return { name: d.name, mtimeMs: stat.mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    } catch {
      return 0;
    }

    const now = Date.now();
    let removed = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const tooOld = now - entry.mtimeMs > maxAgeMs;
      const beyondMax = i >= maxCount;

      if (tooOld || beyondMax) {
        try {
          fs.rmSync(path.join(deploymentsDir, entry.name), { recursive: true, force: true });
          removed++;
        } catch {
          // Workspace may be in use — skip
        }
      }
    }

    return removed;
  }

  /**
   * Push deployment result to the Server via the reporter.
   * Fire-and-forget — the Envoy doesn't block on the Server receiving this.
   * The result was already returned to the caller; this is the proactive push.
   */
  private reportToServer(result: DeploymentResult, tokenOverride?: string): void {
    if (!this.reporter) return;
    this.reporter.reportDeploymentResult(result, tokenOverride).catch((err) => {
      // Log but don't fail — the synchronous response already went back.
      // Command can also pull this data via GET /deployments/:id.
      console.error(
        `[Envoy] Failed to report deployment ${result.deploymentId} to Command:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  /**
   * Get the current state of this Envoy — for health check responses.
   */
  getStatus(): {
    healthy: boolean;
    hostname: string;
    os: string;
    summary: ReturnType<EnvoyKnowledgeStore["getSummary"]>;
    readiness: { ready: boolean; reason: string };
    lifecycle: LifecycleState;
  } {
    const scan = this.scanner.scan();
    const readiness = this.scanner.checkReadiness();
    const summary = this.state.getSummary();

    return {
      healthy: readiness.ready && summary.executing === 0,
      hostname: scan.hostname,
      os: scan.os,
      summary,
      readiness,
      lifecycle: this._lifecycleState,
    };
  }

  /**
   * Return the Envoy's capability surface: what action keywords it
   * recognizes, which handlers are registered, what tools are installed,
   * and which tool dependencies are satisfied.
   *
   * This is surfaced to the server so the LLM planner can produce plans
   * that the Envoy can actually execute.
   */
  getCapabilities(): {
    handlers: Array<{
      name: string;
      actionKeywords: readonly string[];
      toolDependencies: readonly string[];
    }>;
    allActionKeywords: string[];
    installedTools: Array<{ name: string; available: boolean; version: string | null }>;
    unsatisfiedDependencies: string[];
  } {
    const handlers = this.operationRegistry?.listCapabilities() ?? [];
    const allKeywords = this.operationRegistry?.allActionKeywords() ?? [];
    const allDeps = this.operationRegistry?.allToolDependencies() ?? [];
    const installedTools = this.scanner.getInstalledTools();

    // Determine which handler tool dependencies are not installed
    const availableToolNames = new Set(
      installedTools.filter((t) => t.available).map((t) => t.name),
    );
    const unsatisfiedDependencies = allDeps.filter(
      (dep) => !availableToolNames.has(dep),
    );

    return {
      handlers,
      allActionKeywords: allKeywords,
      installedTools,
      unsatisfiedDependencies,
    };
  }
}
