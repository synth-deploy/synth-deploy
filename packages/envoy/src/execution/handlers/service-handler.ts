import type { PlannedStep } from "@synth-deploy/core";
import type { Platform } from "../platform.js";
import type { PlatformAdapter } from "../platform.js";
import type { OperationHandler, HandlerResult, DryRunResult } from "../operation-registry.js";

// ---------------------------------------------------------------------------
// ServiceHandler — start/stop/restart system services
// ---------------------------------------------------------------------------

/**
 * Handles service lifecycle operations via the platform's service manager.
 *
 * Matches actions containing: start, stop, restart, service, reload
 *
 * This handler delegates to PlatformAdapter.serviceManager so the
 * correct OS-level tool (systemctl, launchctl) is used transparently.
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
    action: string,
    target: string,
    _params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const lower = action.toLowerCase();
    const sm = this.adapter.serviceManager;

    try {
      if (lower.includes("restart") || lower.includes("reload")) {
        const result = await sm.restart(target);
        return {
          success: result.success,
          output: result.output,
          error: result.success ? undefined : result.output,
        };
      }

      if (lower.includes("stop")) {
        const result = await sm.stop(target);
        return {
          success: result.success,
          output: result.output,
          error: result.success ? undefined : result.output,
        };
      }

      // Default: start (covers "start", "service start", etc.)
      const result = await sm.start(target);
      return {
        success: result.success,
        output: result.output,
        error: result.success ? undefined : result.output,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: "",
        error: `Service operation "${action}" on "${target}" failed: ${message}`,
      };
    }
  }

  async verify(action: string, target: string): Promise<boolean> {
    const lower = action.toLowerCase();
    const status = await this.adapter.serviceManager.status(target);

    // After start/restart, service should be running
    if (lower.includes("start") || lower.includes("restart") || lower.includes("reload")) {
      return status.running;
    }

    // After stop, service should not be running
    if (lower.includes("stop")) {
      return !status.running;
    }

    return true;
  }

  async dryRun(
    step: PlannedStep,
    _predictedOutcomes: Map<number, Record<string, unknown>>,
  ): Promise<DryRunResult> {
    const preconditions: DryRunResult["preconditions"] = [];
    const lower = step.action.toLowerCase();
    const target = step.target;
    const unknowns: string[] = [];

    try {
      // Check if the service exists in the service manager
      const status = await this.adapter.serviceManager.status(target);

      preconditions.push({
        check: "service-exists",
        passed: true,
        detail: `Service "${target}" found in service manager — currently ${status.running ? "running" : "stopped"}`,
      });

      // For start: warn if already running (not a failure, but notable)
      if (lower.includes("start") && !lower.includes("restart")) {
        if (status.running) {
          preconditions.push({
            check: "service-state",
            passed: true,
            detail: `Service "${target}" is already running — start will be a no-op or restart`,
          });
        } else {
          preconditions.push({
            check: "service-state",
            passed: true,
            detail: `Service "${target}" is stopped — ready to start`,
          });
        }
      }

      // For stop: check it's actually running
      if (lower.includes("stop")) {
        preconditions.push({
          check: "service-state",
          passed: true,
          detail: status.running
            ? `Service "${target}" is running — ready to stop`
            : `Service "${target}" is already stopped — stop will be a no-op`,
        });
      }

      unknowns.push(
        `Actual ${lower.includes("restart") ? "restart" : lower.includes("stop") ? "stop" : "start"} success depends on service configuration and runtime state`,
      );

      const allPassed = preconditions.every((p) => p.passed);

      return {
        canExecute: allPassed,
        preconditions,
        predictedOutcome: {
          serviceState: lower.includes("stop") ? "stopped" : "running",
          serviceName: target,
        },
        fidelity: "speculative",
        recoverable: true,
        unknowns,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // Distinguish "service unit not installed" (unrecoverable — needs admin to install)
      // from transient query failures (recoverable — LLM might be able to work around it).
      const notInstalled =
        message.includes("could not be found") ||
        message.includes("not-found") ||
        message.includes("no such") ||
        message.includes("Unit ") ||
        message.includes("not found");

      preconditions.push({
        check: "service-exists",
        passed: false,
        detail: notInstalled
          ? `Service "${target}" is not installed on this system — add an install step (e.g. apt-get install) before this service operation: ${message}`
          : `Service "${target}" could not be queried: ${message}`,
      });

      // For "start" operations, still emit predictedOutcome so downstream steps
      // (e.g. ContainerHandler daemon check) can see the INTENT even when the
      // service isn't registered with the local service manager (e.g. Docker
      // Desktop on macOS doesn't register with launchctl).
      const isStart = !lower.includes("stop");

      return {
        canExecute: false,
        preconditions,
        predictedOutcome: isStart ? { serviceState: "running", serviceName: target } : undefined,
        fidelity: "speculative",
        recoverable: !notInstalled,
        unknowns: notInstalled
          ? [`Service "${target}" is not installed — the deployment plan must include an installation step`]
          : [`Service "${target}" could not be queried — it may not be installed or the service manager may be unavailable`],
      };
    }
  }
}
