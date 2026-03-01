import type {
  ServiceHealthChecker,
  HealthCheckResult,
} from "./health-checker.js";

// ---------------------------------------------------------------------------
// Types — Envoy API responses
// ---------------------------------------------------------------------------

export interface EnvoyDeployResult {
  deploymentId: string;
  success: boolean;
  workspacePath: string;
  artifacts: string[];
  executionDurationMs: number;
  totalDurationMs: number;
  verificationPassed: boolean;
  verificationChecks: Array<{ name: string; passed: boolean; detail: string }>;
  failureReason: string | null;
  debriefEntryIds: string[];
  /** Full debrief entries from the Envoy — Command can ingest these */
  debriefEntries: Array<{
    id: string;
    timestamp: string;
    partitionId: string | null;
    deploymentId: string | null;
    agent: "command" | "envoy";
    decisionType: string;
    decision: string;
    reasoning: string;
    context: Record<string, unknown>;
  }>;
}

export interface EnvoyHealthResponse {
  status: "healthy" | "degraded";
  service: string;
  hostname: string;
  timestamp: string;
  readiness: { ready: boolean; reason: string };
  summary: {
    totalDeployments: number;
    succeeded: number;
    failed: number;
    executing: number;
    environments: number;
  };
}

// ---------------------------------------------------------------------------
// EnvoyClient — Command's interface to a remote Envoy
// ---------------------------------------------------------------------------

/**
 * HTTP client for communicating with a Envoy agent.
 *
 * Command uses this to:
 * 1. Check if the Envoy is healthy (pre-flight health check)
 * 2. Delegate deployment execution to the Envoy
 * 3. Query the Envoy's local state
 */
export class EnvoyClient {
  constructor(
    private baseUrl: string,
    private timeoutMs: number = 10_000,
  ) {}

  /**
   * Check Envoy health — used as the ServiceHealthChecker for the
   * Command Agent's pre-flight health check step.
   */
  async checkHealth(): Promise<EnvoyHealthResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return (await response.json()) as EnvoyHealthResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Send a deployment instruction to the Envoy and wait for the result.
   */
  async deploy(instruction: {
    deploymentId: string;
    partitionId: string;
    environmentId: string;
    operationId: string;
    version: string;
    variables: Record<string, string>;
    environmentName: string;
    partitionName: string;
  }): Promise<EnvoyDeployResult> {
    const controller = new AbortController();
    // Deployments can take longer than health checks
    const timeout = setTimeout(
      () => controller.abort(),
      this.timeoutMs * 3,
    );

    try {
      const response = await fetch(`${this.baseUrl}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(instruction),
        signal: controller.signal,
      });

      const body = (await response.json()) as EnvoyDeployResult;
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ---------------------------------------------------------------------------
// EnvoyHealthChecker — adapts EnvoyClient to ServiceHealthChecker
// ---------------------------------------------------------------------------

/**
 * Adapts the EnvoyClient to the ServiceHealthChecker interface used by
 * the Command Agent's pre-flight health check step.
 *
 * When a Envoy is registered for an environment, Command's health
 * check actually reaches out to the Envoy instead of using the
 * DefaultHealthChecker (which always returns healthy).
 */
export class EnvoyHealthChecker implements ServiceHealthChecker {
  private envoys = new Map<string, EnvoyClient>();

  /**
   * Register a Envoy for a specific environment.
   * The serviceId format is "{operationId}/{environmentName}".
   */
  registerEnvoy(serviceId: string, client: EnvoyClient): void {
    this.envoys.set(serviceId, client);
  }

  async check(
    serviceId: string,
    _context: { partitionId: string; environmentName: string },
  ): Promise<HealthCheckResult> {
    const client = this.envoys.get(serviceId);

    if (!client) {
      // No Envoy registered for this service — assume healthy
      // (same as DefaultHealthChecker behavior)
      return { reachable: true, responseTimeMs: 0, error: null };
    }

    const start = Date.now();

    try {
      const health = await client.checkHealth();
      const responseTimeMs = Date.now() - start;

      if (health.status === "healthy" && health.readiness.ready) {
        return { reachable: true, responseTimeMs, error: null };
      }

      return {
        reachable: false,
        responseTimeMs,
        error: `Envoy reports ${health.status}: ${health.readiness.reason}`,
      };
    } catch (err) {
      const responseTimeMs = Date.now() - start;
      const message =
        err instanceof Error ? err.message : String(err);

      // Map fetch errors to recognizable categories for the Command Agent
      if (message.includes("abort")) {
        return {
          reachable: false,
          responseTimeMs,
          error: `ETIMEDOUT: Envoy health check timed out after ${responseTimeMs}ms`,
        };
      }

      if (
        message.includes("ECONNREFUSED") ||
        message.includes("fetch failed")
      ) {
        return {
          reachable: false,
          responseTimeMs,
          error: `ECONNREFUSED: Envoy at ${serviceId} is not responding`,
        };
      }

      return {
        reachable: false,
        responseTimeMs,
        error: `Envoy health check failed: ${message}`,
      };
    }
  }
}
