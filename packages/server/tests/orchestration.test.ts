import { describe, it, expect, beforeEach } from "vitest";
import { DecisionDiary } from "@deploystack/core";
import type { Tenant, Environment, DiaryEntry } from "@deploystack/core";
import {
  ServerAgent,
  InMemoryDeploymentStore,
} from "../src/agent/server-agent.js";
import type { ServiceHealthChecker, HealthCheckResult } from "../src/agent/health-checker.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Mock health checker that returns pre-configured results in order.
 * Falls back to "healthy" when the queue is exhausted.
 */
class MockHealthChecker implements ServiceHealthChecker {
  private responses: HealthCheckResult[] = [];
  public callCount = 0;

  /** Queue one or more health check results to be returned in order. */
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

const UNREACHABLE: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "Connection refused",
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

/** Find diary entries matching a substring in the decision field. */
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
      healthCheckBackoffMs: 1, // Keep tests fast
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

      // Deployment succeeded
      expect(result.status).toBe("succeeded");
      expect(result.failureReason).toBeNull();
      expect(result.completedAt).not.toBeNull();

      // Variables resolved with correct precedence
      expect(result.variables).toEqual({
        APP_ENV: "production",  // same at both levels, no conflict
        LOG_LEVEL: "error",     // trigger > environment
        DB_HOST: "acme-db-1",   // tenant-only, no conflict
      });

      // Diary records every pipeline step
      const entries = diary.getByDeployment(result.id);
      expect(entries.length).toBeGreaterThanOrEqual(5);

      // Pipeline plan recorded
      const planEntries = findDecisions(entries, "pipeline");
      expect(planEntries).toHaveLength(1);
      expect(planEntries[0].context).toHaveProperty("steps");

      // Configuration resolved
      const configEntries = findDecisions(entries, "Configuration resolved");
      expect(configEntries).toHaveLength(1);

      // Health check passed
      const healthEntries = findDecisions(entries, "health check passed");
      expect(healthEntries).toHaveLength(1);

      // Deployment executed
      const execEntries = findDecisions(entries, "Executing deployment");
      expect(execEntries).toHaveLength(1);

      // Post-deploy verified
      const verifyEntries = findDecisions(entries, "Post-deployment verification");
      expect(verifyEntries).toHaveLength(1);

      // Completion recorded
      const completionEntries = findDecisions(entries, "completed successfully");
      expect(completionEntries).toHaveLength(1);

