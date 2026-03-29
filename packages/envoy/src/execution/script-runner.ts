import { spawn } from "node:child_process";
import type { ScriptedPlan, PlanStep } from "@synth-deploy/core";
import { envoyLog, envoyWarn, envoyError } from "../logger.js";
import type { Platform } from "./platform.js";

// ---------------------------------------------------------------------------
// Types — script execution results
// ---------------------------------------------------------------------------

/**
 * Result of executing a single script (execution, dry-run, or rollback).
 */
export interface ScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  success: boolean;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Result of executing a single plan step.
 */
export interface StepResult {
  stepIndex: number;
  description: string;
  result: ScriptResult;
  /** Working directory captured after this step completed */
  cwdAfter?: string;
  /** Environment variables that changed during this step */
  envDelta?: Record<string, string>;
}

/**
 * Result of a single dry-run step.
 */
export interface DryRunStepResult {
  stepIndex: number;
  description: string;
  status: "passed" | "failed" | "skipped";
  result?: ScriptResult;
}

/**
 * Full result of executing a scripted plan.
 */
export interface ScriptedPlanResult {
  success: boolean;
  stepResults: StepResult[];
  dryRunResults?: DryRunStepResult[];
  rollbackStepResults?: StepResult[];
  totalDurationMs: number;
}

/**
 * Progress event emitted during scripted execution.
 */
export interface ScriptProgressEvent {
  operationId: string;
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
    | "execution-completed";
  phase: "dry-run" | "execution" | "rollback";
  output?: string;
  error?: string;
  exitCode?: number;
  timestamp: Date;
  overallProgress: number;
  stepIndex?: number;
  stepDescription?: string;
  totalSteps?: number;
}

export type ScriptProgressCallback = (event: ScriptProgressEvent) => void;

// ---------------------------------------------------------------------------
// Internal: state threading markers
// ---------------------------------------------------------------------------

const CWD_MARKER = "##SYNTH_INTERNAL_CWD:";
const ENV_START_MARKER = "##SYNTH_INTERNAL_ENV_START";

/** Append state-capture commands to a step script (invisible to the user) */
function appendStateCapture(script: string, platform: ScriptedPlan["platform"]): string {
  if (platform === "powershell") {
    return `${script}\nWrite-Output "${CWD_MARKER}$(Get-Location)"\nWrite-Output "${ENV_START_MARKER}"\nGet-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" }`;
  }
  return `${script}\necho "${CWD_MARKER}$(pwd)"\necho "${ENV_START_MARKER}"\nenv`;
}

/** Parse cwd and env delta from script output; return cleaned output */
function parseStateFromOutput(
  rawOutput: string,
  prevEnv: Record<string, string>,
): { cleanOutput: string; cwdAfter?: string; envDelta: Record<string, string> } {
  const cwdIndex = rawOutput.lastIndexOf(CWD_MARKER);
  const envIndex = rawOutput.lastIndexOf(ENV_START_MARKER);

  let cwdAfter: string | undefined;
  const envDelta: Record<string, string> = {};

  if (cwdIndex !== -1) {
    const cwdLine = rawOutput.slice(cwdIndex + CWD_MARKER.length).split("\n")[0]?.trim();
    if (cwdLine) cwdAfter = cwdLine;
  }

  if (envIndex !== -1) {
    const envBlock = rawOutput.slice(envIndex + ENV_START_MARKER.length).trim();
    for (const line of envBlock.split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx === -1) continue;
      const key = line.slice(0, eqIdx).trim();
      const val = line.slice(eqIdx + 1).trim();
      if (!key || key.startsWith("##SYNTH_INTERNAL")) continue;
      if (prevEnv[key] !== val) {
        envDelta[key] = val;
      }
    }
  }

  // Strip the internal markers and everything after the CWD marker from visible output
  let cleanOutput = rawOutput;
  const firstMarkerIdx = Math.min(
    cwdIndex === -1 ? Infinity : cwdIndex,
    envIndex === -1 ? Infinity : envIndex,
  );
  if (firstMarkerIdx !== Infinity) {
    cleanOutput = rawOutput.slice(0, firstMarkerIdx).trimEnd();
  }

  return { cleanOutput, cwdAfter, envDelta };
}

// ---------------------------------------------------------------------------
// ScriptRunner — executes approved scripts verbatim
// ---------------------------------------------------------------------------

/** Default timeout per step: 5 minutes */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The script runner is the deterministic execution engine for scripted plans.
 * Each step runs as an independent process with state (cwd, env) threaded
 * between steps transparently.
 */
