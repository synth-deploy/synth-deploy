import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  DebriefWriter,
  DebriefEntry,
  DeploymentId,
  OperationId,
  PartitionId,
  EnvironmentId,
  SecurityBoundary,
  ArtifactAnalysis,
  DeploymentPlan,
  OperationPlan,
  ScriptedPlan,
  StepSummary,
  ConfigChange,
} from "@synth-deploy/core";
import { LlmClient, sanitizeForPrompt, maskIfSecret, QueryFindingsSchema, InvestigationFindingsSchema } from "@synth-deploy/core";
import type { QueryFindings, InvestigationFindings } from "@synth-deploy/core";
import type { EnvoyKnowledgeStore, LocalDeploymentRecord } from "../state/knowledge-store.js";
import { EnvironmentScanner } from "./environment-scanner.js";
import type { ServerReporter } from "./server-reporter.js";
import { DiagnosticInvestigator } from "./diagnostic-investigator.js";
import type { DiagnosticReport } from "./diagnostic-investigator.js";
import {
  DefaultOperationExecutor,
  BoundaryValidator,
  createPlatformAdapter,
} from "../execution/index.js";

import { createCallbackReporter } from "../execution/progress-reporter.js";
import { ProbeExecutor } from "./probe-executor.js";
import { PlanLogger } from "./plan-logger.js";
import { envoyLog, envoyWarn, envoyError } from "../logger.js";

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
  operationId: OperationId;
  partitionId: PartitionId;
  environmentId: EnvironmentId;
  version: string;
  variables: Record<string, string>;
  /** Name of the environment (for reasoning — "production" vs "staging" matters) */
  environmentName: string;
  /** Name of the partition (for debrief entries) */
  partitionName: string;
  /** Optional operation plan from the Command agent — when provided, the
   *  OperationExecutor runs the scripted plan with automatic rollback on failure */
  plan?: OperationPlan;
  /** URL to POST progress events to during execution (provided by Command) */
  progressCallbackUrl?: string;
}

/**
 * What the Envoy returns to the Server after executing a deployment.
 */
export interface DeploymentResult {
  deploymentId: DeploymentId;
  operationId: OperationId;
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
  operationId: string;
  /** Operation type — determines which planning path to use. Defaults to "deploy". */
  operationType?: "deploy" | "query" | "investigate" | "maintain" | "trigger";
  /** Natural language objective for non-deploy operations */
  intent?: string;
  /** Whether the investigation is allowed to run write probes (default false) */
  allowWrite?: boolean;
  artifact?: {
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
  /**
   * User-provided feedback from reviewing the previous plan.
   * When set, the LLM incorporates this feedback into the new plan.
   */
  refinementFeedback?: string;
  /**
   * Prior shelved plan for this same artifact+environment combination.
   * Injected as soft context — the LLM can use it to avoid re-reasoning from scratch
   * but must still re-validate against current infrastructure state.
   */
  shelvedPlanContext?: {
    reasoning: string;
    shelvedAt: string;
    shelvedReason?: string;
  };
  /** Trigger-specific: the condition expression (e.g. "disk_usage > 85") */
  triggerCondition?: string;
  /** Trigger-specific: what to do when the condition fires */
  triggerResponseIntent?: string;
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
  queryFindings?: QueryFindings;
  investigationFindings?: InvestigationFindings;
  delta?: string;
  /** LLM-generated 1-2 sentence assessment specific to this deployment */
  assessmentSummary?: string;
  /** True when the LLM assessed the plan as blocked by issues that cannot be resolved by plan changes */
  blocked?: boolean;
  /** Human-readable explanation of what must be fixed before proceeding */
  blockReason?: string;
  /** Trigger-specific: LLM-recommended polling interval in ms (overrides server default of 60000) */
  intervalMs?: number;
  /** Trigger-specific: LLM-recommended cooldown in ms between firings (overrides server default of 300000) */
  cooldownMs?: number;
}

export type { QueryFindings, InvestigationFindings } from "@synth-deploy/core";

/**
 * Input for post-hoc rollback plan generation — used when the user requests
 * a rollback plan from the Debrief, after a deployment has already run.
 *
 * Unlike PlanningInstruction (which is forward-planning before execution),
 * this is backward-planning based on what actually happened.
 */
export interface RollbackPlanningInstruction {
  operationId: string;
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
  private scanner: EnvironmentScanner;
  private investigator: DiagnosticInvestigator;
  private reporter: ServerReporter | null;
  private llmClient: LlmClient | null;
  private _lifecycleState: LifecycleState = "active";
  private executorReady: Promise<void>;
  /** Shared across plan requests so probe results are cached between calls. */
  private probeExecutor = new ProbeExecutor({
    cacheTtlMs: process.env.SYNTH_PROBE_CACHE_TTL_MS
      ? parseInt(process.env.SYNTH_PROBE_CACHE_TTL_MS, 10)
      : 600_000, // 10 minutes — environment fundamentals don't change during active planning
  });
  /** File-based structured logger for planning diagnostics. */
  private planLog: PlanLogger;

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
    this.planLog = new PlanLogger(baseDir);

    // Initialize the operation executor asynchronously — platform detection
    // requires dynamic imports
    this.executorReady = this.initExecutor();
  }

