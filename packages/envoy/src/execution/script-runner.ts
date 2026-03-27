import { spawn } from "node:child_process";
import type { ScriptedPlan } from "@synth-deploy/core";
import { envoyLog, envoyWarn, envoyError } from "../logger.js";
import type { Platform } from "./platform.js";

// ---------------------------------------------------------------------------
// Types — script execution results
// ---------------------------------------------------------------------------

/**
 * Result of executing a single script (execution, dry-run, or rollback).
 */
export interface ScriptResult {
  /** Exit code from the script process */
  exitCode: number;
  /** Combined stdout output */
  stdout: string;
  /** Combined stderr output */
  stderr: string;
  /** Whether the script completed without error (exit code 0) */
  success: boolean;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** True if the script was killed due to timeout */
  timedOut: boolean;
}

/**
 * Full result of executing a scripted plan (execution + optional rollback).
 */
export interface ScriptedPlanResult {
  success: boolean;
  /** Result of the execution script */
  executionResult: ScriptResult;
  /** Result of the dry-run script (if one was run) */
  dryRunResult?: ScriptResult;
  /** Result of the rollback script (if rollback was triggered) */
  rollbackResult?: ScriptResult;
  /** Total wall-clock duration */
  totalDurationMs: number;
}

/**
 * Progress event emitted during scripted execution.
 */
export interface ScriptProgressEvent {
  operationId: string;
  type:
    | "script-started"
    | "script-output"
    | "script-completed"
    | "script-failed"
    | "rollback-started"
    | "rollback-completed"
    | "execution-completed";
  phase: "dry-run" | "execution" | "rollback";
  output?: string;
  error?: string;
  exitCode?: number;
  timestamp: Date;
  overallProgress: number;
}

export type ScriptProgressCallback = (event: ScriptProgressEvent) => void;

// ---------------------------------------------------------------------------
// ScriptRunner — executes approved scripts verbatim
// ---------------------------------------------------------------------------

/** Default timeout for script execution: 5 minutes */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The script runner is the deterministic execution engine for scripted plans.
 * It runs approved scripts verbatim — no re-reasoning, no improvisation.
 *
 * Contract:
 * 1. Scripts run exactly as approved — zero modification
 * 2. stdout/stderr captured in real-time for progress and debrief
 * 3. Exit code determines success/failure
 * 4. On failure, rollback script executes automatically (if one exists)
 * 5. System always left in a known state with full execution record
 */
export class ScriptRunner {
  constructor(
    private platform: Platform,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Execute a scripted plan: run the execution script, and on failure
   * automatically run the rollback script if one exists.
   */
  async executePlan(
    plan: ScriptedPlan,
    operationId: string,
    onProgress?: ScriptProgressCallback,
  ): Promise<ScriptedPlanResult> {
    const planStart = Date.now();

    // Run execution script
    onProgress?.({
      operationId,
      type: "script-started",
      phase: "execution",
      timestamp: new Date(),
      overallProgress: 10,
    });

    const executionResult = await this.runScript(
      plan.executionScript,
      plan.platform,
      (output) => {
        onProgress?.({
          operationId,
          type: "script-output",
          phase: "execution",
          output,
          timestamp: new Date(),
          overallProgress: 50,
        });
      },
    );

    if (executionResult.success) {
      onProgress?.({
        operationId,
        type: "script-completed",
        phase: "execution",
        exitCode: executionResult.exitCode,
        timestamp: new Date(),
        overallProgress: 90,
      });

      onProgress?.({
        operationId,
        type: "execution-completed",
        phase: "execution",
        timestamp: new Date(),
        overallProgress: 100,
      });

      return {
        success: true,
        executionResult,
        totalDurationMs: Date.now() - planStart,
      };
    }

    // Execution failed
    envoyError("Script execution failed", {
      exitCode: executionResult.exitCode,
      timedOut: executionResult.timedOut,
      stderr: executionResult.stderr.slice(0, 500),
    });

    onProgress?.({
      operationId,
      type: "script-failed",
      phase: "execution",
      error: executionResult.stderr || `Exit code ${executionResult.exitCode}`,
      exitCode: executionResult.exitCode,
      timestamp: new Date(),
      overallProgress: 60,
    });

    // Run rollback script if available
    let rollbackResult: ScriptResult | undefined;
    if (plan.rollbackScript) {
      envoyLog("Executing rollback script");

      onProgress?.({
        operationId,
        type: "rollback-started",
        phase: "rollback",
        timestamp: new Date(),
        overallProgress: 70,
      });

      rollbackResult = await this.runScript(
        plan.rollbackScript,
        plan.platform,
        (output) => {
          onProgress?.({
            operationId,
            type: "script-output",
            phase: "rollback",
            output,
            timestamp: new Date(),
            overallProgress: 80,
          });
        },
      );

      if (rollbackResult.success) {
        envoyLog("Rollback completed successfully");
      } else {
        envoyError("Rollback script also failed", {
          exitCode: rollbackResult.exitCode,
          stderr: rollbackResult.stderr.slice(0, 500),
        });
      }

      onProgress?.({
        operationId,
        type: "rollback-completed",
        phase: "rollback",
        exitCode: rollbackResult.exitCode,
        timestamp: new Date(),
        overallProgress: 90,
      });
    }

    onProgress?.({
      operationId,
      type: "execution-completed",
      phase: "execution",
      error: executionResult.stderr || `Exit code ${executionResult.exitCode}`,
      timestamp: new Date(),
      overallProgress: 100,
    });

    return {
      success: false,
      executionResult,
      rollbackResult,
      totalDurationMs: Date.now() - planStart,
    };
  }

  /**
   * Execute a dry-run script. Returns the result for LLM feedback.
   * Dry-run scripts are read-only probes — they should not mutate state.
   */
  async executeDryRun(
    script: string,
    scriptPlatform: ScriptedPlan["platform"],
  ): Promise<ScriptResult> {
    envoyLog("Executing dry-run script");
    return this.runScript(script, scriptPlatform);
  }

  /**
   * Run a script and capture its output. This is the core execution
   * primitive — all script types (execution, dry-run, rollback) use it.
   */
  async runScript(
    script: string,
    scriptPlatform: ScriptedPlan["platform"],
    onOutput?: (chunk: string) => void,
  ): Promise<ScriptResult> {
    const startTime = Date.now();

    const shell = scriptPlatform === "powershell" ? "pwsh" : "bash";
    const args = scriptPlatform === "powershell"
      ? ["-NoProfile", "-NonInteractive", "-Command", script]
      : ["-euo", "pipefail", "-c", script];

    return new Promise<ScriptResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // CodeQL[js/command-line-injection]: scripts are LLM-generated and require
      // explicit user approval before execution — this is the intentional execution surface.
      const child = spawn(shell, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: this.timeoutMs,
        env: { ...process.env },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Give it 5s to clean up, then force kill
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, this.timeoutMs);

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        onOutput?.(chunk);
      });

      child.stderr.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        onOutput?.(chunk);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const exitCode = code ?? (timedOut ? 124 : 1);

        if (timedOut) {
          envoyWarn("Script timed out", { timeoutMs: this.timeoutMs, durationMs });
        }

        resolve({
          exitCode,
          stdout,
          stderr,
          success: exitCode === 0,
          durationMs,
          timedOut,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        resolve({
          exitCode: 127,
          stdout,
          stderr: stderr + `\nSpawn error: ${err.message}`,
          success: false,
          durationMs,
          timedOut: false,
        });
      });
    });
  }
}
