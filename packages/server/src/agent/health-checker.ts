import { serverLog, serverWarn, serverError } from "../logger.js";

/**
 * Service health check abstraction.
 *
 * Injected into the Command Agent so tests can control health check outcomes
 * without real network calls. In later phases, a real implementation will
 * make HTTP calls to Envoy health endpoints.
 */

export interface HealthCheckResult {
  reachable: boolean;
  responseTimeMs: number | null;
  error: string | null;
}

export interface ServiceHealthChecker {
  /**
   * Check if the target service/environment is healthy and reachable.
   */
  check(
    serviceId: string,
    context: { partitionId: string; environmentName: string },
  ): Promise<HealthCheckResult>;
}

/**
 * Default health checker — always reports healthy.
 * Used in development and when no real infrastructure is connected.
 */
export class DefaultHealthChecker implements ServiceHealthChecker {
  async check(): Promise<HealthCheckResult> {
    return { reachable: true, responseTimeMs: 1, error: null };
  }
}

/**
 * Real health checker that makes HTTP requests to an Envoy health endpoint.
 * Used when an Envoy URL is configured.
 */
export class EnvoyHealthChecker implements ServiceHealthChecker {
  constructor(private readonly envoyUrl: string, private readonly timeoutMs = 5000) {}

  async check(): Promise<HealthCheckResult> {
    serverLog("HEALTH-CHECK", { url: this.envoyUrl });
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const res = await fetch(`${this.envoyUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      const responseTimeMs = Date.now() - start;

      if (res.ok) {
        serverLog("HEALTH-OK", { url: this.envoyUrl, responseTimeMs });
        return { reachable: true, responseTimeMs, error: null };
      }
      serverWarn("HEALTH-FAILED", { url: this.envoyUrl, status: res.status, responseTimeMs });
      return { reachable: false, responseTimeMs, error: `HTTP ${res.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      serverError("HEALTH-ERROR", { url: this.envoyUrl, error: message });
      return {
        reachable: false,
        responseTimeMs: null,
        error: message,
      };
    }
  }
}