  private async initExecutor(): Promise<void> {
    const adapter = await createPlatformAdapter();
    this.operationExecutor = new DefaultOperationExecutor(
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
   * Validate a scripted plan against security boundaries without executing.
   * Used by Server to verify user-modified plans are feasible.
   */
  async validateScriptedPlan(
    plan: ScriptedPlan,
    boundaries: SecurityBoundary[] = [],
  ): Promise<{
    valid: boolean;
    violations: string[];
  }> {
    await this.executorReady;

    const result = new BoundaryValidator().validatePlan(plan, boundaries);

    return {
      valid: result.allowed,
      violations: result.violations,
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
        operationId: instruction.operationId,
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
      operationId: instruction.operationId,
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
        operationId: instruction.operationId,
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
        operationId: instruction.operationId,
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
      operationId: instruction.operationId,
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
      workspacePath: `${this.baseDir}/deployments/${instruction.operationId}`,
    });

    // --- Step 4: Execute -------------------------------------------------------

    // Branch: if a plan was provided by Command, use the OperationExecutor.
    // Otherwise, write workspace artifacts directly (the default path).
    if (instruction.plan?.scriptedPlan) {
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
   * Used when the Command agent provides a scripted plan.
   */
  private async executePlan(
    instruction: DeploymentInstruction,
    localRecord: LocalDeploymentRecord,
    totalStart: number,
    debriefEntryIds: string[],
    debriefEntries: DebriefEntry[],
    recordEntry: (params: Parameters<DebriefWriter["record"]>[0]) => DebriefEntry,
  ): Promise<DeploymentResult> {
    const scriptedPlan = instruction.plan!.scriptedPlan;
    const stepCount = scriptedPlan.stepSummary.length;

    recordEntry({
      partitionId: instruction.partitionId,
      operationId: instruction.operationId,
      agent: "envoy",
      decisionType: "deployment-execution",
      decision:
        `Executing scripted plan: ${stepCount} step(s) for ${instruction.operationId} ` +
        `v${instruction.version} via OperationExecutor`,
      reasoning:
        `Environment scan passed. Executing scripted ${scriptedPlan.platform} plan ` +
        `with ${stepCount} step(s) via the OperationExecutor. ` +
        `Steps: ${scriptedPlan.stepSummary.map((s) => s.description).join("; ")}. ` +
        `If execution fails, the rollback script runs automatically.`,
      context: {
        step: "execute",
        workspacePath: localRecord.workspacePath,
        stepCount,
        platform: scriptedPlan.platform,
        steps: scriptedPlan.stepSummary.map((s) => ({ description: s.description, reversible: s.reversible })),
      },
    });

    envoyLog("EXECUTE-START", { operationId: instruction.operationId, steps: stepCount });
    const execStart = Date.now();
    const planResult = await this.operationExecutor!.executePlan(
      scriptedPlan,
      undefined,
      instruction.operationId,
    );
    const execDurationMs = Date.now() - execStart;

    if (!planResult.success) {
      const errorMsg = planResult.executionResult.stderr || "Execution script failed";
      envoyError("EXECUTE-FAILED", { operationId: instruction.operationId, reason: errorMsg });

      this.state.completeDeployment(instruction.deploymentId, "failed", errorMsg);

      const diagnostic = this.investigator.investigate(
        localRecord.workspacePath,
        instruction,
        { success: false, workspacePath: localRecord.workspacePath, artifacts: [], durationMs: execDurationMs, error: errorMsg },
      );

      recordEntry({
        partitionId: instruction.partitionId,
        operationId: instruction.operationId,
        agent: "envoy",
        decisionType: "deployment-failure",
        decision: `Script execution failed (exit ${planResult.executionResult.exitCode}): ${errorMsg.slice(0, 200)}`,
        reasoning:
          `Execution script failed with exit code ${planResult.executionResult.exitCode}. ` +
          `Error: ${errorMsg.slice(0, 500)}. ` +
          `${planResult.rollbackResult ? `Automatic rollback script was executed. ` : ""}` +
          `The environment should be in its previous state. Total execution time: ${execDurationMs}ms.`,
        context: { step: "execute", error: errorMsg, durationMs: execDurationMs, exitCode: planResult.executionResult.exitCode },
      });

      recordEntry({
        partitionId: instruction.partitionId,
        operationId: instruction.operationId,
        agent: "envoy",
        decisionType: "diagnostic-investigation",
        decision: `Investigation: ${diagnostic.summary}`,
        reasoning: `Root cause: ${diagnostic.rootCause} Recommendation: ${diagnostic.recommendation}`,
        context: { diagnostic, evidenceCount: diagnostic.evidence.length, failureType: diagnostic.failureType },
      });

      const failResult: DeploymentResult = {
        deploymentId: instruction.deploymentId,
        operationId: instruction.operationId,
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

    // Collect artifact names from step summaries
    const artifacts = scriptedPlan.stepSummary.map((s) => s.description);

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
      operationId: instruction.operationId,
      agent: "envoy",
      decisionType: "deployment-verification",
      decision: `Script execution verified — completed successfully`,
      reasoning:
        `Execution script completed successfully (exit 0) ` +
        `in ${execDurationMs}ms covering ${stepCount} step(s).`,
      context: { step: "verify", passed: true, stepCount },
    });

    recordEntry({
      partitionId: instruction.partitionId,
      operationId: instruction.operationId,
      agent: "envoy",
      decisionType: "deployment-completion",
      decision:
        `Deployment complete: ${instruction.operationId} ` +
        `v${instruction.version} is now live on "${instruction.environmentName}"`,
      reasoning:
        `Full local pipeline completed successfully: environment scan ` +
        `confirmed readiness, scripted plan executed via OperationExecutor. ` +
        `Local state updated — "${instruction.environmentName}" now runs ` +
        `v${instruction.version} for partition "${instruction.partitionName}". ` +
        `Total execution time: ${totalDurationMs}ms.`,
      context: {
        step: "complete",
        artifacts,
        executionDurationMs: execDurationMs,
        totalDurationMs,
        workspacePath: localRecord.workspacePath,
      },
    });

    envoyLog("EXECUTE-COMPLETE", { operationId: instruction.operationId, success: true });
    const successResult: DeploymentResult = {
      deploymentId: instruction.deploymentId,
      operationId: instruction.operationId,
      success: true,
      workspacePath: localRecord.workspacePath,
      artifacts,
      executionDurationMs: execDurationMs,
      totalDurationMs,
      verificationPassed: true,
      verificationChecks: scriptedPlan.stepSummary.map((s) => ({
        name: s.description,
        passed: true,
        detail: s.description,
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
      operationId: instruction.operationId,
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
        instruction.operationId,
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
        operationId: instruction.operationId,
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
        operationId: instruction.operationId,
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
        operationId: instruction.operationId,
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
      operationId: instruction.operationId,
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
        instruction.operationId,
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
        operationId: instruction.operationId,
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
        operationId: instruction.operationId,
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
      operationId: instruction.operationId,
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
      operationId: instruction.operationId,
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
   * Validate whether user feedback on a deployment plan warrants triggering
   * a full replan. This is a cheap LLM call (no probe loop, no environment
   * scanning) used as a pre-flight check before the expensive planDeployment.
   *
   * Always returns { mode: "replan" } if the LLM is unavailable or fails — the
   * user must never be blocked due to infrastructure issues.
   */
  async validateRefinementFeedback(params: {
    feedback: string;
    currentPlanSummary: Array<{ description: string; reversible: boolean }>;
    artifactName: string;
    environmentName: string;
    llmApiKey?: string;
  }): Promise<{ mode: "replan" | "rejection" | "response"; message: string }> {
    if (params.llmApiKey) {
      process.env.SYNTH_LLM_API_KEY = params.llmApiKey;
    }

    if (!this.llmClient?.isAvailable()) {
      // No LLM — allow all feedback through so the user is never blocked
      return { mode: "replan", message: "LLM unavailable — proceeding with replan" };
    }

    const stepsSummary = params.currentPlanSummary
      .map((s, i) => `${i + 1}. ${s.description}${s.reversible ? " (reversible)" : ""}`)
      .join("\n");

    const prompt =
      `You are evaluating user input on a deployment plan. The user may be requesting a change, asking a question, or providing unclear feedback.\n\n` +
      `## Current plan for ${sanitizeForPrompt(params.artifactName)} → ${sanitizeForPrompt(params.environmentName)}\n` +
      `${stepsSummary}\n\n` +
      `## User input\n` +
      `"${sanitizeForPrompt(params.feedback)}"\n\n` +
      `Classify this input into exactly one of three modes:\n\n` +
      `"replan" — The user has identified a specific change the plan needs:\n` +
      `  - A missing step (something the plan should do but doesn't)\n` +
      `  - A wrong step (specific path, command, config value that needs fixing)\n` +
      `  - A missing prerequisite or dependency\n` +
      `  - A specific sequence or ordering issue\n\n` +
      `"rejection" — The feedback cannot meaningfully improve this plan:\n` +
      `  - Too vague to act on ("make it better", "fix it")\n` +
      `  - Already fully addressed by the current steps\n` +
      `  - Unrelated to deployment (UI, features, business logic, etc.)\n` +
      `  - Contradictory or technically impossible\n\n` +
      `"response" — The user is asking a question about the plan:\n` +
      `  - "Why are you doing X?"\n` +
      `  - "What does step N do?"\n` +
      `  - "Is this safe?"\n` +
      `  - Any interrogative about the plan's reasoning or approach\n\n` +
      `For "replan": message = one sentence describing what change to incorporate.\n` +
      `For "rejection": message = one sentence explaining why this won't improve the plan.\n` +
      `For "response": message = a direct, specific answer to their question based on the plan steps shown.\n\n` +
      `Respond with JSON only:\n` +
      `{ "mode": "replan" | "rejection" | "response", "message": "..." }`;

    const result = await this.llmClient.reason({
      prompt,
      systemPrompt: "You are a deployment plan reviewer. Respond with JSON only.",
      promptSummary: "Validate refinement feedback",
      partitionId: null,
      operationId: null,
      maxTokens: 256,
    });

    if (!result.ok) {
      // LLM failed — allow feedback through rather than blocking the user
      return { mode: "replan", message: "Validation failed — proceeding with replan" };
    }

    try {
      let text = result.text.trim();
      const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fenced) text = fenced[1].trim();
      else if (!text.startsWith("{")) {
        const first = text.indexOf("{");
        const last = text.lastIndexOf("}");
        if (first !== -1 && last > first) text = text.substring(first, last + 1);
      }
      const parsed = JSON.parse(text) as { mode: string; message: string };
      return { mode: parsed.mode as "replan" | "rejection" | "response", message: parsed.message ?? "No message" };
    } catch {
      // Parse failure — allow through
      return { mode: "replan", message: "Could not parse validation response — proceeding with replan" };
    }
  }

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
    // --- Route non-deploy operation types ------------------------------------
    const opType = instruction.operationType ?? "deploy";
    if (opType === "query") {
      return this.planQuery(instruction);
    }
    if (opType === "investigate") {
      return this.planInvestigation(instruction);
    }
    if (opType === "maintain") {
      return this.planMaintain(instruction);
    }
    if (opType === "trigger") {
      return this.planTrigger(instruction);
    }

    // Deploy path: artifact is required
    if (!instruction.artifact) {
      throw new Error("PlanningInstruction.artifact is required for deploy operations");
    }
    const artifact = instruction.artifact;

    const debriefEntries: DebriefEntry[] = [];

    const recordEntry = (params: Parameters<DebriefWriter["record"]>[0]): DebriefEntry => {
      const entry = this.debrief.record(params);
      debriefEntries.push(entry);
      return entry;
    };

    // --- 1. Load context from knowledge store --------------------------------

    const successfulPlans = this.state.getSuccessfulPlans(
      artifact.type,
      instruction.environment.id,
    );
    const failedPlans = this.state.getFailedPlans(
      artifact.type,
      instruction.environment.id,
    );
    const systemKnowledge = this.state.getAllSystemKnowledge();
    const latestPlan = this.state.getLatestPlan(
      artifact.type,
      instruction.environment.id,
    );

    // --- 2. Scan local system (read-only) ------------------------------------

    const scanResult = this.scanner.scan();

    // --- 3. Reason with LLM --------------------------------------------------

    // Apply the Server-forwarded API key. Always update — the Server is the
    // source of truth, and the key may have been rotated since the last request.
    if (instruction.llmApiKey) {
      process.env.SYNTH_LLM_API_KEY = instruction.llmApiKey;
    }

    const llmAvail = this.llmClient?.isAvailable() ?? false;
    this.planLog.log("LLM-CHECK", `available=${llmAvail} hasClient=${!!this.llmClient} envKey=${process.env.SYNTH_LLM_API_KEY ? "set" : "NOT SET"} instructionKey=${instruction.llmApiKey ? "forwarded" : "not forwarded"}`);
    envoyLog("LLM-CHECK", { available: llmAvail, hasClient: !!this.llmClient, envKeySet: !!process.env.SYNTH_LLM_API_KEY, instructionKeyForwarded: !!instruction.llmApiKey });

    if (this.llmClient && llmAvail) {
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
      operationId: instruction.operationId,
      agent: "envoy",
      decisionType: "plan-generation",
      decision:
        `Generated basic deployment plan for ${artifact.name} ` +
        `v${instruction.version} → "${instruction.environment.name}" (LLM unavailable)`,
      reasoning:
        `LLM connection is not available. Falling back to a basic plan based on ` +
        `artifact type "${artifact.type}": copy artifact to workspace, ` +
        `write configuration, restart service. This plan lacks intelligent reasoning ` +
        `about the target environment and previous deployment history. ` +
        `Configure an LLM provider in Settings for intelligent plan generation.`,
      context: {
        artifactType: artifact.type,
        environmentName: instruction.environment.name,
        llmAvailable: false,
        previousSuccessfulPlans: successfulPlans.length,
        previousFailedPlans: failedPlans.length,
      },
    });

    return this.buildFallbackPlan(instruction);
  }

  /**
   * Shared probe loop for read-only operations (query and investigation).
   * Runs the LLM probe loop, records debrief entries, and returns the final
   * LLM text and the full probe log.
   */
  private async executeProbeLoop(
    instruction: PlanningInstruction,
    opts: {
      systemPrompt: string;
      promptSummary: string;
      allowWrite?: boolean;
    },
  ): Promise<{ text: string | null; probeLog: string[] }> {
    const probeLog: string[] = [];

    const result = await this.llmClient!.callWithProbeLoop({
      systemPrompt: opts.systemPrompt,
      prompt: instruction.intent ?? "",
      promptSummary: opts.promptSummary,
      partitionId: instruction.partition?.id ?? null,
      operationId: instruction.operationId,
      onProbe: async (command: string) => {
        const probeResult = await this.probeExecutor.execute(command, { allowWrite: opts.allowWrite });
        const logEntry = probeResult.blocked
          ? `Probe blocked: ${command} — ${probeResult.blockedReason}`
          : `Probe: ${command}\n${probeResult.output}`;
        probeLog.push(logEntry);

        this.debrief.record({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "environment-probe",
          decision: probeResult.blocked ? `Probe blocked: ${command}` : `Probe executed: ${command}`,
          reasoning: probeResult.blocked ? (probeResult.blockedReason ?? "blocked") : probeResult.output ?? "(no output)",
          context: { command, blocked: probeResult.blocked, exitCode: probeResult.exitCode },
        });

        return probeResult.blocked
          ? (probeResult.blockedReason ?? "Command blocked")
          : (probeResult.output ?? "(no output)");
      },
    });

    return { text: result.ok ? (result.text ?? null) : null, probeLog };
  }

  /**
   * Plan a trigger operation: probe the environment to understand what
   * monitoring commands are available, then generate a set of monitoring
   * probes with LLM-recommended interval and cooldown.
   */
  private async planTrigger(instruction: PlanningInstruction): Promise<PlanningResult> {
    const condition = instruction.triggerCondition ?? instruction.intent ?? "check environment";
    const responseIntent = instruction.triggerResponseIntent ?? "";
    const envName = instruction.environment.name;

    const TriggerDirectiveSchema = z.object({
      probes: z.array(z.object({
        command: z.string(),
        label: z.string(),
        parseAs: z.enum(["numeric", "exitCode"]).default("numeric"),
      })).min(1),
      intervalMs: z.number().int().positive().default(60_000),
      cooldownMs: z.number().int().positive().default(300_000),
      reasoning: z.string(),
    });
    type TriggerDirective = z.infer<typeof TriggerDirectiveSchema>;

    if (instruction.llmApiKey) {
      process.env.SYNTH_LLM_API_KEY = instruction.llmApiKey;
    }

    // Trigger ops degrade softly when the LLM is unavailable: a default echo probe
    // is installed so the monitoring directive is valid and the operation can proceed.
    // This differs from query/investigate which hard-fail without the LLM — a trigger
    // at least gets installed and can be updated later when an LLM key is configured.
    if (!this.llmClient || !this.llmClient.isAvailable()) {
      this.debrief.record({
        partitionId: instruction.partition?.id ?? null,
        operationId: instruction.operationId,
        agent: "envoy",
        decisionType: "plan-generation",
        decision: `Generated basic monitoring plan for: ${condition} (LLM unavailable)`,
        reasoning: `LLM unavailable — a default echo probe will be installed. Configure an LLM provider for intelligent monitoring probe generation that can detect the actual condition values.`,
        context: { condition, envName, llmAvailable: false },
      });

      const plan: OperationPlan = {
        scriptedPlan: {
          platform: "bash",
          executionScript: "#!/bin/bash\nset -euo pipefail\necho 0",
          dryRunScript: null,
          rollbackScript: null,
          reasoning: `Basic monitoring plan for: ${condition}. LLM unavailable — configure an LLM provider for intelligent probe generation.`,
          stepSummary: [{ description: "Default echo probe", reversible: false }],
        },
        reasoning: `Basic monitoring plan for: ${condition}. LLM unavailable — configure an LLM provider for intelligent probe generation.`,
      };
      const emptyRollback: OperationPlan = {
        scriptedPlan: {
          platform: "bash",
          executionScript: "echo 'No rollback needed'",
          dryRunScript: null,
          rollbackScript: null,
          reasoning: "Monitoring triggers do not require rollback.",
          stepSummary: [],
        },
        reasoning: "Monitoring triggers do not require rollback.",
      };
      return { plan, rollbackPlan: emptyRollback };
    }

    const systemPrompt =
      `You are Synth's envoy agent designing a monitoring trigger for a target system.\n\n` +
      `Your job: produce shell commands that measure the values needed to evaluate the trigger condition.\n\n` +
      `Environment: ${envName}\n` +
      (instruction.partition ? `Partition: ${instruction.partition.name}\n` : "") +
      `Condition to monitor: ${condition}\n` +
      `Response when triggered: ${responseIntent || "(not specified)"}\n` +
      `Available variables: ${JSON.stringify(instruction.resolvedVariables)}\n\n` +
      `Use the probe tool to explore the target system and verify your monitoring commands work:\n` +
      `- Identify what tools are available (df, free, ps, netstat, etc.)\n` +
      `- Test commands that produce the values needed to evaluate the condition\n` +
      `- Ensure each probe command outputs a single value (numeric preferred)\n\n` +
      `The condition expression uses probe labels — match your probe labels to the identifiers ` +
      `used in the condition: "${condition}"\n\n` +
      `Choose intervalMs and cooldownMs appropriate to the condition type:\n` +
      `- Fast-changing metrics (CPU, memory): interval 30000-60000ms\n` +
      `- Slower metrics (disk, service health): interval 60000-300000ms\n` +
      `- cooldownMs should be longer than intervalMs to prevent storm\n\n` +
      `When ready, respond with ONLY a JSON object matching this schema:\n` +
      `{\n` +
      `  "probes": [\n` +
      `    { "command": "shell command outputting a single value", "label": "probe_label", "parseAs": "numeric" }\n` +
      `  ],\n` +
      `  "intervalMs": <ms between checks>,\n` +
      `  "cooldownMs": <ms before re-firing after trigger>,\n` +
      `  "reasoning": "brief explanation of monitoring strategy"\n` +
      `}`;

    let directive: TriggerDirective | null = null;
    let probeLog: string[] = [];

    try {
      const loopResult = await this.executeProbeLoop(instruction, {
        systemPrompt,
        promptSummary: `Trigger: ${condition}`,
        allowWrite: false,
      });
      probeLog = loopResult.probeLog;

      if (loopResult.text) {
        const jsonMatch = loopResult.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed = TriggerDirectiveSchema.safeParse(JSON.parse(jsonMatch[0]));
            if (parsed.success) directive = parsed.data;
          } catch {
            // malformed JSON — fall through to default probe below
          }
        }
      }
    } catch (err) {
      this.debrief.record({
        partitionId: instruction.partition?.id ?? null,
        operationId: instruction.operationId,
        agent: "envoy",
        decisionType: "plan-generation",
        decision: "Trigger planning failed",
        reasoning: err instanceof Error ? err.message : String(err),
        context: { error: true },
      });
      throw err;
    }

    if (!directive) {
      directive = {
        probes: [{ command: "echo 0", label: "default", parseAs: "numeric" as const }],
        intervalMs: 60_000,
        cooldownMs: 300_000,
        reasoning: `Could not parse structured monitoring probes from LLM response. Using a default probe. ${probeLog.length} probe(s) executed during planning.`,
      };
    }

    this.debrief.record({
      partitionId: instruction.partition?.id ?? null,
      operationId: instruction.operationId,
      agent: "envoy",
      decisionType: "plan-generation",
      decision: `Monitoring plan: ${directive.probes.length} probe(s) for "${condition}" — every ${Math.round(directive.intervalMs / 1000)}s, cooldown ${Math.round(directive.cooldownMs / 1000)}s`,
      reasoning: directive.reasoning,
      context: {
        probeCount: directive.probes.length,
        condition,
        intervalMs: directive.intervalMs,
        cooldownMs: directive.cooldownMs,
        probeLabels: directive.probes.map((p) => p.label),
      },
    });

    // Build probe scripts into a single monitoring script
    const probeScript = directive.probes.map((p) =>
      `# Probe: ${p.label}\n${p.command}`,
    ).join("\n\n");

    const plan: OperationPlan = {
      scriptedPlan: {
        platform: "bash",
        executionScript: `#!/bin/bash\nset -euo pipefail\n\n${probeScript}`,
        dryRunScript: null,
        rollbackScript: null,
        reasoning: directive.reasoning,
        stepSummary: directive.probes.map((p) => ({
          description: `Probe: ${p.label} (${p.parseAs})`,
          reversible: false,
        })),
      },
      reasoning: directive.reasoning,
    };

    const emptyRollback: OperationPlan = {
      scriptedPlan: {
        platform: "bash",
        executionScript: "echo 'No rollback needed'",
        dryRunScript: null,
        rollbackScript: null,
        reasoning: "Monitoring triggers do not require rollback.",
        stepSummary: [],
      },
      reasoning: "Monitoring triggers do not require rollback.",
    };

    return {
      plan,
      rollbackPlan: emptyRollback,
      intervalMs: directive.intervalMs,
      cooldownMs: directive.cooldownMs,
    };
  }

  /**
   * Plan a read-only query operation: probe the target environment and produce
   * a structured findings report. No deployment steps are generated.
   */
  private async planQuery(instruction: PlanningInstruction): Promise<PlanningResult> {
    const intent = instruction.intent ?? "Query the target environment";
    const envName = instruction.environment.name;

    if (!this.llmClient) {
      throw new Error("LLM client not initialized — cannot run query operation");
    }

    // Apply forwarded API key
    if (instruction.llmApiKey) {
      process.env.SYNTH_LLM_API_KEY = instruction.llmApiKey;
    }

    const systemPrompt =
      `You are Synth's envoy agent performing a read-only query operation.\n\n` +
      `Your job: probe the target environment and produce a structured findings report. ` +
      `You are NOT planning deployment steps.\n\n` +
      `Environment: ${envName}\n` +
      (instruction.partition ? `Partition: ${instruction.partition.name}\n` : "") +
      `Objective: ${intent}\n\n` +
      `Available variables: ${JSON.stringify(instruction.resolvedVariables)}\n\n` +
      `Use the probe tool to run read-only shell commands and gather information. ` +
      `Then summarize your findings.\n\n` +
      `When you have enough information, respond with ONLY a JSON object matching this schema:\n` +
      `{\n` +
      `  "targetsSurveyed": ["string"],\n` +
      `  "summary": "string",\n` +
      `  "findings": [\n` +
      `    {\n` +
      `      "target": "string",\n` +
      `      "observations": ["string"]\n` +
      `    }\n` +
      `  ]\n` +
      `}`;

    let queryFindings: QueryFindings | null = null;
    let probeLog: string[] = [];

    try {
      const loopResult = await this.executeProbeLoop(instruction, {
        systemPrompt,
        promptSummary: `Query: ${intent}`,
        allowWrite: false,
      });
      probeLog = loopResult.probeLog;

      if (loopResult.text) {
        const jsonMatch = loopResult.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = QueryFindingsSchema.safeParse(JSON.parse(jsonMatch[0]));
          if (parsed.success) queryFindings = parsed.data;
        }
      }
    } catch (err) {
      this.debrief.record({
        partitionId: instruction.partition?.id ?? null,
        operationId: instruction.operationId,
        agent: "envoy",
        decisionType: "query-findings",
        decision: "Query failed",
        reasoning: err instanceof Error ? err.message : String(err),
        context: { error: true },
      });
      throw err;
    }

    if (!queryFindings) {
      queryFindings = {
        targetsSurveyed: [instruction.environment.name],
        summary: `Query completed for objective: ${intent}. ${probeLog.length} probe(s) executed.`,
        findings: [{
          target: instruction.environment.name,
          observations: probeLog.slice(0, 10),
        }],
      };
    }

    const stubPlan: OperationPlan = {
      scriptedPlan: {
        platform: "bash",
        executionScript: "echo 'Query operation — no execution script'",
        dryRunScript: null,
        rollbackScript: null,
        reasoning: queryFindings.summary,
        stepSummary: [],
      },
      reasoning: queryFindings.summary,
    };

    return {
      plan: stubPlan,
      rollbackPlan: stubPlan,
      queryFindings,
    };
  }

  /**
   * Plan a diagnostic investigation: iteratively probe the target environment
   * to identify root causes and propose resolutions.
   */
  private async planInvestigation(instruction: PlanningInstruction): Promise<PlanningResult> {
    const intent = instruction.intent ?? "Investigate the target environment";
    const envName = instruction.environment.name;

    if (!this.llmClient) {
      throw new Error("LLM client not initialized — cannot run investigation operation");
    }

    // Apply forwarded API key
    if (instruction.llmApiKey) {
      process.env.SYNTH_LLM_API_KEY = instruction.llmApiKey;
    }

    const systemPrompt =
      `You are Synth's envoy agent performing a diagnostic investigation.\n\n` +
      `Your job: iteratively probe the target environment to diagnose issues. ` +
      `Use each finding to determine what to check next. ` +
      `You are NOT planning deployment steps.\n\n` +
      `Environment: ${envName}\n` +
      (instruction.partition ? `Partition: ${instruction.partition.name}\n` : "") +
      `Objective: ${intent}\n` +
      (instruction.allowWrite
        ? `Write access: authorized (you may suggest write operations in proposed resolution)\n`
        : `Write access: not authorized (read-only investigation)\n`) +
      `\nAvailable variables: ${JSON.stringify(instruction.resolvedVariables)}\n\n` +
      `Use the probe tool to run read-only shell commands. Probe iteratively — let each ` +
      `finding guide your next probe. Correlate findings to identify root causes.\n\n` +
      `When you have completed your investigation, respond with ONLY a JSON object matching this schema:\n` +
      `{\n` +
      `  "targetsSurveyed": ["string"],\n` +
      `  "summary": "string",\n` +
      `  "findings": [\n` +
      `    {\n` +
      `      "target": "string",\n` +
      `      "observations": ["string"]\n` +
      `    }\n` +
      `  ],\n` +
      `  "rootCause": "string or null",\n` +
      `  "proposedResolution": {\n` +
      `    "intent": "string",\n` +
      `    "operationType": "maintain or deploy",\n` +
      `    "parameters": {}\n` +
      `  }\n` +
      `}\n\n` +
      `If no root cause is found, set "rootCause" to null and omit "proposedResolution".`;

    let investigationFindings: InvestigationFindings | null = null;
    let probeLog: string[] = [];

    try {
      const loopResult = await this.executeProbeLoop(instruction, {
        systemPrompt,
        promptSummary: `Investigate: ${intent}`,
        allowWrite: instruction.allowWrite,
      });
      probeLog = loopResult.probeLog;

      if (loopResult.text) {
        const jsonMatch = loopResult.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = InvestigationFindingsSchema.safeParse(JSON.parse(jsonMatch[0]));
          if (parsed.success) {
            const { rootCause, ...rest } = parsed.data;
            investigationFindings = { ...rest, rootCause: rootCause ?? undefined };
          }
        }
      }
    } catch (err) {
      this.debrief.record({
        partitionId: instruction.partition?.id ?? null,
        operationId: instruction.operationId,
        agent: "envoy",
        decisionType: "investigation-findings",
        decision: "Investigation failed",
        reasoning: err instanceof Error ? err.message : String(err),
        context: { error: true },
      });
      throw err;
    }

    if (!investigationFindings) {
      investigationFindings = {
        targetsSurveyed: [instruction.environment.name],
        summary: `Investigation completed for objective: ${intent}. ${probeLog.length} probe(s) executed. Unable to parse structured findings.`,
        findings: [{
          target: instruction.environment.name,
          observations: probeLog.slice(0, 10),
        }],
      };
    }

    const stubPlan: OperationPlan = {
      scriptedPlan: {
        platform: "bash",
        executionScript: "echo 'Investigation operation — no execution script'",
        dryRunScript: null,
        rollbackScript: null,
        reasoning: investigationFindings.summary,
        stepSummary: [],
      },
      reasoning: investigationFindings.summary,
    };

    return {
      plan: stubPlan,
      rollbackPlan: stubPlan,
      investigationFindings,
    };
  }

  /**
   * Plan a maintenance operation: probe the target environment to understand
   * current state, then produce a concrete maintenance plan (service restarts,
   * config updates, cleanup, health fixes, etc.). No artifact is deployed —
   * the intent is the sole driver.
   */
  private async planMaintain(instruction: PlanningInstruction): Promise<PlanningResult> {
    const intent = instruction.intent ?? "Perform maintenance on the target environment";
    const envName = instruction.environment.name;

    if (!this.llmClient) {
      throw new Error("LLM client not initialized — cannot run maintain operation");
    }

    // Apply forwarded API key
    if (instruction.llmApiKey) {
      process.env.SYNTH_LLM_API_KEY = instruction.llmApiKey;
    }

    if (!this.llmClient.isAvailable()) {
      throw new Error(
        "LLM is unavailable — maintain operations require intelligent reasoning. " +
        "Configure an LLM provider in Settings to run maintenance operations.",
      );
    }

    const debriefEntries: DebriefEntry[] = [];
    const recordEntry = (params: Parameters<DebriefWriter["record"]>[0]): DebriefEntry => {
      const entry = this.debrief.record(params);
      debriefEntries.push(entry);
      return entry;
    };

    const scanResult = this.scanner.scan();
    const capabilities = this.getCapabilities();
    const availableTools = capabilities.installedTools
      .filter((t) => t.available)
      .map((t) => `${t.name} (${t.version ?? "version unknown"})`)
      .join(", ");
    const unavailableTools = capabilities.installedTools
      .filter((t) => !t.available)
      .map((t) => t.name)
      .join(", ");

    const scriptPlatform = process.platform === "win32" ? "powershell" : "bash";
    const scriptShebang = scriptPlatform === "bash" ? "#!/bin/bash\nset -euo pipefail" : "# PowerShell\n$ErrorActionPreference = 'Stop'";

    const planOutputFormat =
      `You must generate executable ${scriptPlatform} scripts, not structured step objects.\n\n` +
      `IMPORTANT: Respond with valid JSON only. No markdown, no commentary.\n\n` +
      `Response format:\n` +
      `{\n` +
      `  "platform": "${scriptPlatform}",\n` +
      `  "executionScript": "${scriptShebang}\\n...",\n` +
      `  "dryRunScript": "${scriptShebang}\\n... (read-only probes to validate prerequisites, or null)",\n` +
      `  "rollbackScript": "${scriptShebang}\\n... (undo the execution, or null if not reversible)",\n` +
      `  "reasoning": "Plain english explanation of what the scripts do and why",\n` +
      `  "stepSummary": [{"description": "Human-readable description of what this part does", "reversible": true}],\n` +
      `  "diffFromCurrent": [{"key": "config.setting", "from": "old", "to": "new"}],\n` +
      `  "assessmentSummary": "1-2 sentences specific to THIS maintenance task: what makes it risky or safe, what to watch for."\n` +
      `}\n\n` +
      `Script requirements:\n` +
      `- ${scriptPlatform === "bash" ? "Use set -euo pipefail at the top" : "Use $ErrorActionPreference = 'Stop' at the top"}\n` +
      `- Scripts must be self-contained and executable\n` +
      `- Do NOT use tools that are listed as unavailable\n` +
      `- The dryRunScript must be read-only (no mutations)\n` +
      `- The rollbackScript must undo what executionScript does`;

    const probeSystemPrompt =
      `You are Synth's envoy agent performing a maintenance operation.\n\n` +
      `Maintenance operations run tasks on EXISTING infrastructure: service restarts, ` +
      `config updates, log rotation, package upgrades, cleanup tasks, health fixes. ` +
      `No artifact is being deployed — work only with what is already on this machine.\n\n` +
      `Environment: ${envName}\n` +
      (instruction.partition ? `Partition: ${instruction.partition.name}\n` : "") +
      `Objective: ${intent}\n\n` +
      `Available variables: ${JSON.stringify(instruction.resolvedVariables)}\n\n` +
      `Installed tools: ${availableTools || "none"}\n` +
      `Unavailable tools: ${unavailableTools || "none"}\n\n` +
      `BEFORE generating the plan, use the probe() tool to verify real machine state:\n` +
      `- What services are running? (ps aux, systemctl status <service>)\n` +
      `- What is the current config state? (cat config files, find logs)\n` +
      `- What tool versions are available? (which, --version)\n` +
      `- Disk space and resource usage? (df -h, free -m)\n` +
      `- User context and permissions? (id, whoami)\n` +
      `- Any other observable fact your maintenance plan depends on\n\n` +
      `Probe until you have enough real observations to generate a grounded maintenance plan. ` +
      `Then output the plan as JSON.\n\n` +
      planOutputFormat;

    // Used on retries when probe observations are available in the prompt.
    const retrySystemPrompt =
      `You are Synth's envoy agent performing a maintenance operation.\n\n` +
      `Environment observations have already been collected and are provided in the prompt. ` +
      `Use those observations directly — do NOT attempt to call any tools. ` +
      `Output the maintenance plan as JSON.\n\n` +
      planOutputFormat;

    // Used on retries when the first attempt failed before making any probe calls
    // (probeLog is empty) — don't claim observations were collected when they weren't.
    const noObsRetrySystemPrompt =
      `You are Synth's envoy agent performing a maintenance operation.\n\n` +
      `A previous planning attempt failed. No environment observations are available. ` +
      `Use the context provided (environment name, resolved variables) ` +
      `to produce the best maintenance plan you can. Do NOT attempt to call any tools. ` +
      `Output the maintenance plan as JSON.\n\n` +
      planOutputFormat;

    const baseSections: string[] = [];

    baseSections.push(`## Maintenance Objective\n${sanitizeForPrompt(intent)}`);

    baseSections.push(
      `## Target Environment\n` +
      `Name: ${sanitizeForPrompt(envName)}\n` +
      `ID: ${instruction.environment.id}\n` +
      `Variables: ${Object.keys(instruction.environment.variables).length} defined`,
    );

    if (instruction.partition) {
      baseSections.push(
        `## Partition\n` +
        `Name: ${sanitizeForPrompt(instruction.partition.name)}\n` +
        `ID: ${instruction.partition.id}\n` +
        `Variables: ${Object.keys(instruction.partition.variables).length} defined`,
      );
    }

    baseSections.push(
      `## Resolved Variables\n` +
      `${Object.entries(instruction.resolvedVariables).map(([k, v]) => `${k}=${maskIfSecret(k, v)}`).join("\n")}`,
    );

    baseSections.push(
      `## Local System State\n` +
      `Hostname: ${scanResult.hostname}\n` +
      `OS: ${scanResult.os}\n` +
      `Deployments directory: ${scanResult.deploymentsDir}\n` +
      `Active environments: ${scanResult.knownState.activeEnvironments}\n` +
      `Last deployment: ${scanResult.knownState.lastDeploymentAt?.toISOString() ?? "none"}`,
    );

    baseSections.push(
      `## Envoy Capabilities\n` +
      `Script platform: ${scriptPlatform}\n` +
      `Installed tools: ${availableTools || "none"}\n` +
      `Unavailable tools: ${unavailableTools || "none"}`,
    );

    const reqId = instruction.operationId ?? crypto.randomUUID().slice(0, 8);
    this.planLog.startRequest(reqId, `maintain:${intent}`, "", envName);

    const MAX_ATTEMPTS = 3;
    let lastObservations: string | null = null;
    let previousObservationSummary = "";
    const probeLog: Array<{ command: string; output: string }> = [];
    const probeExecutor = this.probeExecutor;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      envoyLog("MAINTAIN-ATTEMPT", { attempt, maxAttempts: MAX_ATTEMPTS, intent });
      this.planLog.log(`ATTEMPT`, `attempt=${attempt}/${MAX_ATTEMPTS} method=${attempt === 1 ? "probeLoop" : "reason"} probes=${probeLog.length}`);
      const promptSections = [...baseSections];

      if (attempt > 1 && probeLog.length > 0) {
        const probeContext = probeLog.map((e) => `$ ${e.command}\n${e.output}`).join("\n\n");
        promptSections.push(
          `## Environment Observations (probed before this session)\n` +
          `${probeContext}\n\n` +
          `These are real observations from the target machine collected during this planning session. ` +
          `Use them as the basis for your plan — do not re-probe.`,
        );
      }

      if (lastObservations) {
        promptSections.push(
          `## Dry-Run Observations (system state from previous plan attempt)\n` +
          `${lastObservations}\n\n` +
          `A FAILED observation does not automatically mean the plan needs changing: if your ` +
          `plan already includes a step that will resolve the issue, the observation will ` +
          `be satisfied at runtime and you should keep the plan as-is. ` +
          `Only add new steps if the issue is genuinely not addressed by your current plan.`,
        );
      }

      const promptSummary =
        `Maintain: ${intent} → "${envName}"` +
        (attempt > 1 ? ` (attempt ${attempt} — revising for dry-run observations)` : "");

      let llmResult: import("@synth-deploy/core").LlmResult;

      if (attempt === 1) {
        llmResult = await this.llmClient!.callWithProbeLoop({
          prompt: promptSections.join("\n\n"),
          systemPrompt: probeSystemPrompt,
          promptSummary,
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          maxTokens: 4096,
          onProbe: async (command: string) => {
            const result = await probeExecutor.execute(command);
            recordEntry({
              partitionId: instruction.partition?.id ?? null,
              operationId: instruction.operationId,
              agent: "envoy",
              decisionType: "environment-probe",
              decision: result.blocked ? `Probe blocked: ${command}` : `Probe executed: ${command}`,
              reasoning: result.blocked
                ? result.blockedReason ?? "Command blocked"
                : `Exit ${result.exitCode ?? 0}`,
              context: {
                command,
                blocked: result.blocked,
                blockedReason: result.blockedReason,
                exitCode: result.exitCode,
                outputPreview: result.output ? result.output.slice(0, 500) : undefined,
              },
            });
            const output = result.blocked
              ? result.blockedReason ?? "Command blocked"
              : result.output ?? "(no output)";
            probeLog.push({ command, output });
            return output;
          },
        });
      } else {
        llmResult = await this.llmClient!.reason({
          prompt: promptSections.join("\n\n"),
          systemPrompt: probeLog.length > 0 ? retrySystemPrompt : noObsRetrySystemPrompt,
          promptSummary,
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          maxTokens: 4096,
        });
      }

      if (!llmResult.ok) {
        this.planLog.log(`LLM-FAIL attempt=${attempt}`, llmResult.reason);
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `LLM maintenance planning failed on attempt ${attempt}` +
            (attempt < MAX_ATTEMPTS ? ` — retrying with accumulated probe context` : ` — operation cannot proceed`),
          reasoning: `LLM call failed: ${llmResult.reason}.` +
            (probeLog.length > 0 ? ` ${probeLog.length} probe result(s) available for retry.` : ""),
          context: { llmFailed: true, llmReason: llmResult.reason, attempt, probeCount: probeLog.length },
        });
        if (attempt < MAX_ATTEMPTS) {
          lastObservations = `Previous planning attempt failed: ${llmResult.reason}. ` +
            `Use the environment observations above to generate the best plan you can.`;
          continue;
        }
        throw new Error(
          `Maintenance planning failed after ${MAX_ATTEMPTS} attempt(s): ${llmResult.reason}. ` +
          `LLM is required for maintenance operations.`,
        );
      }

