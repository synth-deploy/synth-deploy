import { exec } from "node:child_process";
import type { DeploymentStep } from "@deploystack/core";

export interface StepResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

const MAX_OUTPUT_CHARS = 2000;

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return "…" + output.slice(-MAX_OUTPUT_CHARS);
}

/**
 * Executes a deployment step's shell command with variable injection and timeout.
 *
 * Variables are injected as environment variables merged with the current
 * process environment. stdout/stderr are truncated to the last 2000 chars
 * to prevent memory issues in debrief entries.
 */
export function runStep(
  step: DeploymentStep,
  variables: Record<string, string>,
  timeoutMs: number,
): Promise<StepResult> {
  const start = Date.now();
  const controller = new AbortController();

  return new Promise((resolve) => {
    const child = exec(
      step.command,
      {
        env: { ...process.env, ...variables },
        signal: controller.signal,
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start;

        if (error && error.killed) {
          resolve({
            success: false,
            exitCode: null,
            stdout: truncate(stdout),
            stderr: truncate(stderr),
            durationMs,
            timedOut: true,
          });
          return;
        }

        const exitCode = error ? (error.code as unknown as number ?? 1) : 0;
        resolve({
          success: exitCode === 0,
          exitCode,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          durationMs,
          timedOut: false,
        });
      },
    );

    // Ensure the child process reference is used to suppress lint warnings
    void child;
  });
}