export class ScriptRunner {
  constructor(
    private platform: Platform,
    private timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Execute a scripted plan: run each step sequentially. On failure, roll back
   * completed steps in reverse order.
   */
  async executePlan(
    plan: ScriptedPlan,
    operationId: string,
    onProgress?: ScriptProgressCallback,
  ): Promise<ScriptedPlanResult> {
    const planStart = Date.now();
    const totalSteps = plan.steps.length;
    const stepResults: StepResult[] = [];
    const completedStepIndices: number[] = [];

    // State threading: track cwd and env between steps
    let capturedCwd: string | undefined;
    let capturedEnv: Record<string, string> = { ...process.env } as Record<string, string>;
    const stepStateSnapshots = new Map<number, { cwd?: string; env: Record<string, string> }>();

    for (let i = 0; i < totalSteps; i++) {
      const step = plan.steps[i];

      onProgress?.({
        operationId,
        type: "plan-step-started",
        phase: "execution",
        stepIndex: i,
        stepDescription: step.description,
        totalSteps,
        timestamp: new Date(),
        overallProgress: 10 + (i / totalSteps) * 80,
      });

      const scriptWithCapture = appendStateCapture(step.script, plan.platform);
      const result = await this.runScript(
        scriptWithCapture,
        plan.platform,
        (chunk) => {
          // Strip internal markers from progress output
          const clean = chunk.replace(/##SYNTH_INTERNAL[^\n]*/g, "").trim();
          if (clean) {
            onProgress?.({
              operationId,
              type: "step-output",
              phase: "execution",
              output: clean,
              timestamp: new Date(),
              overallProgress: 10 + (i / totalSteps) * 80,
              stepIndex: i,
            });
          }
        },
        { cwd: capturedCwd, env: capturedEnv },
      );

      // Parse state from output
      const { cleanOutput, cwdAfter, envDelta } = parseStateFromOutput(result.stdout, capturedEnv);
      const cleanResult: ScriptResult = { ...result, stdout: cleanOutput };

      if (result.success) {
        // Update state for next step
        if (cwdAfter) capturedCwd = cwdAfter;
        capturedEnv = { ...capturedEnv, ...envDelta };

        const stepResult: StepResult = {
          stepIndex: i,
          description: step.description,
          result: cleanResult,
          cwdAfter,
          envDelta: Object.keys(envDelta).length > 0 ? envDelta : undefined,
        };
        stepResults.push(stepResult);
        completedStepIndices.push(i);
        stepStateSnapshots.set(i, { cwd: capturedCwd, env: { ...capturedEnv } });

        onProgress?.({
          operationId,
          type: "plan-step-completed",
          phase: "execution",
          stepIndex: i,
          stepDescription: step.description,
          totalSteps,
          timestamp: new Date(),
          overallProgress: 10 + ((i + 1) / totalSteps) * 80,
        });
      } else {
        const stepResult: StepResult = {
          stepIndex: i,
          description: step.description,
          result: cleanResult,
        };
        stepResults.push(stepResult);

        envoyError("Step execution failed", {
          stepIndex: i,
          description: step.description,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stderr: result.stderr.slice(0, 500),
        });

        onProgress?.({
          operationId,
          type: "plan-step-failed",
          phase: "execution",
          stepIndex: i,
          stepDescription: step.description,
          totalSteps,
          timestamp: new Date(),
          overallProgress: 10 + (i / totalSteps) * 80,
          error: result.stderr || `Exit code ${result.exitCode}`,
        });

        // Rollback completed steps in reverse order
        const rollbackResults = await this.rollbackSteps(
          plan,
          completedStepIndices,
          stepStateSnapshots,
          operationId,
          onProgress,
        );

        onProgress?.({
          operationId,
          type: "execution-completed",
          phase: "execution",
          timestamp: new Date(),
          overallProgress: 100,
          error: result.stderr || `Exit code ${result.exitCode}`,
        });

        return {
          success: false,
          stepResults,
          rollbackStepResults: rollbackResults,
          totalDurationMs: Date.now() - planStart,
        };
      }
    }

    onProgress?.({
      operationId,
      type: "execution-completed",
      phase: "execution",
      timestamp: new Date(),
      overallProgress: 100,
    });

    return {
      success: true,
      stepResults,
      totalDurationMs: Date.now() - planStart,
    };
  }

  /**
   * Execute per-step dry-run. Runs all steps even on failure (unlike execution
   * which stops). Returns step-level pass/fail/skipped results.
   */
  async executeDryRunPlan(
    plan: ScriptedPlan,
    operationId: string,
    onProgress?: ScriptProgressCallback,
  ): Promise<DryRunStepResult[]> {
    const totalSteps = plan.steps.length;
    const results: DryRunStepResult[] = [];

    let capturedCwd: string | undefined;
    let capturedEnv: Record<string, string> = { ...process.env } as Record<string, string>;

    for (let i = 0; i < totalSteps; i++) {
      const step = plan.steps[i];

      if (!step.dryRunScript) {
        onProgress?.({
          operationId,
          type: "dry-run-step-skipped",
          phase: "dry-run",
          stepIndex: i,
          stepDescription: step.description,
          totalSteps,
          timestamp: new Date(),
          overallProgress: (i / totalSteps) * 100,
        });
        results.push({ stepIndex: i, description: step.description, status: "skipped" });
        continue;
      }

      onProgress?.({
        operationId,
        type: "dry-run-step-started",
        phase: "dry-run",
        stepIndex: i,
        stepDescription: step.description,
        totalSteps,
        timestamp: new Date(),
        overallProgress: (i / totalSteps) * 100,
      });

      const scriptWithCapture = appendStateCapture(step.dryRunScript, plan.platform);
      const result = await this.runScript(
        scriptWithCapture,
        plan.platform,
        undefined,
        { cwd: capturedCwd, env: capturedEnv },
      );

      const { cleanOutput, cwdAfter, envDelta } = parseStateFromOutput(result.stdout, capturedEnv);
      const cleanResult: ScriptResult = { ...result, stdout: cleanOutput };

      if (result.success) {
        if (cwdAfter) capturedCwd = cwdAfter;
        capturedEnv = { ...capturedEnv, ...envDelta };

        onProgress?.({
          operationId,
          type: "dry-run-step-passed",
          phase: "dry-run",
          stepIndex: i,
          stepDescription: step.description,
          totalSteps,
          timestamp: new Date(),
          overallProgress: ((i + 1) / totalSteps) * 100,
          output: cleanResult.stdout,
        });
        results.push({ stepIndex: i, description: step.description, status: "passed", result: cleanResult });
      } else {
        onProgress?.({
          operationId,
          type: "dry-run-step-failed",
          phase: "dry-run",
          stepIndex: i,
          stepDescription: step.description,
          totalSteps,
          timestamp: new Date(),
          overallProgress: ((i + 1) / totalSteps) * 100,
          error: cleanResult.stderr || `Exit code ${cleanResult.exitCode}`,
          output: cleanResult.stdout,
        });
        results.push({ stepIndex: i, description: step.description, status: "failed", result: cleanResult });
        // Continue even on failure — report all failures
      }
    }

    return results;
  }

  /**
   * Run a single script and capture output.
   */
  async runScript(
    script: string,
    scriptPlatform: ScriptedPlan["platform"],
    onOutput?: (chunk: string) => void,
    context?: { cwd?: string; env?: Record<string, string> },
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
        cwd: context?.cwd ?? undefined,
        env: context?.env ? { ...process.env, ...context.env } : { ...process.env },
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
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

        resolve({ exitCode, stdout, stderr, success: exitCode === 0, durationMs, timedOut });
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

  // ---------------------------------------------------------------------------
  // Private: rollback completed steps in reverse order
  // ---------------------------------------------------------------------------

  private async rollbackSteps(
    plan: ScriptedPlan,
    completedStepIndices: number[],
    stepStateSnapshots: Map<number, { cwd?: string; env: Record<string, string> }>,
    operationId: string,
    onProgress?: ScriptProgressCallback,
  ): Promise<StepResult[]> {
    const rollbackResults: StepResult[] = [];
    // Reverse order: last completed first
    const reversed = [...completedStepIndices].reverse();

    for (const stepIndex of reversed) {
      const step = plan.steps[stepIndex];

      if (!step.reversible || !step.rollbackScript) {
        envoyLog("Skipping rollback for non-reversible step", { stepIndex, description: step.description });
        onProgress?.({
          operationId,
          type: "rollback-step-skipped",
          phase: "rollback",
          stepIndex,
          stepDescription: step.description,
          timestamp: new Date(),
          overallProgress: 50,
        });
        continue;
      }

      onProgress?.({
        operationId,
        type: "rollback-step-started",
        phase: "rollback",
        stepIndex,
        stepDescription: step.description,
        timestamp: new Date(),
        overallProgress: 60,
      });

      const snapshot = stepStateSnapshots.get(stepIndex);
      const result = await this.runScript(
        step.rollbackScript,
        plan.platform,
        (chunk) => {
          onProgress?.({
            operationId,
            type: "step-output",
            phase: "rollback",
            output: chunk,
            timestamp: new Date(),
            overallProgress: 70,
            stepIndex,
          });
        },
        { cwd: snapshot?.cwd, env: snapshot?.env ?? {} },
      );

      rollbackResults.push({
        stepIndex,
        description: `Rollback: ${step.description}`,
        result,
      });

      if (result.success) {
        envoyLog("Rollback step succeeded", { stepIndex, description: step.description });
        onProgress?.({
          operationId,
          type: "rollback-step-completed",
          phase: "rollback",
          stepIndex,
          stepDescription: step.description,
          timestamp: new Date(),
          overallProgress: 80,
        });
      } else {
        envoyError("Rollback step failed", {
          stepIndex,
          description: step.description,
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 500),
        });
        onProgress?.({
          operationId,
          type: "rollback-step-failed",
          phase: "rollback",
          stepIndex,
          stepDescription: step.description,
          timestamp: new Date(),
          overallProgress: 80,
          error: result.stderr || `Exit code ${result.exitCode}`,
        });
        // Continue to next rollback step — best effort
      }
    }

    return rollbackResults;
  }
}
