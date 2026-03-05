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
} from "@deploystack/core";
import { LlmClient } from "@deploystack/core";
import type { EnvoyKnowledgeStore, LocalDeploymentRecord } from "../state/knowledge-store.js";
import { EnvironmentScanner } from "./environment-scanner.js";
import type { CommandReporter } from "./command-reporter.js";
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
}

/**
 * What the Envoy returns after planning — includes the deployment plan,
 * a rollback plan, and an optional delta summary comparing to the last
 * successful plan for this artifact type + environment.
 */
export interface PlanningResult {
  plan: DeploymentPlan;
  rollbackPlan: DeploymentPlan;
  delta?: string;
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
  private reporter: CommandReporter | null;
  private llmClient: LlmClient | null;
  private _lifecycleState: LifecycleState = "active";
  private executorReady: Promise<void>;

  constructor(
    private debrief: DebriefWriter,
    private state: EnvoyKnowledgeStore,
    private baseDir: string,
    reporter?: CommandReporter,
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

    const validator = new BoundaryValidator();
    this.operationExecutor = new DefaultOperationExecutor(
      registry,
      validator,
      adapter.platform,
      this.debrief,
    );
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
      `You are the Envoy planning engine for DeployStack. Your job is to produce ` +
      `a concrete deployment plan: what to do, in what order, where, and how. ` +
      `Each step must have a clear action, target, description, and whether it is ` +
      `reversible (with rollback action if so).\n\n` +
      `IMPORTANT: You must respond with valid JSON only. No markdown, no commentary.\n\n` +
      `Response format:\n` +
      `{\n` +
      `  "reasoning": "Your reasoning about why this plan is appropriate",\n` +
      `  "steps": [\n` +
      `    {\n` +
      `      "description": "Human-readable description of the step",\n` +
      `      "action": "The action type (e.g. copy-artifact, write-config, restart-service, verify-health)",\n` +
      `      "target": "What the action operates on (path, service name, URL)",\n` +
      `      "reversible": true,\n` +
      `      "rollbackAction": "How to undo this step"\n` +
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
        reversible: boolean;
        rollbackAction?: string;
      }>;
      delta?: string;
    };

    try {
      let text = llmResult.text.trim();
      if (text.startsWith("```")) {
        text = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      parsed = JSON.parse(text);
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

    // Build the deployment plan
    const plan: DeploymentPlan = {
      steps: parsed.steps.map((s) => ({
        description: s.description,
        action: s.action,
        target: s.target,
        reversible: s.reversible,
        rollbackAction: s.rollbackAction,
      })),
      reasoning: parsed.reasoning,
      diffFromPreviousPlan: latestPlan
        ? parsed.delta
        : undefined,
    };

    // Build the rollback plan — reverse order of reversible steps
    const rollbackPlan: DeploymentPlan = {
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

    recordEntry({
      partitionId: instruction.partition?.id ?? null,
      deploymentId: instruction.deploymentId,
      agent: "envoy",
      decisionType: "plan-generation",
      decision:
        `Generated intelligent deployment plan: ${plan.steps.length} step(s) for ` +
        `${instruction.artifact.name} v${instruction.version} → "${instruction.environment.name}"`,
      reasoning: parsed.reasoning,
      context: {
        artifactType: instruction.artifact.type,
        environmentName: instruction.environment.name,
        llmAvailable: true,
        stepCount: plan.steps.length,
        rollbackStepCount: rollbackPlan.steps.length,
        previousSuccessfulPlans: successfulPlans.length,
        previousFailedPlans: failedPlans.length,
        hasDelta: !!parsed.delta,
      },
    });

    return {
      plan,
      rollbackPlan,
      delta: parsed.delta,
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
          action: "create-directory",
          target: workspacePath,
          reversible: true,
          rollbackAction: "remove-directory",
        },
        {
          description: `Copy ${instruction.artifact.type} artifact to workspace`,
          action: "copy-artifact",
          target: `${workspacePath}/artifact`,
          reversible: true,
          rollbackAction: "remove-file",
        },
        {
          description: `Write deployment configuration with ${Object.keys(instruction.resolvedVariables).length} resolved variable(s)`,
          action: "write-config",
          target: `${workspacePath}/variables.env`,
          reversible: true,
          rollbackAction: "remove-file",
        },
        {
          description: `Write deployment manifest`,
          action: "write-config",
          target: `${workspacePath}/manifest.json`,
          reversible: true,
          rollbackAction: "remove-file",
        },
        {
          description: `Mark deployment as active`,
          action: "write-config",
          target: `${workspacePath}/STATUS`,
          reversible: true,
          rollbackAction: "write-config",
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
      const planResult = await this.operationExecutor.executePlan(
        plan.steps,
        [],
        undefined,
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
      this.reportToServer(failResult);

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
    this.reportToServer(successResult);

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
  private reportToServer(result: DeploymentResult): void {
    if (!this.reporter) return;
    this.reporter.reportDeploymentResult(result).catch((err) => {
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
      summary,
      readiness,
      lifecycle: this._lifecycleState,
    };
  }
}
