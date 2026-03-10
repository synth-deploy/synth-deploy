import { execFile } from "node:child_process";
import type { Platform } from "../platform.js";
import type { OperationHandler, HandlerResult } from "../operation-registry.js";

// ---------------------------------------------------------------------------
// ProcessHandler — bounded command execution
// ---------------------------------------------------------------------------

/**
 * Executes bounded commands via child_process.execFile.
 *
 * Matches actions containing: run, execute, command, script
 *
 * This is NOT arbitrary shell execution. Every command:
 * - Uses execFile (no shell interpolation)
 * - Has a configurable timeout (default 60s)
 * - Can be constrained to a working directory
 * - Is validated against security boundaries before execution
 *
 * The target is the command to run. Arguments come from params.args.
 */
export class ProcessHandler implements OperationHandler {
  readonly name = "process";
  readonly actionKeywords = ["run", "execute", "command", "script"] as const;
  readonly toolDependencies = [] as const;

  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 60_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  canHandle(action: string, _platform: Platform): boolean {
    const lower = action.toLowerCase();
    return (
      lower.includes("run") ||
      lower.includes("execute") ||
      lower.includes("command") ||
      lower.includes("script")
    );
  }

  async execute(
    action: string,
    target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const args = (params.args as string[]) ?? [];
    const cwd = (params.cwd as string) ?? (params.workingDirectory as string) ?? undefined;
    const timeoutMs = (params.timeoutMs as number) ?? this.defaultTimeoutMs;
    const env = (params.env as Record<string, string>) ?? undefined;

    try {
      const result = await this.runCommand(target, args, {
        cwd,
        timeoutMs,
        env,
      });

      return {
        success: true,
        output: result.stdout + (result.stderr ? `\nstderr: ${result.stderr}` : ""),
      };
    } catch (err: unknown) {
      const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean; code?: string };

      // Distinguish timeout from other failures
      if (e.killed) {
        return {
          success: false,
          output: e.stdout ?? "",
          error:
            `Command "${target}" timed out after ${timeoutMs}ms. ` +
            `The process was killed. stdout: ${e.stdout ?? "(none)"}. ` +
            `stderr: ${e.stderr ?? "(none)"}`,
        };
      }

      return {
        success: false,
        output: e.stdout ?? "",
        error:
          `Command "${target}" failed with ${e.code ? `exit code ${e.code}` : "an error"}. ` +
          `stderr: ${e.stderr ?? e.message}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Internal: command execution
  // -------------------------------------------------------------------------

  private runCommand(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs: number; env?: Record<string, string> },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const execOptions: {
        timeout: number;
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        maxBuffer: number;
      } = {
        timeout: options.timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      };

      if (options.cwd) {
        execOptions.cwd = options.cwd;
      }

      if (options.env) {
        execOptions.env = { ...process.env, ...options.env };
      }

      execFile(command, args, execOptions, (error, stdout, stderr) => {
        if (error) {
          reject(
            Object.assign(error, {
              stdout: stdout ?? "",
              stderr: stderr ?? "",
            }),
          );
        } else {
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
        }
      });
    });
  }
}
