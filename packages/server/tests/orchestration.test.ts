import { describe, it, expect, beforeEach } from "vitest";
import { DecisionDiary } from "@deploystack/core";
import type { Tenant, Environment, DiaryEntry } from "@deploystack/core";
import {
  ServerAgent,
  InMemoryDeploymentStore,
} from "../src/agent/server-agent.js";
import type {
  ServiceHealthChecker,
  HealthCheckResult,
} from "../src/agent/health-checker.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class MockHealthChecker implements ServiceHealthChecker {
  private responses: HealthCheckResult[] = [];
  public callCount = 0;

  willReturn(...results: HealthCheckResult[]): void {
    this.responses.push(...results);
  }

  async check(): Promise<HealthCheckResult> {
    this.callCount++;
    const next = this.responses.shift();
    if (next) return next;
    return { reachable: true, responseTimeMs: 1, error: null };
  }
}

const HEALTHY: HealthCheckResult = {
  reachable: true,
  responseTimeMs: 5,
  error: null,
};

const CONN_REFUSED: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "ECONNREFUSED: Connection refused",
};

const DNS_FAILURE: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "ENOTFOUND: DNS lookup failed for staging.internal",
};

const TIMEOUT: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "ETIMEDOUT: Request timed out after 5000ms",
};

const SERVER_ERROR: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "HTTP 503 Service Unavailable",
};

function makeTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: "tenant-1",
    name: "Acme Corp",
    variables: {},
    createdAt: new Date(),
    ...overrides,
  };
}

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-prod",
    name: "production",
    variables: {},
    ...overrides,
  };
}

function makeTrigger(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "web-app",
    tenantId: "tenant-1",
    environmentId: "env-prod",
    version: "2.0.0",
    ...overrides,
  };
}

