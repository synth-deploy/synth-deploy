import type {
  ServiceHealthChecker,
  HealthCheckResult,
} from "./health-checker.js";
import { serverLog, serverWarn, serverError } from "../logger.js";
import type { DecisionType, DeploymentPlan, PlannedStep, SecurityBoundary } from "@synth-deploy/core";

// ---------------------------------------------------------------------------
// Types — Envoy API responses
// ---------------------------------------------------------------------------

export interface EnvoyDeployResult {
  operationId: string;
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
    operationId: string | null;
    agent: "server" | "envoy";
    decisionType: DecisionType;
    decision: string;
    reasoning: string;
    context: Record<string, unknown>;
  }>;
}

export interface EnvoyHealthResponse {
  status: "healthy" | "degraded";
  service: string;
  hostname: string;
  os: string;
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
// Retry with exponential backoff
// ---------------------------------------------------------------------------

interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  retryableStatuses: Set<number>;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: Number(process.env.SYNTH_ENVOY_MAX_RETRIES ?? 3),
  baseDelayMs: 1000,
  retryableStatuses: new Set([502, 503, 504]),
};

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("fetch failed") ||
    msg.includes("abort") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("network")
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  opts: RetryOptions = DEFAULT_RETRY,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      // If retryable status code and we have retries left, retry
      if (opts.retryableStatuses.has(response.status) && attempt < opts.maxRetries) {
        const delay = opts.baseDelayMs * Math.pow(2, attempt);
        console.log(`[envoy-client] Retryable HTTP ${response.status} on attempt ${attempt + 1}/${opts.maxRetries + 1}, retrying in ${delay}ms`);
        serverWarn(`HTTP-RETRY`, { url, status: response.status, attempt: attempt + 1, maxAttempts: opts.maxRetries + 1, delayMs: delay });
        await sleep(delay);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (isTransientError(err) && attempt < opts.maxRetries) {
        const delay = opts.baseDelayMs * Math.pow(2, attempt);
        console.log(`[envoy-client] Transient error on attempt ${attempt + 1}/${opts.maxRetries + 1}: ${lastError.message}, retrying in ${delay}ms`);
        serverWarn(`TRANSIENT-RETRY`, { url, error: lastError.message, attempt: attempt + 1, maxAttempts: opts.maxRetries + 1, delayMs: delay });
        await sleep(delay);
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error("Retry exhausted");
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

  get url(): string { return this.baseUrl; }

  /**
   * Check Envoy health — used as the ServiceHealthChecker for the
   * Command Agent's pre-flight health check step.
   */
  async checkHealth(): Promise<EnvoyHealthResponse> {
    serverLog("ENVOY-HEALTH-CHECK", { url: this.baseUrl });
    const start = Date.now();
    const response = await fetchWithRetry(
      `${this.baseUrl}/health`,
      {},
      this.timeoutMs,
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const result = (await response.json()) as EnvoyHealthResponse;
    serverLog("ENVOY-HEALTH-OK", { url: this.baseUrl, status: result.status, ready: result.readiness.ready, durationMs: Date.now() - start });
    return result;
  }

  /**
   * Send a deployment instruction to the Envoy and wait for the result.
   */
  async deploy(instruction: {
    operationId: string;
    partitionId: string;
    environmentId: string;
    version: string;
    variables: Record<string, string>;
    environmentName: string;
    partitionName: string;
    progressCallbackUrl?: string;
  }): Promise<EnvoyDeployResult> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/deploy`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(instruction),
      },
      this.timeoutMs * 3,
    );

    return (await response.json()) as EnvoyDeployResult;
  }

  /**
   * Dispatch an approved plan to the Envoy for deterministic execution.
   */
  async executeApprovedPlan(params: {
    operationId: string;
    plan: DeploymentPlan;
    rollbackPlan: DeploymentPlan;
    artifactType: string;
    artifactName: string;
    environmentId: string;
    progressCallbackUrl?: string;
    callbackToken?: string;
  }): Promise<EnvoyDeployResult> {
    serverLog("ENVOY-EXECUTE", { operationId: params.operationId, envoyUrl: this.baseUrl, artifact: params.artifactName, steps: params.plan?.steps?.length ?? 0 });
    const execStart = Date.now();
    const response = await fetchWithRetry(
      `${this.baseUrl}/execute`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      },
      this.timeoutMs * 6, // execution may take longer
    );

    const execResult = (await response.json()) as EnvoyDeployResult;
    if (execResult.success) {
      serverLog("ENVOY-EXECUTE-COMPLETE", { operationId: params.operationId, durationMs: Date.now() - execStart });
    } else {
      serverLog("ENVOY-EXECUTE-FAILED", { operationId: params.operationId, failureReason: execResult.failureReason, durationMs: Date.now() - execStart });
    }
    return execResult;
  }

  /**
   * Ask the Envoy to produce a deployment plan (read-only reasoning phase).
   * Returns the plan and rollback plan; the server then submits them to
   * POST /api/deployments/:id/plan to move the deployment to awaiting_approval.
   */
  async requestPlan(params: {
    operationId: string;
    operationType?: "deploy" | "query" | "investigate";
    intent?: string;
    allowWrite?: boolean;
    artifact?: {
      id: string;
      name: string;
      type: string;
      analysis: {
        summary: string;
        dependencies: string[];
        configurationExpectations: Record<string, string>;
        deploymentIntent?: string;
        confidence: number;
      };
    };
    environment: {
      id: string;
      name: string;
      variables: Record<string, string>;
    };
    partition?: {
      id: string;
      name: string;
      variables: Record<string, string>;
    };
    version: string;
    resolvedVariables: Record<string, string>;
    refinementFeedback?: string;
  }): Promise<{
    plan: DeploymentPlan;
    rollbackPlan: DeploymentPlan;
    delta?: string;
    assessmentSummary?: string;
    blocked?: boolean;
    blockReason?: string;
    queryFindings?: { targetsSurveyed: string[]; summary: string; findings: Array<{ target: string; observations: string[] }> };
    investigationFindings?: { targetsSurveyed: string[]; summary: string; findings: Array<{ target: string; observations: string[] }>; rootCause?: string; proposedResolution?: { intent: string; operationType: string; parameters?: Record<string, unknown> } };
  }> {
    // Forward the LLM API key so the Envoy can use it if it started without one.
    // Sent in the request body (not headers) over the trusted server↔envoy channel.
    serverLog("ENVOY-PLAN-REQUEST", { operationId: params.operationId, envoyUrl: this.baseUrl, artifact: params.artifact?.name, version: params.version, environment: params.environment.name });
    const llmApiKey = process.env.SYNTH_LLM_API_KEY;
    const planStart = Date.now();
    const response = await fetchWithRetry(
      `${this.baseUrl}/plan`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(llmApiKey ? { ...params, llmApiKey } : params),
      },
      this.timeoutMs * 18, // planning may take time (probe loop + LLM reasoning)
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      serverLog("ENVOY-PLAN-FAILED", { operationId: params.operationId, status: response.status, durationMs: Date.now() - planStart });
      throw new Error(`Envoy planning failed (HTTP ${response.status}): ${body}`);
    }

    const planResult = (await response.json()) as Awaited<ReturnType<typeof this.requestPlan>>;
    serverLog("ENVOY-PLAN-RECEIVED", { operationId: params.operationId, steps: planResult.plan?.steps?.length ?? 0, blocked: planResult.blocked ?? false, durationMs: Date.now() - planStart });
    return planResult;
  }

  /**
   * Ask the Envoy to generate a rollback plan for a deployment that has
   * already executed. Uses the execution record (what actually ran) rather
   * than the forward plan, so the rollback is targeted to what actually changed.
   */
  async requestRollbackPlan(params: {
    operationId: string;
    artifact: {
      name: string;
      type: string;
      analysis: {
        summary: string;
        dependencies: string[];
        configurationExpectations: Record<string, string>;
        deploymentIntent?: string;
        confidence: number;
      };
    };
    environment: { id: string; name: string };
    completedSteps: Array<{
      description: string;
      action: string;
      target: string;
      status: "completed" | "failed" | "rolled_back";
      output?: string;
    }>;
    deployedVariables: Record<string, string>;
    version: string;
    failureReason?: string;
  }): Promise<DeploymentPlan> {
    const llmApiKey = process.env.SYNTH_LLM_API_KEY;
    const response = await fetchWithRetry(
      `${this.baseUrl}/rollback-plan`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(llmApiKey ? { ...params, llmApiKey } : params),
      },
      this.timeoutMs * 18, // LLM reasoning may take time
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Envoy rollback planning failed (HTTP ${response.status}): ${body}`);
    }

    const data = (await response.json()) as { rollbackPlan: DeploymentPlan };
    return data.rollbackPlan;
  }

  /**
   * Validate a modified plan against the Envoy's security boundaries.
   */
  async validatePlan(steps: PlannedStep[]): Promise<{ valid: boolean; violations: Array<{ step: string; reason: string }> }> {
    const response = await fetchWithRetry(
      `${this.baseUrl}/validate-plan`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps }),
      },
      this.timeoutMs,
    );

    return (await response.json()) as { valid: boolean; violations: Array<{ step: string; reason: string }> };
  }

  /**
   * Ask the Envoy to validate whether user refinement feedback warrants a
   * full replan. Cheap LLM call — no probe loop, no environment scanning.
   * Always falls through to allow the replan if the call fails.
   */
  async validateRefinementFeedback(params: {
    feedback: string;
    currentPlanSteps: Array<{ description: string; action: string; target: string }>;
    artifactName: string;
    environmentName: string;
  }): Promise<{ mode: "replan" | "rejection" | "response"; message: string }> {
    const llmApiKey = process.env.SYNTH_LLM_API_KEY;
    const response = await fetchWithRetry(
      `${this.baseUrl}/validate-refinement`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(llmApiKey ? { ...params, llmApiKey } : params),
      },
      this.timeoutMs * 3,
    );
    return (await response.json()) as { mode: "replan" | "rejection" | "response"; message: string };
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

    serverLog("HEALTH-CHECK", { serviceId, url: client.url });
    const start = Date.now();

    try {
      const health = await client.checkHealth();
      const responseTimeMs = Date.now() - start;

      if (health.status === "healthy" && health.readiness.ready) {
        serverLog("HEALTH-OK", { serviceId, responseTimeMs });
        return { reachable: true, responseTimeMs, error: null };
      }

      serverWarn("HEALTH-DEGRADED", { serviceId, responseTimeMs, status: health.status, reason: health.readiness.reason });
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
        serverError("HEALTH-TIMEOUT", { serviceId, responseTimeMs });
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
        serverError("HEALTH-REFUSED", { serviceId, responseTimeMs, url: client.url });
        return {
          reachable: false,
          responseTimeMs,
          error: `ECONNREFUSED: Envoy at ${serviceId} is not responding`,
        };
      }

      serverError("HEALTH-ERROR", { serviceId, responseTimeMs, error: message });
      return {
        reachable: false,
        responseTimeMs,
        error: `Envoy health check failed: ${message}`,
      };
    }
  }
}
