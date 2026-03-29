import type {
  ScriptedPlan,
  DebriefWriter,
} from "@synth-deploy/core";
import { envoyLog, envoyError } from "../logger.js";
import { ScriptRunner } from "./script-runner.js";
import type { ScriptResult, StepResult, DryRunStepResult, ScriptProgressCallback } from "./script-runner.js";
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
    | "plan-step-started"
    | "plan-step-completed"
    | "plan-step-failed"
    | "step-output"
    | "rollback-step-started"
    | "rollback-step-completed"
    | "rollback-step-failed"
    | "rollback-step-skipped"
    | "dry-run-step-started"
    | "dry-run-step-passed"
    | "dry-run-step-failed"
    | "dry-run-step-skipped"
    | "deployment-completed";
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
  /** Synthesized execution result (aggregated from all steps) */
  executionResult: ScriptResult;
  /** Per-step results */
  stepResults: StepResult[];
  /** Rollback step results (if rollback ran) */
  rollbackStepResults?: StepResult[];
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
  /** Per-step dry-run results */
  stepResults: DryRunStepResult[];
}

// ---------------------------------------------------------------------------
// DefaultOperationExecutor — orchestrates scripted plan execution
// ---------------------------------------------------------------------------

/**
 * The operation executor is the deterministic engine that runs approved
 * scripted plans. It does NOT reason — that happened during planning.
 * It executes the approved steps verbatim, captures output, and
 * handles failures with automatic per-step rollback.
 *
 * Contract:
 * 1. The approved steps run exactly as written — no re-reasoning
 * 2. stdout/stderr captured in real-time for progress and debrief
 * 3. Exit code determines success/failure per step
 * 4. On failure, completed steps roll back in reverse order
 * 5. Debrief records all steps, output, timing, and outcomes
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
   * Run per-step dry-run validation and return the results for LLM feedback.
   * This is read-only — dry-run scripts should only probe system state.
   */
  async executeDryRun(plan: ScriptedPlan, onProgress?: ProgressCallback): Promise<DryRunPlanResult> {
    if (plan.steps.length === 0 || plan.steps.every((s) => !s.dryRunScript)) {
      return {
        output: "No dry-run scripts for this operation.",
        errors: "",
        success: true,
        exitCode: 0,
        durationMs: 0,
        stepResults: [],
      };
    }

    const dryRunBridge: ScriptProgressCallback | undefined = onProgress
      ? (event) => {
          const mappedType = event.type as ExecutionProgressEvent["type"];
          onProgress({
            deploymentId: "dry-run",
            type: mappedType,
            phase: event.phase,
            status: event.type.includes("failed") ? "failed"
              : event.type.includes("passed") || event.type.includes("completed") ? "completed"
              : "in_progress",
            output: event.output,
            error: event.error,
            timestamp: event.timestamp,
            overallProgress: event.overallProgress,
            stepIndex: event.stepIndex,
            stepDescription: event.stepDescription,
            totalSteps: event.totalSteps,
          });
        }
      : undefined;
    const stepResults = await this.scriptRunner.executeDryRunPlan(plan, "dry-run", dryRunBridge);

    // Aggregate results
    const failedSteps = stepResults.filter((r) => r.status === "failed");
    const success = failedSteps.length === 0;

    const outputParts: string[] = [];
    const errorParts: string[] = [];
    let totalDurationMs = 0;

    for (const sr of stepResults) {
      if (!sr.result) continue;
      totalDurationMs += sr.result.durationMs;
      if (sr.status === "failed") {
        const prefix = `[Step ${sr.stepIndex + 1}: ${sr.description}] `;
        if (sr.result.stdout) outputParts.push(prefix + sr.result.stdout.slice(0, 500));
        if (sr.result.stderr) errorParts.push(prefix + sr.result.stderr.slice(0, 500));
      }
    }

    return {
      output: outputParts.join("\n"),
      errors: errorParts.join("\n"),
      success,
      exitCode: success ? 0 : 1,
      durationMs: totalDurationMs,
      stepResults,
    };
  }

  /**
   * Execute an approved scripted plan. Runs each step verbatim
   * and triggers per-step rollback on failure.
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
      stepCount: plan.steps.length,
    });

    // Bridge progress events from ScriptRunner to ExecutionProgressEvent
    const progressBridge: ScriptProgressCallback | undefined = onProgress
      ? (event) => {
          // Map "execution-completed" to "deployment-completed" for the external type
          const mappedType = event.type === "execution-completed"
            ? "deployment-completed"
            : event.type as ExecutionProgressEvent["type"];

          onProgress({
            deploymentId: opId,
            type: mappedType,
            phase: event.phase,
            status: event.type.includes("failed") ? "failed"
              : event.type.includes("completed") || event.type === "execution-completed" ? "completed"
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

    // Synthesize a backward-compatible ScriptResult from step results
    const lastFailedStep = result.stepResults.find((s) => !s.result.success);
    const executionResult: ScriptResult = {
      exitCode: lastFailedStep?.result.exitCode ?? 0,
      stdout: result.stepResults.map((s) => s.result.stdout).filter(Boolean).join("\n"),
      stderr: result.stepResults.map((s) => s.result.stderr).filter(Boolean).join("\n"),
      success: result.success,
      durationMs: result.totalDurationMs,
      timedOut: result.stepResults.some((s) => s.result.timedOut),
    };

    // Record to debrief
    this.recordDebrief(plan, result.stepResults, result.rollbackStepResults, opId);

    return {
      success: result.success,
      executionResult,
      stepResults: result.stepResults,
      rollbackStepResults: result.rollbackStepResults,
      totalDurationMs: Date.now() - planStart,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: debrief recording
  // -------------------------------------------------------------------------

  private recordDebrief(
    plan: ScriptedPlan,
    stepResults: StepResult[],
    rollbackStepResults: StepResult[] | undefined,
    operationId: string,
  ): void {
    if (!this.debrief) return;

    const success = stepResults.every((s) => s.result.success);
    const totalDurationMs = stepResults.reduce((sum, s) => sum + s.result.durationMs, 0);
    const lastFailedStep = stepResults.find((s) => !s.result.success);

    // Record execution result
    this.debrief.record({
      partitionId: null,
      operationId,
      agent: "envoy",
      decisionType: "deployment-execution",
      decision: success
        ? `Script execution succeeded (${plan.steps.length} steps completed) in ${totalDurationMs}ms`
        : `Script execution failed at step ${(lastFailedStep?.stepIndex ?? 0) + 1} (exit code ${lastFailedStep?.result.exitCode ?? 1}) in ${totalDurationMs}ms`,
      reasoning: plan.reasoning,
      context: {
        platform: plan.platform,
        stepCount: plan.steps.length,
        success,
        totalDurationMs,
        steps: plan.steps.map((s) => s.description),
        stepResults: stepResults.map((sr) => ({
          stepIndex: sr.stepIndex,
          description: sr.description,
          exitCode: sr.result.exitCode,
          success: sr.result.success,
          durationMs: sr.result.durationMs,
          stdout: sr.result.stdout.slice(0, 500),
          stderr: sr.result.stderr.slice(0, 500),
          cwdAfter: sr.cwdAfter,
          envDelta: sr.envDelta,
        })),
      },
    });

    // Record rollback result if one occurred
    if (rollbackStepResults && rollbackStepResults.length > 0) {
      const rollbackSuccess = rollbackStepResults.every((s) => s.result.success);
      const rollbackDurationMs = rollbackStepResults.reduce((sum, s) => sum + s.result.durationMs, 0);

      this.debrief.record({
        partitionId: null,
        operationId,
        agent: "envoy",
        decisionType: "rollback-execution",
        decision: rollbackSuccess
          ? `Rollback completed successfully (${rollbackStepResults.length} steps) in ${rollbackDurationMs}ms`
          : `Rollback partially failed — ${rollbackStepResults.filter((s) => !s.result.success).length} step(s) failed. ` +
            `System may be in a partially-rolled-back state. Manual intervention may be required.`,
        reasoning: `Automatic rollback triggered after execution failure. ` +
          `Attempted to reverse ${rollbackStepResults.length} step(s) in reverse order.`,
        context: {
          rollbackStepCount: rollbackStepResults.length,
          rollbackSuccess,
          rollbackDurationMs,
          rollbackStepResults: rollbackStepResults.map((sr) => ({
            stepIndex: sr.stepIndex,
            description: sr.description,
            exitCode: sr.result.exitCode,
            success: sr.result.success,
            stderr: sr.result.stderr.slice(0, 500),
          })),
        },
      });
    }
  }
}