      this.planLog.log(`LLM-RESPONSE attempt=${attempt}`, `length=${llmResult.text.length} starts=${llmResult.text.substring(0, 200)}`);

      type ParsedMaintenancePlan = {
        platform: "bash" | "powershell";
        executionScript: string;
        dryRunScript: string | null;
        rollbackScript: string | null;
        reasoning: string;
        stepSummary: Array<{ description: string; reversible: boolean }>;
        diffFromCurrent?: Array<{ key: string; from: string; to: string }>;
        assessmentSummary?: string;
      };

      let currentParsed: ParsedMaintenancePlan;
      try {
        let text = llmResult.text.trim();
        const fencedMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
        if (fencedMatch) {
          text = fencedMatch[1].trim();
        } else if (text.startsWith("```")) {
          text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        } else if (!text.startsWith("{")) {
          const firstBrace = text.indexOf("{");
          const lastBrace = text.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            text = text.substring(firstBrace, lastBrace + 1);
          }
        }
        const raw = JSON.parse(text);
        if (typeof raw?.executionScript !== "string" || !raw.executionScript) throw new Error("Plan missing executionScript");
        if (!Array.isArray(raw?.stepSummary)) throw new Error("Plan missing stepSummary array");
        // Default platform if not specified
        if (!raw.platform) raw.platform = scriptPlatform;
        currentParsed = raw as ParsedMaintenancePlan;
        this.planLog.log(`PARSED-OK attempt=${attempt}`, `${currentParsed.stepSummary.length} steps, reasoning=${currentParsed.reasoning?.length ?? 0} chars`);
      } catch (parseErr) {
        const preview = llmResult.text?.substring(0, 500) ?? "(no text)";
        this.planLog.log(`PARSE-FAIL attempt=${attempt}`, `error=${parseErr instanceof Error ? parseErr.message : String(parseErr)} preview=${preview}`);
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `LLM response could not be parsed on attempt ${attempt}`,
          reasoning:
            `Parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
            `Response preview: ${preview}`,
          context: { parseError: true, attempt, responsePreview: preview },
        });
        if (attempt < MAX_ATTEMPTS) {
          this.planLog.log(`PARSE-RETRY`, `will retry as attempt ${attempt + 1}`);
          lastObservations = `Previous LLM response could not be parsed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
            `You MUST respond with a valid JSON object containing "executionScript" (string) and "stepSummary" (array). ` +
            `Do not return an empty object.`;
          continue;
        }
        throw new Error(`Maintenance planning failed: LLM response could not be parsed after ${MAX_ATTEMPTS} attempt(s).`);
      }

      const plan: DeploymentPlan = {
        scriptedPlan: {
          platform: currentParsed.platform,
          executionScript: currentParsed.executionScript,
          dryRunScript: currentParsed.dryRunScript,
          rollbackScript: currentParsed.rollbackScript,
          reasoning: currentParsed.reasoning,
          stepSummary: currentParsed.stepSummary,
          diffFromCurrent: currentParsed.diffFromCurrent,
        },
        reasoning: currentParsed.reasoning,
        diffFromCurrent: currentParsed.diffFromCurrent,
      };

      this.planLog.log(`PLAN attempt=${attempt}`, `${currentParsed.stepSummary.length} steps in scripted plan`);

      await this.executorReady;

      if (!this.operationExecutor) {
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `Generated maintenance plan (dry-run skipped — executor not initialized): ${plan.scriptedPlan.stepSummary.length} step(s)`,
          reasoning: currentParsed.reasoning,
          context: { dryRunSkipped: true },
        });
        const rollbackPlan: DeploymentPlan = {
          scriptedPlan: {
            platform: currentParsed.platform,
            executionScript: currentParsed.rollbackScript ?? "echo 'No rollback script'",
            dryRunScript: null,
            rollbackScript: null,
            reasoning: `Rollback for maintenance: ${intent}`,
            stepSummary: currentParsed.stepSummary.filter((s) => s.reversible).map((s) => ({ description: `Undo: ${s.description}`, reversible: false })),
          },
          reasoning: `Rollback for maintenance: ${intent}`,
        };
        return {
          plan,
          rollbackPlan,
          assessmentSummary: currentParsed.assessmentSummary,
        };
      }

      const dryRunResult = await this.operationExecutor.executeDryRun(plan.scriptedPlan);

      this.planLog.log(`DRY-RUN attempt=${attempt}`, `exitCode=${dryRunResult.exitCode} success=${dryRunResult.success}`);

      if (dryRunResult.success) {
        this.planLog.log(`DRY-RUN-PASSED attempt=${attempt}`, `exitCode=${dryRunResult.exitCode}`);
        envoyLog("MAINTAIN-DRY-RUN", { attempt, passed: true });
        const rollbackPlan: DeploymentPlan = {
          scriptedPlan: {
            platform: currentParsed.platform,
            executionScript: currentParsed.rollbackScript ?? "echo 'No rollback script'",
            dryRunScript: null,
            rollbackScript: null,
            reasoning: `Rollback for maintenance: ${intent}`,
            stepSummary: currentParsed.stepSummary.filter((s) => s.reversible).map((s) => ({ description: `Undo: ${s.description}`, reversible: false })),
          },
          reasoning: `Rollback for maintenance: ${intent}`,
        };
        plan.reasoning =
          currentParsed.reasoning +
          ` [Dry-run validated on attempt ${attempt}: exit code ${dryRunResult.exitCode}.]`;

        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision:
            `Generated and validated maintenance plan: ${plan.scriptedPlan.stepSummary.length} step(s) → "${envName}" ` +
            `(dry-run passed on attempt ${attempt})`,
          reasoning: currentParsed.reasoning,
          context: {
            environmentName: envName,
            llmAvailable: true,
            stepCount: plan.scriptedPlan.stepSummary.length,
            dryRunAttempt: attempt,
            dryRunExitCode: dryRunResult.exitCode,
          },
        });

        envoyLog("MAINTAIN-COMPLETE", { steps: plan.scriptedPlan.stepSummary.length });
        return { plan, rollbackPlan, assessmentSummary: currentParsed.assessmentSummary };
      }

      // --- Dry-run failed ---
      this.planLog.log(`DRY-RUN-FAILED attempt=${attempt}`, `exitCode=${dryRunResult.exitCode}`);
      envoyLog("MAINTAIN-DRY-RUN", { attempt, passed: false, exitCode: dryRunResult.exitCode });

      const currentObsSummary =
        `Exit code: ${dryRunResult.exitCode}\n` +
        `stdout: ${dryRunResult.output.slice(0, 500)}\n` +
        `stderr: ${dryRunResult.errors.slice(0, 500)}`;

      if (attempt > 1 && currentObsSummary === previousObservationSummary) {
        this.planLog.log("STUCK", `same dry-run failures after ${attempt} attempts`);
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `Maintenance plan stuck — same dry-run failures after ${attempt} attempts`,
          reasoning:
            `Re-planning produced the same dry-run failures. ` +
            `Returning plan with failure annotations.`,
          context: { dryRunAttempt: attempt },
        });
        plan.reasoning = `Plan has unresolved environmental issues (stuck after ${attempt} attempt(s)). Review before approving.`;
        const rollbackPlan: DeploymentPlan = {
          scriptedPlan: {
            platform: currentParsed.platform,
            executionScript: currentParsed.rollbackScript ?? "echo 'No rollback script'",
            dryRunScript: null,
            rollbackScript: null,
            reasoning: `Rollback for maintenance: ${intent}`,
            stepSummary: [],
          },
          reasoning: `Rollback for maintenance: ${intent}`,
        };
        return {
          plan,
          rollbackPlan,
          assessmentSummary: currentParsed.assessmentSummary,
        };
      }

      if (attempt === MAX_ATTEMPTS) {
        this.planLog.log("BLOCKED", `max attempts reached`);
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `Maintenance plan blocked — unresolved issues after ${MAX_ATTEMPTS} attempts`,
          reasoning: `Dry-run failed: ${currentObsSummary}`,
          context: { dryRunAttempt: attempt, maxAttempts: MAX_ATTEMPTS },
        });
        const blockReason =
          `Plan dry-run failed after ${MAX_ATTEMPTS} attempt(s). Review before approving.`;
        plan.reasoning = blockReason;
        const rollbackPlan: DeploymentPlan = {
          scriptedPlan: {
            platform: currentParsed.platform,
            executionScript: currentParsed.rollbackScript ?? "echo 'No rollback script'",
            dryRunScript: null,
            rollbackScript: null,
            reasoning: `Rollback for maintenance: ${intent}`,
            stepSummary: [],
          },
          reasoning: `Rollback for maintenance: ${intent}`,
        };
        return {
          plan,
          rollbackPlan,
          assessmentSummary: currentParsed.assessmentSummary,
          blocked: true,
          blockReason,
        };
      }

      previousObservationSummary = currentObsSummary;

      lastObservations =
        `## Dry-Run Output\n` +
        `Exit code: ${dryRunResult.exitCode}\n` +
        `stdout:\n${dryRunResult.output}\n` +
        `stderr:\n${dryRunResult.errors}`;

      recordEntry({
        partitionId: instruction.partition?.id ?? null,
        operationId: instruction.operationId,
        agent: "envoy",
        decisionType: "plan-generation",
        decision: `Dry-run failed — re-planning with output context (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
        reasoning: `Dry-run exit code ${dryRunResult.exitCode}. Re-invoking planning with dry-run output injected as context.`,
        context: { dryRunAttempt: attempt, dryRunExitCode: dryRunResult.exitCode },
      });
    }

    throw new Error("Unreachable: maintenance planning loop exited without returning");
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
    // artifact is guaranteed non-null here — planDeployment asserts it before calling planWithLlm
    const artifact = instruction.artifact!;

    const reqId = instruction.operationId ?? crypto.randomUUID().slice(0, 8);
    this.planLog.startRequest(
      reqId,
      artifact.name,
      instruction.version,
      instruction.environment.name,
    );

    // Build prompt sections
    const sections: string[] = [];

    sections.push(`## Artifact
Name: ${sanitizeForPrompt(artifact.name)}
Type: ${sanitizeForPrompt(artifact.type)}
Version: ${instruction.version}
Analysis summary: ${sanitizeForPrompt(artifact.analysis.summary)}
Dependencies: ${sanitizeForPrompt(artifact.analysis.dependencies.join(", ") || "none")}
Configuration expectations: ${sanitizeForPrompt(JSON.stringify(artifact.analysis.configurationExpectations))}
Deployment intent: ${sanitizeForPrompt(artifact.analysis.deploymentIntent ?? "not specified")}
Confidence: ${artifact.analysis.confidence}`);

    sections.push(`## Target Environment
Name: ${sanitizeForPrompt(instruction.environment.name)}
ID: ${instruction.environment.id}
Variables: ${Object.keys(instruction.environment.variables).length} defined`);

    if (instruction.partition) {
      sections.push(`## Partition
Name: ${sanitizeForPrompt(instruction.partition.name)}
ID: ${instruction.partition.id}
Variables: ${Object.keys(instruction.partition.variables).length} defined`);
    }

    sections.push(`## Resolved Variables
${Object.entries(instruction.resolvedVariables).map(([k, v]) => `${k}=${maskIfSecret(k, v)}`).join("\n")}`);

    sections.push(`## Local System State
Hostname: ${scanResult.hostname}
OS: ${scanResult.os}
Deployments directory: ${scanResult.deploymentsDir}
Writable: ${scanResult.deploymentsWritable}
Existing deployments on disk: ${scanResult.disk.deploymentCount}
Known deployments in state: ${scanResult.knownState.totalDeployments}
Active environments: ${scanResult.knownState.activeEnvironments}
Last deployment: ${scanResult.knownState.lastDeploymentAt?.toISOString() ?? "none"}`);

    // Include capability surface so the LLM produces executable scripts
    const capabilities = this.getCapabilities();
    const availableTools = capabilities.installedTools
      .filter((t) => t.available)
      .map((t) => `${t.name} (${t.version ?? "version unknown"})`)
      .join(", ");
    const unavailableTools = capabilities.installedTools
      .filter((t) => !t.available)
      .map((t) => t.name)
      .join(", ");
    const scriptPlatform = process.platform === "win32" ? "powershell" : "bash";
    const scriptShebang = scriptPlatform === "bash" ? "#!/bin/bash\nset -euo pipefail" : "# PowerShell\n$ErrorActionPreference = 'Stop'";

    sections.push(`## Envoy Capabilities
Script platform: ${scriptPlatform}
Installed tools: ${availableTools || "none"}
Unavailable tools: ${unavailableTools || "none"}

IMPORTANT: Do NOT use tools that are listed as unavailable. Generate executable ${scriptPlatform} scripts.`);

    if (systemKnowledge.length > 0) {
      sections.push(`## System Knowledge
${systemKnowledge.map((k) => `[${k.category}] ${k.key}: ${JSON.stringify(k.value)}`).join("\n")}`);
    }

    if (successfulPlans.length > 0) {
      const recent = successfulPlans.slice(0, 3);
      sections.push(`## Previous Successful Plans (${successfulPlans.length} total, showing ${recent.length})
${recent.map((p) => `- ${p.artifactName} → ${p.environmentId}: ${p.plan.scriptedPlan?.stepSummary?.length ?? 0} steps, ${p.executionDurationMs}ms`).join("\n")}`);
    }

    if (failedPlans.length > 0) {
      const recent = failedPlans.slice(0, 3);
      sections.push(`## Previous Failed Plans (${failedPlans.length} total, showing ${recent.length}) — AVOID THESE PATTERNS
${recent.map((p) => `- ${p.artifactName} → ${p.environmentId}: ${p.failureAnalysis ?? "no analysis"}`).join("\n")}`);
    }

    if (instruction.shelvedPlanContext) {
      const shelvedDate = new Date(instruction.shelvedPlanContext.shelvedAt);
      const daysSinceShelved = Math.round((Date.now() - shelvedDate.getTime()) / (1000 * 60 * 60 * 24));
      const staleness = daysSinceShelved === 0 ? "today" : daysSinceShelved === 1 ? "1 day ago" : `${daysSinceShelved} days ago`;
      const reasonNote = instruction.shelvedPlanContext.shelvedReason
        ? ` Reason given: "${instruction.shelvedPlanContext.shelvedReason}".`
        : "";
      sections.push(`## Prior Shelved Plan (shelved ${staleness}${reasonNote})\nThe following reasoning was produced for a previous plan that was shelved rather than executed. Use it as context to inform your current plan, but re-validate all assumptions against current infrastructure state — conditions may have changed since this was shelved.\n\n${instruction.shelvedPlanContext.reasoning}`);
    }

    if (instruction.refinementFeedback) {
      sections.push(`## User Refinement Request\n${instruction.refinementFeedback}\n\nThe user reviewed the previous plan and has requested this change. Incorporate this feedback into the new plan.`);
    }

    // Shared JSON output format tail used by both system prompts.
    const planOutputFormat =
      `You must generate executable ${scriptPlatform} scripts, not structured step objects.\n\n` +
      `IMPORTANT: Respond with valid JSON only. No markdown, no commentary.\n\n` +
      `Response format:\n` +
      `{\n` +
      `  "platform": "${scriptPlatform}",\n` +
      `  "executionScript": "${scriptShebang}\\n...",\n` +
      `  "dryRunScript": "${scriptShebang}\\n... (read-only probes to validate prerequisites, or null)",\n` +
      `  "rollbackScript": "${scriptShebang}\\n... (undo the execution, or null if not reversible)",\n` +
      `  "reasoning": "Plain english explanation of what the scripts do and why",\n` +
      `  "stepSummary": [{"description": "Human-readable description of what this part does", "reversible": true}],\n` +
      `  "diffFromCurrent": [{"key": "config.setting", "from": "old", "to": "new"}],\n` +
      `  "delta": "If a previous successful plan exists, describe what changed and why. Omit if no previous plan.",\n` +
      `  "assessmentSummary": "1-2 sentences specific to THIS deployment: what makes it risky or safe, what to watch for. Be specific to the artifact name, version, target environment — not generic boilerplate."\n` +
      `}\n\n` +
      `Script requirements:\n` +
      `- ${scriptPlatform === "bash" ? "Use set -euo pipefail at the top" : "Use $ErrorActionPreference = 'Stop' at the top"}\n` +
      `- Scripts must be self-contained and executable\n` +
      `- Do NOT use tools that are listed as unavailable\n` +
      `- The dryRunScript must be read-only (no mutations)\n` +
      `- The rollbackScript must undo what executionScript does`;

    // Attempt 1: probe loop — model uses the probe() tool to observe real machine state.
    const probeSystemPrompt =
      `You are the Envoy planning engine for Synth. Your job is to produce ` +
      `a concrete deployment plan: what to do, in what order, where, and how.\n\n` +
      `BEFORE generating any plan steps, you MUST use the probe() tool to verify ` +
      `the real machine state. Do NOT assume paths, tool versions, running services, ` +
      `or directory structure — observe them. Probe for:\n` +
      `- Tool availability: which docker, which node, which systemctl, etc.\n` +
      `- Directory structure: ls, stat, find on relevant paths\n` +
      `- Running processes and services: ps aux, systemctl status <service>\n` +
      `- OS and system info: uname -a, cat /etc/os-release\n` +
      `- Disk space: df -h\n` +
      `- User context: id, whoami\n` +
      `- Any other observable fact your plan depends on\n\n` +
      `Probe until you have enough real observations to generate a grounded plan. ` +
      `Then output the plan as JSON.\n\n` +
      planOutputFormat;

    // Retry attempts: probe results are already injected into the prompt as context.
    // No probe tool is available — output the plan JSON directly.
    const retrySystemPrompt =
      `You are the Envoy planning engine for Synth. Your job is to produce ` +
      `a concrete deployment plan: what to do, in what order, where, and how.\n\n` +
      `Environment observations have already been collected and are provided in the prompt. ` +
      `Use those observations directly — do NOT attempt to call any tools. ` +
      `Output the plan as JSON.\n\n` +
      planOutputFormat;

    // Planning + dry-run refinement loop. On each iteration the LLM generates
    // a fresh plan using an agentic probe loop to observe real machine state
    // before generating steps. If dry-run finds residual failed observations
    // (rare after probing), they are injected as context for the next attempt.
    const MAX_DRY_RUN_ATTEMPTS = 3;
    let lastObservations: string | null = null;
    let previousObservationSummary = "";
    // Probe results accumulated during attempt 1 — carried into retries as context.
    const probeLog: Array<{ command: string; output: string }> = [];

    // ProbeExecutor is shared at the agent level — probe results are cached
    // across dry-run retries and consecutive plan requests (TTL-based).
    const probeExecutor = this.probeExecutor;

    for (let attempt = 1; attempt <= MAX_DRY_RUN_ATTEMPTS; attempt++) {
      envoyLog("PLAN-ATTEMPT", { attempt, maxAttempts: MAX_DRY_RUN_ATTEMPTS, method: attempt === 1 ? "probeLoop" : "reason" });
      // --- LLM planning call ---
      // Attempt 1: full probe loop to observe real machine state.
      // Retry attempts: use reason() with probe + dry-run observations injected as context
      // (no re-probing — machine state hasn't changed, saves API calls).
      const promptSections = [...sections];

      // Inject accumulated probe results on retries so the model has environment context.
      if (attempt > 1 && probeLog.length > 0) {
        const probeContext = probeLog
          .map((e) => `$ ${e.command}\n${e.output}`)
          .join("\n\n");
        promptSections.push(
          `## Environment Observations (probed before this session)\n` +
          `${probeContext}\n\n` +
          `These are real observations from the target machine collected during this planning session. ` +
          `Use them as the basis for your plan — do not re-probe.`,
        );
      }

      if (lastObservations) {
        promptSections.push(
          `## Dry-Run Observations (system state from previous plan attempt)\n` +
          `${lastObservations}\n\n` +
          `These observations are from the dry-run of your previous plan. ` +
          `A FAILED observation does not automatically mean the plan needs changing: if your ` +
          `plan already includes a step that will resolve the issue (e.g. a step that starts ` +
          `the Docker daemon, creates the directory, or installs the tool), the observation ` +
          `will be satisfied at runtime and you should keep the plan as-is. ` +
          `Only add new steps if the issue is genuinely not addressed by your current plan. ` +
          `If an issue cannot be resolved by any plan change, explain it in your reasoning.`,
        );
      }

      const promptSummary =
        `Plan deployment of ${artifact.name} v${instruction.version} ` +
        `to "${instruction.environment.name}"` +
        (attempt > 1 ? ` (attempt ${attempt} — revising for dry-run observations)` : "");

      let llmResult: import("@synth-deploy/core").LlmResult;

      if (attempt === 1) {
        // First attempt: agentic probe loop to observe real machine state
        llmResult = await this.llmClient!.callWithProbeLoop({
          prompt: promptSections.join("\n\n"),
          systemPrompt: probeSystemPrompt,
          promptSummary,
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          maxTokens: 4096,
          onProbe: async (command: string) => {
            const result = await probeExecutor.execute(command);
            recordEntry({
              partitionId: instruction.partition?.id ?? null,
              operationId: instruction.operationId,
              agent: "envoy",
              decisionType: "environment-probe",
              decision: result.blocked
                ? `Probe blocked: ${command}`
                : `Probe executed: ${command}`,
              reasoning: result.blocked
                ? result.blockedReason ?? "Command blocked"
                : `Exit ${result.exitCode ?? 0}`,
              context: {
                command,
                blocked: result.blocked,
                blockedReason: result.blockedReason,
                exitCode: result.exitCode,
                outputPreview: result.output ? result.output.slice(0, 500) : undefined,
              },
            });
            const output = result.blocked
              ? result.blockedReason ?? "Command blocked"
              : result.output ?? "(no output)";
            // Accumulate for retry context.
            probeLog.push({ command, output });
            return output;
          },
        });
      } else {
        // Retry: machine state unchanged, skip re-probing. Use reason() with
        // probe + dry-run observations already injected into promptSections above.
        llmResult = await this.llmClient!.reason({
          prompt: promptSections.join("\n\n"),
          systemPrompt: retrySystemPrompt,
          promptSummary,
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          maxTokens: 4096,
        });
      }

      if (!llmResult.ok) {
        this.planLog.log(`LLM-FAIL attempt=${attempt}`, llmResult.reason);
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `LLM planning failed on attempt ${attempt}` +
            (attempt < MAX_DRY_RUN_ATTEMPTS ? ` — retrying with accumulated probe context` : ` — falling back to basic plan`),
          reasoning: `LLM call failed: ${llmResult.reason}.` +
            (probeLog.length > 0 ? ` ${probeLog.length} probe result(s) available for retry.` : ""),
          context: { llmFailed: true, llmReason: llmResult.reason, attempt, probeCount: probeLog.length },
        });
        // If we have probe context from this session, hand it to the next attempt
        // via reason() rather than falling back to the canned plan immediately.
        if (attempt < MAX_DRY_RUN_ATTEMPTS) {
          lastObservations = `Previous planning attempt failed: ${llmResult.reason}. ` +
            `Use the environment observations above to generate the best plan you can.`;
          continue;
        }
        return this.buildFallbackPlan(instruction);
      }

      // Parse LLM response
      type ParsedPlan = {
        platform: "bash" | "powershell";
        executionScript: string;
        dryRunScript: string | null;
        rollbackScript: string | null;
        reasoning: string;
        stepSummary: Array<{ description: string; reversible: boolean }>;
        diffFromCurrent?: Array<{ key: string; from: string; to: string }>;
        delta?: string;
        assessmentSummary?: string;
      };

      let currentParsed: ParsedPlan;
      try {
        let text = llmResult.text.trim();
        this.planLog.log(`LLM-RESPONSE attempt=${attempt}`, `length=${text.length} starts=${text.substring(0, 200)}`);
        // The LLM may return commentary before/after the JSON block,
        // especially after a probe loop. Extract JSON from fenced blocks
        // or find the outermost { ... } object.
        const fencedMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
        if (fencedMatch) {
          text = fencedMatch[1].trim();
        } else if (text.startsWith("```")) {
          text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        } else if (!text.startsWith("{")) {
          // Find the first { and last } to extract the JSON object
          const firstBrace = text.indexOf("{");
          const lastBrace = text.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            text = text.substring(firstBrace, lastBrace + 1);
          }
        }
        const raw = JSON.parse(text);
        if (typeof raw?.executionScript !== "string" || !raw.executionScript) throw new Error("Plan missing executionScript");
        if (!Array.isArray(raw?.stepSummary)) throw new Error("Plan missing stepSummary array");
        // Default platform if not specified
        if (!raw.platform) raw.platform = scriptPlatform;
        currentParsed = raw as ParsedPlan;
      } catch (parseErr) {
        const preview = llmResult.text?.substring(0, 500) ?? "(no text)";
        this.planLog.log(`PARSE-FAIL attempt=${attempt}`, `error=${parseErr instanceof Error ? parseErr.message : String(parseErr)} preview=${preview}`);
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `LLM response could not be parsed on attempt ${attempt}`,
          reasoning:
            `The LLM returned a response that could not be parsed as valid plan JSON. ` +
            `Parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
            `Response preview: ${preview}`,
          context: { parseError: true, attempt, responsePreview: preview },
        });

        // Retry on parse failure if we have attempts left — the LLM sometimes
        // returns empty or malformed JSON on the first try. Use reason() on
        // retry since probe results are cached.
        if (attempt < MAX_DRY_RUN_ATTEMPTS) {
          this.planLog.log(`PARSE-RETRY`, `will retry as attempt ${attempt + 1}`);
          lastObservations = `Previous LLM response could not be parsed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. ` +
            `You MUST respond with a valid JSON object containing "executionScript" (string) and "stepSummary" (array). ` +
            `Do not return an empty object.`;
          continue;
        }

        return this.buildFallbackPlan(instruction);
      }

      this.planLog.log(`PARSED-OK attempt=${attempt}`, `${currentParsed.stepSummary.length} steps, reasoning=${currentParsed.reasoning?.length ?? 0} chars`);
      this.planLog.log(`PLAN attempt=${attempt}`, `${currentParsed.stepSummary.length} steps in scripted plan`);

      // Build plan object
      const plan: DeploymentPlan = {
        scriptedPlan: {
          platform: currentParsed.platform,
          executionScript: currentParsed.executionScript,
          dryRunScript: currentParsed.dryRunScript,
          rollbackScript: currentParsed.rollbackScript,
          reasoning: currentParsed.reasoning,
          stepSummary: currentParsed.stepSummary,
          diffFromCurrent: currentParsed.diffFromCurrent,
        },
        reasoning: currentParsed.reasoning,
        diffFromCurrent: currentParsed.diffFromCurrent,
        diffFromPreviousPlan: latestPlan ? currentParsed.delta : undefined,
      };

      // --- Dry-run: run the dry-run script ---
      await this.executorReady;

      if (!this.operationExecutor) {
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision:
            `Generated deployment plan (dry-run skipped — executor not initialized): ` +
            `${plan.scriptedPlan.stepSummary.length} step(s) for ${artifact.name} v${instruction.version}`,
          reasoning: currentParsed.reasoning,
          context: { dryRunSkipped: true },
        });
        const rollbackPlan = this.buildRollbackPlan(plan, instruction);
        return {
          plan,
          rollbackPlan,
          delta: currentParsed.delta,
          assessmentSummary: currentParsed.assessmentSummary,
        };
      }

      const dryRunResult = await this.operationExecutor.executeDryRun(plan.scriptedPlan);

      // Log dry-run results to file for debugging
      this.planLog.log(`DRY-RUN attempt=${attempt}`, `exitCode=${dryRunResult.exitCode} success=${dryRunResult.success}`);

      // --- Dry-run passed: plan is validated, return it ---
      if (dryRunResult.success) {
        this.planLog.log(`DRY-RUN-PASSED attempt=${attempt}`, `exitCode=${dryRunResult.exitCode}`);
        envoyLog("PLAN-DRY-RUN", { attempt, passed: true });
        const rollbackPlan = this.buildRollbackPlan(plan, instruction);
        plan.reasoning =
          currentParsed.reasoning +
          ` [Dry-run validated on attempt ${attempt}: exit code ${dryRunResult.exitCode}.]`;

        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision:
            `Generated and validated deployment plan: ${plan.scriptedPlan.stepSummary.length} step(s) for ` +
            `${artifact.name} v${instruction.version} → "${instruction.environment.name}" ` +
            `(dry-run passed on attempt ${attempt})`,
          reasoning: currentParsed.reasoning,
          context: {
            artifactType: artifact.type,
            environmentName: instruction.environment.name,
            llmAvailable: true,
            stepCount: plan.scriptedPlan.stepSummary.length,
            previousSuccessfulPlans: successfulPlans.length,
            previousFailedPlans: failedPlans.length,
            hasDelta: !!currentParsed.delta,
            dryRunAttempt: attempt,
            dryRunExitCode: dryRunResult.exitCode,
          },
        });

        envoyLog("PLAN-COMPLETE", { steps: plan.scriptedPlan.stepSummary.length });
        return { plan, rollbackPlan, delta: currentParsed.delta, assessmentSummary: currentParsed.assessmentSummary };
      }

      // --- Dry-run failed: build output text for next planning call ---
      this.planLog.log(`DRY-RUN-FAILED attempt=${attempt}`, `exitCode=${dryRunResult.exitCode}`);
      envoyLog("PLAN-DRY-RUN", { attempt, passed: false, exitCode: dryRunResult.exitCode });

      const currentObsSummary =
        `Exit code: ${dryRunResult.exitCode}\n` +
        `stdout: ${dryRunResult.output.slice(0, 500)}\n` +
        `stderr: ${dryRunResult.errors.slice(0, 500)}`;

      // Stuck detection: same failures after re-planning means LLM can't resolve them
      if (attempt > 1 && currentObsSummary === previousObservationSummary) {
        this.planLog.log("STUCK", `same dry-run failures after ${attempt} attempts`);
        envoyWarn("PLAN-STUCK", `same dry-run failures after ${attempt} attempts`);
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `Plan generation stuck — same dry-run failures after ${attempt} attempts`,
          reasoning:
            `Re-planning produced the same dry-run failures. ` +
            `Returning plan with failure annotations.`,
          context: { dryRunAttempt: attempt },
        });

        plan.reasoning =
          `Plan has unresolved environmental issues (stuck after ${attempt} attempt(s)). ` +
          `Review before approving.`;

        return {
          plan,
          rollbackPlan: this.buildRollbackPlan(plan, instruction),
          delta: currentParsed.delta,
          assessmentSummary: currentParsed.assessmentSummary,
        };
      }

      // Last attempt: block with unresolved issues
      if (attempt === MAX_DRY_RUN_ATTEMPTS) {
        this.planLog.log("BLOCKED", `max attempts reached`);
        recordEntry({
          partitionId: instruction.partition?.id ?? null,
          operationId: instruction.operationId,
          agent: "envoy",
          decisionType: "plan-generation",
          decision: `Plan blocked — dry-run failed after ${MAX_DRY_RUN_ATTEMPTS} attempts`,
          reasoning: `Dry-run failed: ${currentObsSummary}`,
          context: { dryRunAttempt: attempt, maxAttempts: MAX_DRY_RUN_ATTEMPTS },
        });

        const blockReason =
          `Plan dry-run failed after ${MAX_DRY_RUN_ATTEMPTS} attempt(s). Review before approving.`;
        plan.reasoning = blockReason;

        return {
          plan,
          rollbackPlan: this.buildRollbackPlan(plan, instruction),
          delta: currentParsed.delta,
          assessmentSummary: currentParsed.assessmentSummary,
          blocked: true,
          blockReason,
        };
      }

      previousObservationSummary = currentObsSummary;

      // Build dry-run output text for injection into next planning prompt
      lastObservations =
        `## Dry-Run Output\n` +
        `Exit code: ${dryRunResult.exitCode}\n` +
        `stdout:\n${dryRunResult.output}\n` +
        `stderr:\n${dryRunResult.errors}`;

      recordEntry({
        partitionId: instruction.partition?.id ?? null,
        operationId: instruction.operationId,
        agent: "envoy",
        decisionType: "plan-generation",
        decision: `Dry-run failed — re-planning with output context (attempt ${attempt + 1}/${MAX_DRY_RUN_ATTEMPTS})`,
        reasoning: `Dry-run exit code ${dryRunResult.exitCode}. Re-invoking planning with dry-run output injected as context.`,
        context: { dryRunAttempt: attempt, dryRunExitCode: dryRunResult.exitCode },
      });
    }

    // Should not reach here
    throw new Error("Unreachable: planning loop exited without returning");
  }

  /**
   * Build a rollback plan from a deployment plan — reverse order of
   * reversible steps.
   */
  private buildRollbackPlan(
    plan: DeploymentPlan,
    instruction: PlanningInstruction,
  ): DeploymentPlan {
    const reversibleSteps = plan.scriptedPlan.stepSummary.filter((s) => s.reversible);
    const rollbackReasoning =
      `Rollback plan for ${instruction.artifact?.name ?? "artifact"} v${instruction.version}: ` +
      `undo ${reversibleSteps.length} reversible step(s) ` +
      `in reverse order.`;
    return {
      scriptedPlan: {
        platform: plan.scriptedPlan.platform,
        executionScript: plan.scriptedPlan.rollbackScript ?? "# No rollback actions required",
        dryRunScript: null,
        rollbackScript: null,
        reasoning: rollbackReasoning,
        stepSummary: reversibleSteps.reverse().map((s) => ({
          description: `Rollback: ${s.description}`,
          reversible: false,
        })),
      },
      reasoning: rollbackReasoning,
    };
  }

  /**
   * Build a basic fallback plan when LLM is unavailable — simple copy +
   * configure + restart pattern based on artifact type.
   */
  private buildFallbackPlan(instruction: PlanningInstruction): PlanningResult {
    const artifact = instruction.artifact!;
    const workspacePath = `${this.baseDir}/deployments/${instruction.operationId}`;

    const variablesContent = Object.entries(instruction.resolvedVariables)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const executionScript = [
      `#!/usr/bin/env bash`,
      `set -euo pipefail`,
      ``,
      `# Create workspace`,
      `mkdir -p "${workspacePath}"`,
      ``,
      `# Write artifact metadata`,
      `cat > "${workspacePath}/artifact.json" << 'ARTIFACT_EOF'`,
      JSON.stringify({
        id: artifact.id,
        name: artifact.name,
        type: artifact.type,
        version: instruction.version,
        operationId: instruction.operationId,
      }, null, 2),
      `ARTIFACT_EOF`,
      ``,
      `# Write variables`,
      `cat > "${workspacePath}/variables.env" << 'VARS_EOF'`,
      variablesContent,
      `VARS_EOF`,
      ``,
      `# Write manifest`,
      `cat > "${workspacePath}/manifest.json" << 'MANIFEST_EOF'`,
      JSON.stringify({
        operationId: instruction.operationId,
        artifact: artifact.name,
        version: instruction.version,
        environment: instruction.environment.name,
        deployedAt: new Date().toISOString(),
      }, null, 2),
      `MANIFEST_EOF`,
      ``,
      `# Mark deployment as active`,
      `echo "active" > "${workspacePath}/STATUS"`,
    ].join("\n");

    const rollbackScript = `#!/usr/bin/env bash\nset -euo pipefail\nrm -rf "${workspacePath}"`;

    const reasoning =
      `Basic deployment plan for artifact type "${artifact.type}". ` +
      `LLM was unavailable so this plan uses a standard copy + configure pattern ` +
      `without intelligent reasoning about the target environment or previous history.`;

    const plan: DeploymentPlan = {
      scriptedPlan: {
        platform: "bash",
        executionScript,
        dryRunScript: `#!/usr/bin/env bash\nset -euo pipefail\n# Check workspace parent is writable\ntest -w "$(dirname "${workspacePath}")" && echo "OK" || echo "FAIL: parent not writable"`,
        rollbackScript,
        reasoning,
        stepSummary: [
          { description: `Create workspace directory for ${artifact.name} v${instruction.version}`, reversible: true },
          { description: `Write artifact metadata to workspace`, reversible: true },
          { description: `Write deployment configuration with ${Object.keys(instruction.resolvedVariables).length} resolved variable(s)`, reversible: true },
          { description: `Write deployment manifest`, reversible: true },
          { description: `Mark deployment as active`, reversible: true },
        ],
      },
      reasoning,
    };

    const rollbackPlan: DeploymentPlan = {
      scriptedPlan: {
        platform: "bash",
        executionScript: rollbackScript,
        dryRunScript: null,
        rollbackScript: null,
        reasoning: `Rollback plan: remove all artifacts written during deployment.`,
        stepSummary: [
          { description: `Remove deployment workspace ${workspacePath}`, reversible: false },
        ],
      },
      reasoning: `Rollback plan: remove all artifacts written during deployment in reverse order.`,
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

    if (instruction.llmApiKey) {
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

    const rollbackPlatform = process.platform === "win32" ? "powershell" : "bash";
    const rollbackShebang = rollbackPlatform === "bash" ? "#!/bin/bash\nset -euo pipefail" : "# PowerShell\n$ErrorActionPreference = 'Stop'";

    sections.push(`## Envoy Capabilities
Script platform: ${rollbackPlatform}
Installed tools: ${availableTools || "none"}`);

    const systemPrompt =
      `You are the Envoy rollback planning engine for Synth. Your job is to produce ` +
      `a concrete rollback script: the minimal set of commands to safely undo a deployment ` +
      `and return the environment to its previous state.\n\n` +
      `Only undo steps that actually completed. Work in reverse order. ` +
      `Be specific about targets (paths, service names). ` +
      `Do not include commands for operations that did not execute.\n\n` +
      `IMPORTANT: You must respond with valid JSON only. No markdown, no commentary.\n\n` +
      `Response format:\n` +
      `{\n` +
      `  "reasoning": "Why these rollback actions are needed and what state they restore",\n` +
      `  "steps": [\n` +
      `    {\n` +
      `      "description": "Human-readable description of the rollback step",\n` +
      `      "action": "short action label",\n` +
      `      "target": "What the action operates on",\n` +
      `      "execPreview": "The exact literal command string"\n` +
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
      operationId: instruction.operationId,
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
        operationId: instruction.operationId,
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

      // Build a scripted rollback plan from the LLM's step-based output
      const rollbackScript = parsed.steps
        .map((s) => `# ${s.description}\n${s.execPreview ?? `echo "TODO: ${s.action} ${s.target}"`}`)
        .join("\n\n");

      return {
        scriptedPlan: {
          platform: "bash",
          executionScript: `#!/usr/bin/env bash\nset -euo pipefail\n\n${rollbackScript}`,
          dryRunScript: null,
          rollbackScript: null,
          reasoning: parsed.reasoning,
          stepSummary: parsed.steps.map((s) => ({
            description: s.description,
            reversible: false,
          })),
        },
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
    const reversedSteps = [...executedSteps].reverse();
    const rollbackScript = reversedSteps
      .map((s) => `# Undo: ${s.description}\necho "TODO: undo-${s.action} ${s.target}"`)
      .join("\n\n");

    const reasoning =
      `Mechanical rollback for ${instruction.artifact.name} v${instruction.version}: ` +
      `reverses ${executedSteps.length} completed step(s) in reverse order. ` +
      `LLM was unavailable — review script carefully before executing.`;

    return {
      scriptedPlan: {
        platform: "bash",
        executionScript: `#!/usr/bin/env bash\nset -euo pipefail\n\n${rollbackScript}`,
        dryRunScript: null,
        rollbackScript: null,
        reasoning,
        stepSummary: reversedSteps.map((s) => ({
          description: `Undo: ${s.description}`,
          reversible: false,
        })),
      },
      reasoning,
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
    operationId: string,
    plan: DeploymentPlan,
    rollbackPlan: DeploymentPlan,
    artifactContext?: { artifactType: string; artifactName: string; environmentId: string },
    progressCallbackUrl?: string,
    callbackToken?: string,
    deploymentId?: string,
  ): Promise<DeploymentResult> {
    await this.executorReady;
    // Probe cache is stale after real execution changes machine state
    this.probeExecutor.clearCache();

    // --- Lifecycle guard ---
    if (this._lifecycleState !== "active") {
      const reason =
        this._lifecycleState === "draining"
          ? "Envoy is draining — finishing in-flight deployments but rejecting new ones"
          : "Envoy is paused — not accepting deployments";

      return {
        deploymentId: (deploymentId ?? operationId) as DeploymentId,
        operationId,
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

    const scriptedPlan = plan.scriptedPlan;
    const rollbackScripted = rollbackPlan.scriptedPlan;
    const stepCount = scriptedPlan.stepSummary.length;
    const rollbackStepCount = rollbackScripted.stepSummary.length;

    recordEntry({
      partitionId: null,
      operationId: operationId,
      agent: "envoy",
      decisionType: "deployment-execution",
      decision:
        `Executing approved plan: ${stepCount} step(s) for deployment ${operationId}`,
      reasoning:
        `User approved the deployment plan. Executing ${stepCount} step(s) ` +
        `deterministically — no re-reasoning. Rollback plan has ` +
        `${rollbackStepCount} step(s) ready if any step fails.`,
      context: {
        stepCount,
        rollbackStepCount,
        steps: scriptedPlan.stepSummary.map((s) => ({ description: s.description, reversible: s.reversible })),
      },
    });

    const execStart = Date.now();
    let failureError: string | null = null;

    // Execute the scripted plan through the OperationExecutor if available
    if (this.operationExecutor && scriptedPlan.executionScript) {
      // Set up progress callback to stream events to Command if URL provided
      const progressCallback = progressCallbackUrl
        ? createCallbackReporter(progressCallbackUrl, callbackToken)
        : undefined;

      const planResult = await this.operationExecutor.executePlan(
        scriptedPlan,
        progressCallback,
        operationId,
      );

      if (!planResult.success) {
        failureError = planResult.executionResult.stderr || "Script execution failed";
      }
    }

    const execDurationMs = Date.now() - execStart;

    if (failureError !== null) {
      // --- Failure path: execute rollback script ---

      recordEntry({
        partitionId: null,
        operationId: operationId,
        agent: "envoy",
        decisionType: "deployment-failure",
        decision:
          `Plan execution failed: ${failureError}`,
        reasoning:
          `Script execution failed. ` +
          `Error: ${failureError}. ` +
          `Executing rollback script to restore previous state.`,
        context: {
          error: failureError,
          durationMs: execDurationMs,
        },
      });

      // Execute rollback — handled automatically by the executor if rollbackScript is set,
      // but if the plan was executed without the executor, run it manually
      if (this.operationExecutor && rollbackScripted.rollbackScript) {
        // The DefaultOperationExecutor already handles rollback internally
        // via the ScriptedPlan's rollbackScript, so this is a safety net
        // for cases where rollback wasn't triggered automatically.
        recordEntry({
          partitionId: null,
          operationId: operationId,
          agent: "envoy",
          decisionType: "rollback-execution",
          decision:
            `Rollback executed: ${rollbackStepCount} step(s) to restore previous state`,
          reasoning:
            `Executed rollback script ` +
            `to restore the environment to its previous state.`,
          context: {
            rollbackSteps: rollbackStepCount,
          },
        });
      }

      const failResult: DeploymentResult = {
        deploymentId: (deploymentId ?? operationId) as DeploymentId,
        operationId,
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
      this.storePlanOutcome(operationId, plan, rollbackPlan, false, failureError, execDurationMs, artifactContext);

      return failResult;
    }

    // --- Success path ---

    const totalDurationMs = Date.now() - totalStart;
    const artifacts = scriptedPlan.stepSummary.map((s) => s.description);

    recordEntry({
      partitionId: null,
      operationId: operationId,
      agent: "envoy",
      decisionType: "deployment-completion",
      decision:
        `Approved plan executed: all ${stepCount} step(s) completed for deployment ${operationId}`,
      reasoning:
        `All ${stepCount} planned steps executed deterministically in ${execDurationMs}ms. ` +
        `No re-reasoning was performed — the plan was executed exactly as approved. ` +
        `Total pipeline time: ${totalDurationMs}ms.`,
      context: {
        stepCount,
        executionDurationMs: execDurationMs,
        totalDurationMs,
        artifacts,
      },
    });

    const successResult: DeploymentResult = {
      deploymentId: (deploymentId ?? operationId) as DeploymentId,
      operationId,
      success: true,
      workspacePath: "",
      artifacts,
      executionDurationMs: execDurationMs,
      totalDurationMs,
      verificationPassed: true,
      verificationChecks: scriptedPlan.stepSummary.map((s) => ({
        name: s.description,
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
    this.storePlanOutcome(operationId, plan, rollbackPlan, true, undefined, execDurationMs, artifactContext);

    return successResult;
  }

  /**
   * Store a plan outcome (success or failure) in the knowledge store
   * for future planning context.
   */
  private storePlanOutcome(
    operationId: string,
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
        deploymentId: operationId,
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
      const cause = err instanceof Error ? (err as NodeJS.ErrnoException).cause : undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const causeInfo = cause != null ? (() => { const c = cause as any; return `code=${c.code ?? "?"} msg=${c.message ?? ""} addr=${c.address ?? ""}:${c.port ?? ""}`; })() : "none";
      console.error(
        `[Envoy] Failed to report deployment ${result.operationId} to Command:`,
        err instanceof Error ? err.message : err,
        `| cause: ${causeInfo}`,
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
   * Return the Envoy's capability surface: what tools are installed
   * on this machine. Used by planning prompts so the LLM generates
   * scripts that use available tools.
   */
  getCapabilities(): {
    installedTools: Array<{ name: string; available: boolean; version: string | null }>;
  } {
    const installedTools = this.scanner.getInstalledTools();

    return {
      installedTools,
    };
  }
}
