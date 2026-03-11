import { execFile } from "node:child_process";
import type { PlannedStep } from "@synth-deploy/core";
import type { Platform } from "../platform.js";
import type { PlatformAdapter } from "../platform.js";
import type { OperationHandler, HandlerResult, DryRunResult } from "../operation-registry.js";

// ---------------------------------------------------------------------------
// ServiceHandler — start/stop/restart system services
// ---------------------------------------------------------------------------

/**
 * Handles service lifecycle operations.
 *
 * execute() is a thin passthrough: the LLM provides the full command via
 * params.args (e.g. ["systemctl", "restart", "nginx"] or
 * ["launchctl", "kickstart", "-k", "gui/501/homebrew.mxcl.nginx"]).
 *
 * dryRun() uses the platform adapter to observe current service state
 * and report it as facts — the LLM decides what to do with them.
 *
 * Matches actions containing: start, stop, restart, service, reload
 */
export class ServiceHandler implements OperationHandler {
  readonly name = "service";
  readonly actionKeywords = ["start", "stop", "restart", "service", "reload"] as const;
  readonly toolDependencies = ["systemctl", "launchctl"] as const;

  constructor(private adapter: PlatformAdapter) {}

  canHandle(action: string, _platform: Platform): boolean {
    const lower = action.toLowerCase();
    return (
      lower.includes("start") ||
      lower.includes("stop") ||
      lower.includes("restart") ||
      lower.includes("service") ||
      lower.includes("reload")
    );
  }

  async execute(
    _action: string,
    _target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const args = (params.args as string[] | undefined) ?? [];
    if (args.length === 0) {
      return {
        success: false,
        output: "",
        error:
          `No service command provided. Set params.args to the full command ` +
          `(e.g. ["systemctl", "restart", "nginx"] or ["launchctl", "kickstart", "-k", "gui/501/homebrew.mxcl.nginx"]).`,
      };
    }

    const [cmd, ...cmdArgs] = args;
    return new Promise((resolve) => {
      execFile(cmd, cmdArgs, { timeout: 30_000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            output: stdout ?? "",
            error: `Service command failed: ${stderr || error.message}`,
          });
        } else {
          resolve({
            success: true,
            output: (stdout + (stderr ? `\nstderr: ${stderr}` : "")).trim(),
          });
        }
      });
    });
  }

  async dryRun(
    step: PlannedStep,
    _predictedOutcomes: Map<number, Record<string, unknown>>,
  ): Promise<DryRunResult> {
    const observations: DryRunResult["observations"] = [];
    const lower = step.action.toLowerCase();
    const target = step.target;
    const unknowns: string[] = [];

    try {
      const status = await this.adapter.serviceManager.status(target);

      observations.push({
        name: "service-exists",
        passed: true,
        detail: `Service "${target}" found — currently ${status.running ? "running" : "stopped"}`,
      });

      if (lower.includes("start") && !lower.includes("restart")) {
        observations.push({
          name: "service-state",
          passed: true,
          detail: status.running
            ? `Service "${target}" is already running — start will be a no-op or restart`
            : `Service "${target}" is stopped — ready to start`,
        });
      }

      if (lower.includes("stop")) {
        observations.push({
          name: "service-state",
          passed: true,
          detail: status.running
            ? `Service "${target}" is running — ready to stop`
            : `Service "${target}" is already stopped — stop will be a no-op`,
        });
      }

      unknowns.push(
        `Actual success depends on service configuration and runtime state`,
      );

      return {
        observations,
        predictedOutcome: {
          serviceState: lower.includes("stop") ? "stopped" : "running",
          serviceName: target,
        },
        fidelity: "speculative",
        unknowns,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      const notInstalled =
        message.includes("could not be found") ||
        message.includes("not-found") ||
        message.includes("no such") ||
        message.includes("Unit ") ||
        message.includes("not found");

      observations.push({
        name: "service-exists",
        passed: false,
        detail: notInstalled
          ? `Service "${target}" is not installed — add an install step before this service operation: ${message}`
          : `Service "${target}" could not be queried: ${message}`,
      });

      const isStart = !lower.includes("stop");
      return {
        observations,
        predictedOutcome: isStart ? { serviceState: "running", serviceName: target } : undefined,
        fidelity: "speculative",
        unknowns: [
          notInstalled
            ? `Service "${target}" is not installed — the plan must include an installation step`
            : `Service "${target}" could not be queried — may not be installed or service manager unavailable`,
        ],
      };
    }
  }
}
