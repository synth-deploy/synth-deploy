/**
 * Service health check abstraction.
 *
 * Injected into the Server Agent so tests can control health check outcomes
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