function findDecisions(entries: DiaryEntry[], substr: string): DiaryEntry[] {
  return entries.filter((e) =>
    e.decision.toLowerCase().includes(substr.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Deployment Orchestration Engine", () => {
  let diary: DecisionDiary;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: ServerAgent;

  beforeEach(() => {
    diary = new DecisionDiary();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new ServerAgent(diary, deployments, healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 1: Successful deployment with variable resolution
  // -----------------------------------------------------------------------

  describe("successful deployment with variable resolution", () => {
    it("resolves variables, executes full pipeline, and records every decision", async () => {
      const tenant = makeTenant({
        variables: { APP_ENV: "production", DB_HOST: "acme-db-1" },
      });
      const env = makeEnvironment({
        variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
      });
      const trigger = makeTrigger({
        variables: { LOG_LEVEL: "error" },
      });

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(trigger, tenant, env);

      expect(result.status).toBe("succeeded");
      expect(result.failureReason).toBeNull();
      expect(result.completedAt).not.toBeNull();

      // Variables resolved with correct precedence
      expect(result.variables).toEqual({
        APP_ENV: "production",
        LOG_LEVEL: "error",     // trigger > environment
        DB_HOST: "acme-db-1",   // tenant-only
      });

      // Diary records every pipeline step
      const entries = diary.getByDeployment(result.id);
      expect(entries.length).toBeGreaterThanOrEqual(5);

      // Each entry has a real decision and reasoning
      for (const entry of entries) {
        expect(entry.decision.length).toBeGreaterThan(0);
        expect(entry.reasoning.length).toBeGreaterThan(0);
      }

      // Key pipeline milestones present
      expect(findDecisions(entries, "pipeline")).toHaveLength(1);
      expect(findDecisions(entries, "Configuration resolved")).toHaveLength(1);
      expect(findDecisions(entries, "health check passed")).toHaveLength(1);
      expect(findDecisions(entries, "Executing deployment")).toHaveLength(1);
      expect(findDecisions(entries, "completed successfully")).toHaveLength(1);
    });

    it("handles deployment with no variable conflicts", async () => {
      const tenant = makeTenant({ variables: { TENANT_SPECIFIC: "abc" } });
      const env = makeEnvironment({ variables: { ENV_SPECIFIC: "xyz" } });

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(makeTrigger(), tenant, env);

      expect(result.status).toBe("succeeded");
      expect(result.variables).toEqual({
        ENV_SPECIFIC: "xyz",
        TENANT_SPECIFIC: "abc",
      });

      const entries = diary.getByDeployment(result.id);
      const completion = findDecisions(entries, "completed successfully")[0];
      expect(completion.reasoning).toContain("No variable conflicts");
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Service not responding — error-type-dependent reasoning
  // -----------------------------------------------------------------------

  describe("service not responding", () => {
    it("connection refused → retries, then fails with actionable reasoning", async () => {
      healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        makeTenant(),
        makeEnvironment({ name: "staging" }),
      );

      expect(result.status).toBe("failed");
      expect(result.failureReason).toContain("unreachable");

      // Should have retried (initial + 1 retry = 2 calls)
      expect(healthChecker.callCount).toBe(2);

      const entries = diary.getByDeployment(result.id);
      const retryEntries = findDecisions(entries, "attempting retry");
      expect(retryEntries).toHaveLength(1);
      expect(retryEntries[0].reasoning).toContain("restarting");

      // Final failure is specific
      const failEntries = findDecisions(entries, "Deployment failed");
      expect(failEntries).toHaveLength(1);
      expect(failEntries[0].reasoning).toContain("persistent");
      expect(failEntries[0].reasoning).toContain("Recommended action");
    });

    it("DNS failure → aborts immediately without retrying", async () => {
      healthChecker.willReturn(DNS_FAILURE);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        makeTenant(),
        makeEnvironment({ name: "staging" }),
      );

      expect(result.status).toBe("failed");

      // Only called once — no retry for DNS errors
      expect(healthChecker.callCount).toBe(1);

      const entries = diary.getByDeployment(result.id);

      // Should have decided NOT to retry
      const abortEntries = findDecisions(entries, "aborting without retry");
      expect(abortEntries).toHaveLength(1);
      expect(abortEntries[0].reasoning).toContain("DNS");
      expect(abortEntries[0].reasoning).toContain("not a transient failure");
      expect(abortEntries[0].context).toHaveProperty("retriesSkipped", true);
      expect(abortEntries[0].context).toHaveProperty("errorCategory", "dns");

      // No retry entries should exist
      const retryEntries = findDecisions(entries, "attempting retry");
      expect(retryEntries).toHaveLength(0);
    });

    it("timeout in production → retries with extended backoff", async () => {
      // Track the delay used by capturing the reasoning
      healthChecker.willReturn(TIMEOUT, TIMEOUT);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        makeTenant(),
        makeEnvironment({ name: "production" }),
      );

      expect(result.status).toBe("failed");

      const entries = diary.getByDeployment(result.id);
      const retryEntries = findDecisions(entries, "attempting retry");
      expect(retryEntries).toHaveLength(1);

      // Reasoning should mention production-specific extended backoff
      expect(retryEntries[0].reasoning).toContain("production");
      expect(retryEntries[0].reasoning).toContain("extended backoff");
      expect(retryEntries[0].reasoning).toContain("heavy load");

      // Backoff should be 2x normal (2ms instead of 1ms with our test config)
      expect(retryEntries[0].context).toHaveProperty("backoffMs", 2);
    });

    it("timeout in staging → retries with standard backoff (not extended)", async () => {
      healthChecker.willReturn(TIMEOUT, TIMEOUT);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        makeTenant(),
        makeEnvironment({ name: "staging" }),
      );

      expect(result.status).toBe("failed");

      const entries = diary.getByDeployment(result.id);
      const retryEntries = findDecisions(entries, "attempting retry");
      expect(retryEntries).toHaveLength(1);

      // Staging should NOT get extended backoff
      expect(retryEntries[0].reasoning).not.toContain("extended backoff");
      expect(retryEntries[0].context).toHaveProperty("backoffMs", 1);
    });

    it("recovery on retry → completes deployment", async () => {
      healthChecker.willReturn(CONN_REFUSED, HEALTHY);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        makeTenant(),
        makeEnvironment(),
      );

      expect(result.status).toBe("succeeded");

      const entries = diary.getByDeployment(result.id);
      const recoveryEntries = findDecisions(entries, "recovered on retry");
      expect(recoveryEntries).toHaveLength(1);
      expect(recoveryEntries[0].reasoning).toContain("transient");
      expect(recoveryEntries[0].reasoning).toContain("confirmed healthy");
    });

    it("server error (503) → retries with appropriate reasoning", async () => {
      healthChecker.willReturn(SERVER_ERROR, HEALTHY);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        makeTenant(),
        makeEnvironment(),
      );

      expect(result.status).toBe("succeeded");

      const entries = diary.getByDeployment(result.id);
      const retryEntries = findDecisions(entries, "attempting retry");
      expect(retryEntries).toHaveLength(1);
      // Server errors get different reasoning than connection refused
      expect(retryEntries[0].reasoning).toContain("unhealthy");
      expect(retryEntries[0].reasoning).toContain("upstream dependency");
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 3: Variable conflicts — different outcomes based on risk
  // -----------------------------------------------------------------------

  describe("variable conflict reasoning", () => {
    it("single cross-env connectivity var → proceeds with warning", async () => {
      const tenant = makeTenant({
        variables: { DB_HOST: "prod-db.internal" },
      });
      const env = makeEnvironment({
        id: "env-staging",
        name: "staging",
        variables: { DB_HOST: "staging-db.internal" },
      });

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(
        makeTrigger({ environmentId: "env-staging" }),
        tenant,
        env,
      );

      // Single override → agent proceeds (might be intentional)
      expect(result.status).toBe("succeeded");
      expect(result.variables.DB_HOST).toBe("prod-db.internal");

      const entries = diary.getByDeployment(result.id);
      const crossEnvEntries = findDecisions(entries, "Cross-environment");
      expect(crossEnvEntries).toHaveLength(1);

      // Reasoning acknowledges it might be intentional
      expect(crossEnvEntries[0].reasoning).toContain("intentional");
      expect(crossEnvEntries[0].reasoning).toContain("single");
      expect(crossEnvEntries[0].context).toHaveProperty("action", "proceed");
      expect(crossEnvEntries[0].context).toHaveProperty("riskLevel", "medium");
    });

    it("multiple cross-env connectivity vars → BLOCKS deployment", async () => {
      // Two connectivity variables pointing at production from staging
      const tenant = makeTenant({
        variables: {
          DB_HOST: "prod-db.internal",
          CACHE_HOST: "prod-cache:6379",
        },
      });
      const env = makeEnvironment({
        id: "env-staging",
        name: "staging",
        variables: {
          DB_HOST: "staging-db.internal",
          CACHE_HOST: "staging-cache:6379",
        },
      });

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(
        makeTrigger({ environmentId: "env-staging" }),
        tenant,
        env,
      );

      // THIS IS THE KEY BEHAVIORAL DIFFERENCE:
      // Multiple cross-env connectivity overrides → deployment blocked
      expect(result.status).toBe("failed");
      expect(result.failureReason).toContain("high-risk");

      const entries = diary.getByDeployment(result.id);

      // Agent explains WHY it blocked
      const blockEntries = findDecisions(entries, "Blocking deployment");
      expect(blockEntries).toHaveLength(1);
      expect(blockEntries[0].reasoning).toContain("misconfigured");
      expect(blockEntries[0].reasoning).toContain("cross-environment");
      expect(blockEntries[0].context).toHaveProperty("action", "block");
      expect(blockEntries[0].context).toHaveProperty("riskLevel", "high");

      // The failure step is resolve-configuration, not health check
      const failEntries = findDecisions(entries, "Deployment failed");
      expect(failEntries[0].context).toHaveProperty(
        "step",
        "resolve-configuration",
      );
    });

    it("cross-env non-connectivity vars → proceeds (lower risk)", async () => {
      // APP_LABEL contains "prod" but it's not a connectivity variable
      const tenant = makeTenant({
        variables: { APP_LABEL: "production-canary" },
      });
      const env = makeEnvironment({
        name: "staging",
        variables: { APP_LABEL: "staging-primary" },
      });

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        tenant,
        env,
      );

      // Non-connectivity cross-env → proceeds (can't route traffic)
      expect(result.status).toBe("succeeded");
    });

    it("sensitive variable overrides → audit logging without values", async () => {
      const tenant = makeTenant({
        variables: { API_SECRET: "tenant-secret-xyz" },
      });
      const env = makeEnvironment({
        variables: { API_SECRET: "default-env-secret" },
      });

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        tenant,
        env,
      );

      expect(result.status).toBe("succeeded");
      expect(result.variables.API_SECRET).toBe("tenant-secret-xyz");

      const entries = diary.getByDeployment(result.id);
      const sensitiveEntries = findDecisions(entries, "Security-sensitive");
      expect(sensitiveEntries).toHaveLength(1);
      expect(sensitiveEntries[0].reasoning).toContain("audit");

      // Values must NOT appear in context
      const contextStr = JSON.stringify(sensitiveEntries[0].context);
      expect(contextStr).not.toContain("tenant-secret-xyz");
      expect(contextStr).not.toContain("default-env-secret");
    });
  });

  // -----------------------------------------------------------------------
  // Decision trail completeness
  // -----------------------------------------------------------------------

  describe("decision trail", () => {
    it("every diary entry has tenant isolation via tenantId", async () => {
      const tenant = makeTenant({ id: "isolated-tenant" });
      const trigger = makeTrigger({ tenantId: "isolated-tenant" });

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(
        trigger,
        tenant,
        makeEnvironment(),
      );
      const entries = diary.getByDeployment(result.id);

      for (const entry of entries) {
        expect(entry.tenantId).toBe("isolated-tenant");
      }

      const tenantEntries = diary.getByTenant("isolated-tenant");
      expect(tenantEntries.length).toBe(entries.length);
    });

    it("failed deployment trail includes the failing step", async () => {
      healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        makeTenant(),
        makeEnvironment(),
      );

      expect(result.status).toBe("failed");

      for (const entryId of result.diaryEntryIds) {
        const entry = diary.getById(entryId);
        expect(entry).toBeDefined();
        expect(entry!.deploymentId).toBe(result.id);
      }

      const entries = diary.getByDeployment(result.id);
      const failEntry = findDecisions(entries, "Deployment failed")[0];
      expect(failEntry.context).toHaveProperty(
        "step",
        "preflight-health-check",
      );
    });

    it("deployment store persists the final state", async () => {
      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(
        makeTrigger(),
        makeTenant(),
        makeEnvironment(),
      );

      const stored = deployments.get(result.id);
      expect(stored).toBeDefined();
      expect(stored!.status).toBe("succeeded");
      expect(stored!.variables).toEqual(result.variables);
    });
  });
});
