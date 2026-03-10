import type {
  PlannedStep,
  SecurityBoundary,
  DebriefWriter,
} from "@synth-deploy/core";
import type { DefaultOperationRegistry } from "./operation-registry.js";
import type { BoundaryValidator } from "./boundary-validator.js";
import type { Platform } from "./platform.js";

// ---------------------------------------------------------------------------
// Types — execution results and progress events
// ---------------------------------------------------------------------------

/**
 * Result of executing a single planned step.
 */
export interface OperationResult {
  step: PlannedStep;
  status: "completed" | "failed";
  output: string;
  error?: string;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  systemStateAfter?: string;
}

/**
 * Progress event emitted during plan execution. Consumers use these
 * to update UI, log progress, or stream status to connected clients.
 */
export interface ExecutionProgressEvent {
  deploymentId: string;
  type:
    | "step-started"
    | "step-completed"
    | "step-failed"
    | "rollback-started"
    | "rollback-completed"
    | "deployment-completed";
  stepIndex: number;
  stepDescription: string;
  status: "in_progress" | "completed" | "failed";
  output?: string;
  error?: string;
  timestamp: Date;
  /** 0–100 percentage of overall progress */
  overallProgress: number;
}

/**
 * Callback for progress events during execution.
 */
export type ProgressCallback = (event: ExecutionProgressEvent) => void;

/**
 * Full result of executing an entire plan.
 */
export interface PlanExecutionResult {
  success: boolean;
  results: OperationResult[];
  /** If execution failed, which step failed */
  failedStepIndex?: number;
  /** If rollback was triggered, the results of rollback steps */
  rollbackResults?: OperationResult[];
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// DefaultOperationExecutor — orchestrates plan execution
// ---------------------------------------------------------------------------

/**
 * The operation executor is the deterministic engine that runs approved
 * deployment plans. It does NOT reason — that happened during planning.
 * It executes exactly what was approved, validates boundaries, and
 * handles failures with automatic rollback.
 *
 * Contract:
 * 1. Validate ALL steps against security boundaries before executing any
 * 2. Execute steps sequentially (order matters for deployments)
 * 3. On failure, automatically rollback completed steps in reverse order
 * 4. Every action is recorded to the debrief
 * 5. The system is always left in a known state
 */
export class DefaultOperationExecutor {
  constructor(
    private registry: DefaultOperationRegistry,
    private boundaryValidator: BoundaryValidator,
    private platform: Platform,
    private debrief?: DebriefWriter,
  ) {}

