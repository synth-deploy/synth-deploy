import type {
  ScriptedPlan,
  DebriefWriter,
} from "@synth-deploy/core";
import { envoyLog, envoyError } from "../logger.js";
import { ScriptRunner } from "./script-runner.js";
import type { ScriptResult, ScriptProgressCallback } from "./script-runner.js";
import type { Platform } from "./platform.js";

// ---------------------------------------------------------------------------
// Types — execution results and progress events
// ---------------------------------------------------------------------------

/**
 * Progress event emitted during plan execution. Consumers use these
 * to update UI, log progress, or stream status to connected clients.
 */
export interface ExecutionProgressEvent {
  deploymentId: string;
  type:
    | "script-started"
    | "script-output"
    | "script-completed"
    | "script-failed"
    | "rollback-started"
    | "rollback-completed"
    | "deployment-completed"
    | "plan-step-started"
    | "plan-step-completed"
    | "plan-step-failed"
    | "step-output";
  phase: "dry-run" | "execution" | "rollback";
  status: "in_progress" | "completed" | "failed";
  output?: string;
  error?: string;
  exitCode?: number;
  timestamp: Date;
  /** 0–100 percentage of overall progress */
  overallProgress: number;
  /** 0-based index of the plan step (for plan-step-* and step-output events) */
  stepIndex?: number;
  /** Human-readable step description (for plan-step-started events) */
  stepDescription?: string;
  /** Total number of plan steps (for plan-step-* events) */
  totalSteps?: number;
}

/**
 * Callback for progress events during execution.
 */
export type ProgressCallback = (event: ExecutionProgressEvent) => void;

/**
 * Full result of executing a scripted plan.
 */
export interface PlanExecutionResult {
  success: boolean;
  /** Result of the execution script */
  executionResult: ScriptResult;
  /** Result of the rollback script (if rollback was triggered) */
  rollbackResult?: ScriptResult;
  totalDurationMs: number;
}

/**
 * Result of running a dry-run script.
 */
export interface DryRunPlanResult {
  /** stdout from the dry-run script */
  output: string;
  /** stderr from the dry-run script */
  errors: string;
  /** Whether the dry-run script exited cleanly */
  success: boolean;
  /** Exit code */
  exitCode: number;
  /** Execution duration */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// DefaultOperationExecutor — orchestrates scripted plan execution
// ---------------------------------------------------------------------------

/**
 * The operation executor is the deterministic engine that runs approved
 * scripted plans. It does NOT reason — that happened during planning.
 * It executes the approved script verbatim, captures output, and
 * handles failures with automatic rollback.
 *
 * Contract:
 * 1. The approved script runs exactly as written — no re-reasoning
 * 2. stdout/stderr captured in real-time for progress and debrief
 * 3. Exit code determines success/failure
 * 4. On failure, the rollback script runs automatically (if one exists)
 * 5. Debrief records all scripts, output, timing, and outcomes
 */
export class DefaultOperationExecutor {
  private scriptRunner: ScriptRunner;

  constructor(
    private platform: Platform,
    private debrief?: DebriefWriter,
    timeoutMs?: number,
  ) {
    this.scriptRunner = new ScriptRunner(platform, timeoutMs);
  }

  /**
   * Run a dry-run script and return the results for LLM feedback.
   * This is read-only — the dry-run script should only probe system state.
   */
  async executeDryRun(plan: ScriptedPlan): Promise<DryRunPlanResult> {
    if (!plan.dryRunScript) {
      return {
        output: "No dry-run script for this operation type.",
        errors: "",
        success: true,
        exitCode: 0,
        durationMs: 0,
      };
    }

    const result = await this.scriptRunner.executeDryRun(
      plan.dryRunScript,
      plan.platform,
    );

    return {
      output: result.stdout,
      errors: result.stderr,
      success: result.success,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    };
  }

  /**
   * Execute an approved scripted plan. Runs the execution script verbatim
   * and triggers rollback on failure.
   */
  async executePlan(
    plan: ScriptedPlan,
    onProgress?: ProgressCallback,
    operationId?: string,
  ): Promise<PlanExecutionResult> {
    const opId = operationId ?? "unknown";
    const planStart = Date.now();

    envoyLog("Executing scripted plan", {
      platform: plan.platform,
      hasRollback: !!plan.rollbackScript,
      stepCount: plan.stepSummary.length,
    });

    // Bridge progress events
    const progressBridge: ScriptProgressCallback | undefined = onProgress
      ? (event) => {
          onProgress({
            deploymentId: opId,
            type: event.type as ExecutionProgressEvent["type"],
            phase: event.phase,
            status: event.type.includes("failed") ? "failed"
              : event.type.includes("completed") ? "completed"
              : "in_progress",
            output: event.output,
            error: event.error,
            exitCode: event.exitCode,
            timestamp: event.timestamp,
            overallProgress: event.overallProgress,
            stepIndex: event.stepIndex,
            stepDescription: event.stepDescription,
            totalSteps: event.totalSteps,
          });
        }
      : undefined;

    const result = await this.scriptRunner.executePlan(plan, opId, progressBridge);

    // Record to debrief
    this.recordDebrief(plan, result.executionResult, result.rollbackResult, opId);

    return {
      success: result.success,
      executionResult: result.executionResult,
      rollbackResult: result.rollbackResult,
      totalDurationMs: Date.now() - planStart,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: debrief recording
  // -------------------------------------------------------------------------

  private recordDebrief(
    plan: ScriptedPlan,
    executionResult: ScriptResult,
    rollbackResult: ScriptResult | undefined,
    operationId: string,
  ): void {
    if (!this.debrief) return;

    // Record execution result
    this.debrief.record({
      partitionId: null,
      operationId,
      agent: "envoy",
      decisionType: "deployment-execution",
      decision: executionResult.success
        ? `Script execution succeeded (exit code 0) in ${executionResult.durationMs}ms`
        : `Script execution failed (exit code ${executionResult.exitCode}) in ${executionResult.durationMs}ms${executionResult.timedOut ? " — timed out" : ""}`,
      reasoning: plan.reasoning,
      context: {
        platform: plan.platform,
        exitCode: executionResult.exitCode,
        success: executionResult.success,
        timedOut: executionResult.timedOut,
        durationMs: executionResult.durationMs,
        stdout: executionResult.stdout.slice(0, 2000),
        stderr: executionResult.stderr.slice(0, 2000),
        executionScript: plan.executionScript,
        dryRunScript: plan.dryRunScript,
        rollbackScript: plan.rollbackScript,
        stepSummary: plan.stepSummary,
      },
    });

    // Record rollback result if one occurred
    if (rollbackResult) {
      this.debrief.record({
        partitionId: null,
        operationId,
        agent: "envoy",
        decisionType: "rollback-execution",
        decision: rollbackResult.success
          ? `Rollback script succeeded (exit code 0) in ${rollbackResult.durationMs}ms`
          : `Rollback script failed (exit code ${rollbackResult.exitCode}) in ${rollbackResult.durationMs}ms. ` +
            `System may be in a partially-rolled-back state. Manual intervention may be required.`,
        reasoning: `Automatic rollback triggered after execution failure. ` +
          `Rollback script ${rollbackResult.success ? "restored" : "failed to restore"} the previous state.`,
        context: {
          exitCode: rollbackResult.exitCode,
          success: rollbackResult.success,
          stdout: rollbackResult.stdout.slice(0, 2000),
          stderr: rollbackResult.stderr.slice(0, 2000),
          rollbackScript: plan.rollbackScript,
        },
      });
    }
  }
}