      // Every entry has both a decision and reasoning
      for (const entry of entries) {
        expect(entry.decision.length).toBeGreaterThan(0);
        expect(entry.reasoning.length).toBeGreaterThan(0);
      }
    });

    it("handles deployment with no variable conflicts", async () => {
      const tenant = makeTenant({
        variables: { TENANT_SPECIFIC: "abc" },
      });
      const env = makeEnvironment({
        variables: { ENV_SPECIFIC: "xyz" },
      });
      const trigger = makeTrigger();

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(trigger, tenant, env);

      expect(result.status).toBe("succeeded");
      expect(result.variables).toEqual({
        ENV_SPECIFIC: "xyz",
        TENANT_SPECIFIC: "abc",
      });

      // Should note "no variable conflicts" in completion
      const entries = diary.getByDeployment(result.id);
      const completion = findDecisions(entries, "completed successfully")[0];
      expect(completion.reasoning).toContain("No variable conflicts");
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Service not responding — health check failure
  // -----------------------------------------------------------------------

  describe("service not responding", () => {
    it("retries health check, then fails with actionable reasoning", async () => {
      healthChecker.willReturn(UNREACHABLE, UNREACHABLE);

      const tenant = makeTenant();
      const env = makeEnvironment({ name: "staging" });
      const trigger = makeTrigger({ environmentId: "env-staging" });

      const result = await agent.triggerDeployment(trigger, tenant, env);

      // Deployment failed
      expect(result.status).toBe("failed");
      expect(result.failureReason).toContain("unreachable");

      // Health checker was called twice (initial + 1 retry)
      expect(healthChecker.callCount).toBe(2);

      const entries = diary.getByDeployment(result.id);

      // Should have recorded: initial failure + retry decision
      const retryEntries = findDecisions(entries, "attempting retry");
      expect(retryEntries).toHaveLength(1);
      expect(retryEntries[0].reasoning).toContain("starting up");
      expect(retryEntries[0].reasoning).toContain("transient");

      // Final failure should explain what happened and what to do
      const failEntries = findDecisions(entries, "Deployment failed");
      expect(failEntries).toHaveLength(1);
      expect(failEntries[0].reasoning).toContain("persistent");
      expect(failEntries[0].reasoning).toContain("Recommended action");
      expect(failEntries[0].reasoning).toContain("re-trigger");

      // Failure reasoning is specific, not generic
      expect(failEntries[0].reasoning.length).toBeGreaterThan(100);
    });

    it("recovers on retry and completes deployment", async () => {
      // First check fails, retry succeeds
      healthChecker.willReturn(UNREACHABLE, HEALTHY);

      const tenant = makeTenant();
      const env = makeEnvironment();
      const trigger = makeTrigger();

      const result = await agent.triggerDeployment(trigger, tenant, env);

      // Deployment succeeded despite initial health check failure
      expect(result.status).toBe("succeeded");

      const entries = diary.getByDeployment(result.id);

      // Should show the failure
      const retryEntries = findDecisions(entries, "attempting retry");
      expect(retryEntries).toHaveLength(1);

      // Should show the recovery
      const recoveryEntries = findDecisions(entries, "recovered on retry");
      expect(recoveryEntries).toHaveLength(1);
      expect(recoveryEntries[0].reasoning).toContain("transient");
      expect(recoveryEntries[0].reasoning).toContain("confirmed healthy");

      // And the final success
      const completionEntries = findDecisions(entries, "completed successfully");
      expect(completionEntries).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 3: Cross-environment variable conflicts
  // -----------------------------------------------------------------------

  describe("cross-environment variable conflicts", () => {
    it("detects production-pattern values in staging deployment and reasons through them", async () => {
      // Tenant has production DB, but deploying to staging
      const tenant = makeTenant({
        variables: { DB_HOST: "prod-db.internal", CACHE_HOST: "prod-cache:6379" },
      });
      const env = makeEnvironment({
        id: "env-staging",
        name: "staging",
        variables: { DB_HOST: "staging-db.internal", CACHE_HOST: "staging-cache:6379" },
      });
      const trigger = makeTrigger({ environmentId: "env-staging" });

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(trigger, tenant, env);

      // Deployment still succeeds — the agent reasons through it
      expect(result.status).toBe("succeeded");

      // Variables use tenant precedence
      expect(result.variables.DB_HOST).toBe("prod-db.internal");
      expect(result.variables.CACHE_HOST).toBe("prod-cache:6379");

      const entries = diary.getByDeployment(result.id);

      // Cross-environment pattern detected and reasoned about
      const crossEnvEntries = findDecisions(entries, "Cross-environment");
      expect(crossEnvEntries).toHaveLength(1);

      const reasoning = crossEnvEntries[0].reasoning;
      // Reasoning should mention the conflict
      expect(reasoning).toContain("prod-db.internal");
      expect(reasoning).toContain("staging");
      // Reasoning should consider both explanations
      expect(reasoning).toContain("intentional");
      expect(reasoning).toContain("misconfiguration");
      // Reasoning should explain what it did
      expect(reasoning).toContain("precedence");
      // Reasoning should suggest operator verification
      expect(reasoning).toContain("verify");

      // Reasoning is substantial, not terse
      expect(reasoning.length).toBeGreaterThan(100);

      // Context includes structured conflict data
      expect(crossEnvEntries[0].context).toHaveProperty("category", "cross-environment");
      expect(crossEnvEntries[0].context).toHaveProperty("targetEnvironment", "staging");
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 4: Security-sensitive variable overrides
  // -----------------------------------------------------------------------

  describe("security-sensitive variable overrides", () => {
    it("flags sensitive variable overrides with audit-appropriate reasoning", async () => {
      const tenant = makeTenant({
        variables: { API_SECRET: "tenant-secret-xyz" },
      });
      const env = makeEnvironment({
        variables: { API_SECRET: "default-env-secret" },
      });
      const trigger = makeTrigger();

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(trigger, tenant, env);

      expect(result.status).toBe("succeeded");
      // Tenant value wins
      expect(result.variables.API_SECRET).toBe("tenant-secret-xyz");

      const entries = diary.getByDeployment(result.id);

      // Sensitive override recorded
      const sensitiveEntries = findDecisions(entries, "Security-sensitive");
      expect(sensitiveEntries).toHaveLength(1);
      expect(sensitiveEntries[0].reasoning).toContain("audit");

      // Sensitive values should NOT appear in the context (security)
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
      const env = makeEnvironment();
      const trigger = makeTrigger({ tenantId: "isolated-tenant" });

      healthChecker.willReturn(HEALTHY);

      const result = await agent.triggerDeployment(trigger, tenant, env);
      const entries = diary.getByDeployment(result.id);

      for (const entry of entries) {
        expect(entry.tenantId).toBe("isolated-tenant");
      }

      // Entries are also retrievable by tenant
      const tenantEntries = diary.getByTenant("isolated-tenant");
      expect(tenantEntries.length).toBe(entries.length);
    });

    it("failed deployment has complete trail including failure step", async () => {
      healthChecker.willReturn(UNREACHABLE, UNREACHABLE);

      const tenant = makeTenant();
      const env = makeEnvironment();
      const trigger = makeTrigger();

      const result = await agent.triggerDeployment(trigger, tenant, env);

      expect(result.status).toBe("failed");

      // Every diary entry ID on the deployment is valid
      for (const entryId of result.diaryEntryIds) {
        const entry = diary.getById(entryId);
        expect(entry).toBeDefined();
        expect(entry!.deploymentId).toBe(result.id);
      }

      // The failure entry includes the step that failed
      const entries = diary.getByDeployment(result.id);
      const failEntry = findDecisions(entries, "Deployment failed")[0];
      expect(failEntry.context).toHaveProperty("step", "preflight-health-check");
    });

    it("deployment store persists the final state", async () => {
      healthChecker.willReturn(HEALTHY);

      const tenant = makeTenant();
      const env = makeEnvironment();
      const trigger = makeTrigger();

      const result = await agent.triggerDeployment(trigger, tenant, env);

      // Retrievable from the store
      const stored = deployments.get(result.id);
      expect(stored).toBeDefined();
      expect(stored!.status).toBe("succeeded");
      expect(stored!.variables).toEqual(result.variables);
    });
  });
});