  /**
   * Execute a single step after boundary validation.
   */
  async executeStep(
    step: PlannedStep,
    boundaries: SecurityBoundary[],
  ): Promise<OperationResult> {
    const startedAt = new Date();

    // Validate boundary
    const validation = this.boundaryValidator.validateStep(step, boundaries);
    if (!validation.allowed) {
      const completedAt = new Date();
      return {
        step,
        status: "failed",
        output: "",
        error: `Security boundary violation: ${validation.reason}`,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    }

    // Resolve handler
    const handler = this.registry.resolve(step.action, this.platform);
    if (!handler) {
      const completedAt = new Date();
      const caps = this.registry.listCapabilities();
      const handlerSummary = caps
        .map((c) => `${c.name} [keywords: ${c.actionKeywords.join(", ")}]`)
        .join("; ");
      const allKeywords = this.registry.allActionKeywords();
      return {
        step,
        status: "failed",
        output: "",
        error:
          `No handler registered for action "${step.action}" on platform ` +
          `"${this.platform}". The action string must contain at least one ` +
          `recognized keyword. Available handlers: ${handlerSummary || "none"}. ` +
          `Recognized action keywords: ${allKeywords.join(", ") || "none"}.`,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    }

    // Execute
    try {
      const result = await handler.execute(step.action, step.target, {
        description: step.description,
        rollbackAction: step.rollbackAction,
        reversible: step.reversible,
      });

      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      // Optional post-execution verification
      let systemStateAfter: string | undefined;
      if (result.success && handler.verify) {
        const verified = await handler.verify(step.action, step.target);
        systemStateAfter = verified
          ? "verified"
          : "execution succeeded but verification failed";
      }

      // Record to debrief
      this.recordDebrief(step, result.success, result.output, durationMs, result.error);

      return {
        step,
        status: result.success ? "completed" : "failed",
        output: result.output,
        error: result.error,
        startedAt,
        completedAt,
        durationMs,
        systemStateAfter,
      };
    } catch (err: unknown) {
      const completedAt = new Date();
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.recordDebrief(step, false, "", completedAt.getTime() - startedAt.getTime(), errorMsg);

      return {
        step,
        status: "failed",
        output: "",
        error: `Unexpected error executing "${step.action}": ${errorMsg}`,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    }
  }

  /**
   * Execute an entire plan: validate all steps first, then execute
   * sequentially. On failure, automatically rollback in reverse order.
   */
  async executePlan(
    steps: PlannedStep[],
    boundaries: SecurityBoundary[],
    onProgress?: ProgressCallback,
    deploymentId?: string,
  ): Promise<PlanExecutionResult> {
    const planStart = Date.now();
    const depId = deploymentId ?? "unknown";

    // Phase 1: Validate ALL steps before executing any
    const planValidation = this.boundaryValidator.validatePlan(steps, boundaries);
    if (!planValidation.allowed) {
      const violations = planValidation.violations;
      const firstViolation = violations[0];
      return {
        success: false,
        results: [{
          step: firstViolation.step,
          status: "failed",
          output: "",
          error:
            `Plan rejected: ${violations.length} security boundary violation(s). ` +
            `First violation: ${firstViolation.reason}`,
          startedAt: new Date(),
          completedAt: new Date(),
          durationMs: 0,
        }],
        failedStepIndex: steps.indexOf(firstViolation.step),
        totalDurationMs: Date.now() - planStart,
      };
    }

    // Phase 2: Execute steps sequentially
    const results: OperationResult[] = [];
    let failedIndex: number | undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Emit step-started
      onProgress?.({
        deploymentId: depId,
        type: "step-started",
        stepIndex: i,
        stepDescription: step.description,
        status: "in_progress",
        timestamp: new Date(),
        overallProgress: Math.round((i / steps.length) * 100),
      });

      const result = await this.executeStep(step, boundaries);
      results.push(result);

      if (result.status === "failed") {
        failedIndex = i;

        // Emit step-failed
        onProgress?.({
          deploymentId: depId,
          type: "step-failed",
          stepIndex: i,
          stepDescription: step.description,
          status: "failed",
          error: result.error,
          timestamp: new Date(),
          overallProgress: Math.round((i / steps.length) * 100),
        });

        // Phase 3: Automatic rollback of completed steps
        const completedSteps = results
          .filter((r) => r.status === "completed")
          .map((r) => r.step);

        let rollbackResults: OperationResult[] | undefined;
        if (completedSteps.length > 0) {
          rollbackResults = await this.rollback(
            completedSteps,
            boundaries,
            onProgress,
            depId,
          );
        }

        return {
          success: false,
          results,
          failedStepIndex: failedIndex,
          rollbackResults,
          totalDurationMs: Date.now() - planStart,
        };
      }

      // Emit step-completed
      onProgress?.({
        deploymentId: depId,
        type: "step-completed",
        stepIndex: i,
        stepDescription: step.description,
        status: "completed",
        output: result.output,
        timestamp: new Date(),
        overallProgress: Math.round(((i + 1) / steps.length) * 100),
      });
    }

    // All steps succeeded
    onProgress?.({
      deploymentId: depId,
      type: "deployment-completed",
      stepIndex: steps.length - 1,
      stepDescription: "All steps completed",
      status: "completed",
      timestamp: new Date(),
      overallProgress: 100,
    });

    return {
      success: true,
      results,
      totalDurationMs: Date.now() - planStart,
    };
  }

  /**
   * Rollback completed steps in reverse order using each step's
   * rollbackAction. Steps without a rollbackAction are skipped.
   */
  async rollback(
    completedSteps: PlannedStep[],
    boundaries: SecurityBoundary[],
    onProgress?: ProgressCallback,
    deploymentId?: string,
  ): Promise<OperationResult[]> {
    const depId = deploymentId ?? "unknown";
    const rollbackResults: OperationResult[] = [];

    // Emit rollback-started
    onProgress?.({
      deploymentId: depId,
      type: "rollback-started",
      stepIndex: 0,
      stepDescription: `Rolling back ${completedSteps.length} completed step(s)`,
      status: "in_progress",
      timestamp: new Date(),
      overallProgress: 0,
    });

    // Reverse order — undo the most recent step first
    const reversed = [...completedSteps].reverse();

    for (let i = 0; i < reversed.length; i++) {
      const step = reversed[i];

      if (!step.rollbackAction) {
        // No rollback action defined — skip but record
        rollbackResults.push({
          step,
          status: "completed",
          output: `No rollback action defined for "${step.description}" — skipped`,
          startedAt: new Date(),
          completedAt: new Date(),
          durationMs: 0,
        });
        continue;
      }

      // Create a rollback step from the original step's rollback action
      const rollbackStep: PlannedStep = {
        description: `Rollback: ${step.description}`,
        action: step.rollbackAction,
        target: step.target,
        reversible: false,
      };

      const result = await this.executeStep(rollbackStep, boundaries);
      rollbackResults.push(result);

      // Log rollback failures but continue — best effort to leave
      // system in known state
      if (result.status === "failed") {
        this.debrief?.record({
          partitionId: null,
          deploymentId: depId,
          agent: "envoy",
          decisionType: "rollback-execution",
          decision: `Rollback step failed: ${step.description}`,
          reasoning:
            `Failed to rollback "${step.description}" with action ` +
            `"${step.rollbackAction}": ${result.error}. The system may ` +
            `be in a partially-rolled-back state. Manual intervention ` +
            `may be required to restore the expected state.`,
          context: {
            originalStep: step,
            rollbackError: result.error,
          },
        });
      }
    }

    // Emit rollback-completed
    onProgress?.({
      deploymentId: depId,
      type: "rollback-completed",
      stepIndex: 0,
      stepDescription: `Rollback complete — ${rollbackResults.filter((r) => r.status === "completed").length}/${reversed.length} steps rolled back`,
      status: "completed",
      timestamp: new Date(),
      overallProgress: 100,
    });

    return rollbackResults;
  }

  // -------------------------------------------------------------------------
  // Internal: debrief recording
  // -------------------------------------------------------------------------

  private recordDebrief(
    step: PlannedStep,
    success: boolean,
    output: string,
    durationMs: number,
    error?: string,
  ): void {
    if (!this.debrief) return;

    this.debrief.record({
      partitionId: null,
      deploymentId: null,
      agent: "envoy",
      decisionType: "deployment-execution",
      decision: `Executed: ${step.action} ${step.target} — ${success ? "succeeded" : "failed"}`,
      reasoning: success
        ? `Step "${step.description}" completed in ${durationMs}ms. ` +
          `Action "${step.action}" applied to "${step.target}". ` +
          `Output: ${output || "(no output)"}.`
        : `Step "${step.description}" failed after ${durationMs}ms. ` +
          `Action "${step.action}" targeting "${step.target}" did not complete. ` +
          `Error: ${error ?? "unknown"}. ` +
          `${step.reversible ? "This step is reversible — rollback will be attempted." : "This step is not reversible — manual intervention may be needed."}`,
      context: {
        action: step.action,
        target: step.target,
        success,
        output: output.slice(0, 500),
        error,
        durationMs,
        reversible: step.reversible,
      },
    });
  }
}
