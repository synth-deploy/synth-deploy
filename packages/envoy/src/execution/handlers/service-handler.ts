import type { Platform } from "../platform.js";
import type { PlatformAdapter } from "../platform.js";
import type { OperationHandler, HandlerResult } from "../operation-registry.js";

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
}
