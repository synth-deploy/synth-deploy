import { describe, it, expect, beforeEach } from "vitest";
import { DecisionDebrief, PartitionStore, EnvironmentStore, ArtifactStore } from "@synth-deploy/core";
import type { Partition, Environment, DebriefEntry } from "@synth-deploy/core";
import {
  CommandAgent,
  InMemoryDeploymentStore,
} from "../src/agent/command-agent.js";
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

function findDecisions(entries: DebriefEntry[], substr: string): DebriefEntry[] {
  return entries.filter((e) =>
    e.decision.toLowerCase().includes(substr.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let diary: DecisionDebrief;
let deployments: InMemoryDeploymentStore;
let healthChecker: MockHealthChecker;
let artifactStore: ArtifactStore;
let environmentStore: EnvironmentStore;
let partitionStore: PartitionStore;
let agent: CommandAgent;

/** Seed a minimal artifact in the store for testing. */
function seedArtifact(name = "web-app") {
  return artifactStore.create({
    name,
    type: "nodejs",
    analysis: {
      summary: "Test artifact",
      dependencies: [],
      configurationExpectations: {},
      deploymentIntent: "rolling",
      confidence: 0.9,
    },
    annotations: [],
    learningHistory: [],
  });
}

/** Seed an environment and return it (also registered in the store). */
function seedEnvironment(name = "production", variables: Record<string, string> = {}) {
  return environmentStore.create(name, variables);
}

/** Seed a partition and return it (also registered in the store). */
function seedPartition(name = "Acme Corp", variables: Record<string, string> = {}) {
  return partitionStore.create(name, variables);
}

/**
 * Build a deployment trigger from seeded entities.
 */
function makeTrigger(opts: {
  artifact?: { id: string };
  partition?: { id: string };
  environment?: { id: string };
  version?: string;
  variables?: Record<string, string>;
}) {
  return {
    artifactId: opts.artifact?.id ?? "",
    artifactVersionId: opts.version ?? "2.0.0",
    partitionId: opts.partition?.id,
    environmentId: opts.environment?.id ?? "",
    triggeredBy: "user" as const,
    ...(opts.variables ? { variables: opts.variables } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Deployment Orchestration Engine", () => {
  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    artifactStore = new ArtifactStore();
    environmentStore = new EnvironmentStore();
    partitionStore = new PartitionStore();
    agent = new CommandAgent(
      diary, deployments, artifactStore, environmentStore, partitionStore,
      healthChecker, { healthCheckBackoffMs: 1, executionDelayMs: 1 },
    );
  });

  // -----------------------------------------------------------------------
  // Scenario 1: Successful deployment with variable resolution
  // -----------------------------------------------------------------------

  describe("successful deployment with variable resolution", () => {
    it("resolves variables, executes full pipeline, and records every decision", async () => {
      const artifact = seedArtifact();
      const partition = seedPartition("Acme Corp", { APP_ENV: "production", DB_HOST: "acme-db-1" });
      const env = seedEnvironment("production", { APP_ENV: "production", LOG_LEVEL: "warn" });

      healthChecker.willReturn(HEALTHY);

      const trigger = makeTrigger({
        artifact, partition, environment: env,
        variables: { LOG_LEVEL: "error" },
      });
      const result = await agent.triggerDeployment(trigger);

      expect(result.status).toBe("succeeded");
      expect(result.completedAt).not.toBeUndefined();

      // Variables resolved with correct precedence
      expect(result.variables).toEqual({
        APP_ENV: "production",
        LOG_LEVEL: "error",     // trigger > environment
        DB_HOST: "acme-db-1",   // partition-only
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
      expect(findDecisions(entries, "Accepted configuration")).toHaveLength(1);
      expect(findDecisions(entries, "Marking deployment of")).toHaveLength(1);
    });

    it("handles deployment with no variable conflicts", async () => {
      const artifact = seedArtifact();
      const partition = seedPartition("Acme Corp", { PARTITION_SPECIFIC: "abc" });
      const env = seedEnvironment("production", { ENV_SPECIFIC: "xyz" });

      healthChecker.willReturn(HEALTHY);

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

      expect(result.status).toBe("succeeded");
      expect(result.variables).toEqual({
        ENV_SPECIFIC: "xyz",
        PARTITION_SPECIFIC: "abc",
      });

      const entries = diary.getByDeployment(result.id);
      const completion = findDecisions(entries, "Marking deployment of")[0];
      expect(completion.reasoning).toContain("No variable conflicts");
    });
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Service not responding — error-type-dependent reasoning
  // -----------------------------------------------------------------------

  describe("service not responding", () => {
    it("connection refused → retries, then fails with actionable reasoning", async () => {
      healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);

      const artifact = seedArtifact();
      const partition = seedPartition();
      const env = seedEnvironment("staging");

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

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

      const artifact = seedArtifact();
      const partition = seedPartition();
      const env = seedEnvironment("staging");

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

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
      healthChecker.willReturn(TIMEOUT, TIMEOUT);

      const artifact = seedArtifact();
      const partition = seedPartition();
      const env = seedEnvironment("production");

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

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

      const artifact = seedArtifact();
      const partition = seedPartition();
      const env = seedEnvironment("staging");

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

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

      const artifact = seedArtifact();
      const partition = seedPartition();
      const env = seedEnvironment("production");

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

      expect(result.status).toBe("succeeded");

      const entries = diary.getByDeployment(result.id);
      const recoveryEntries = findDecisions(entries, "recovered on retry");
      expect(recoveryEntries).toHaveLength(1);
      expect(recoveryEntries[0].reasoning).toContain("transient");
      expect(recoveryEntries[0].reasoning).toContain("confirmed healthy");
    });

    it("server error (503) → retries with appropriate reasoning", async () => {
      healthChecker.willReturn(SERVER_ERROR, HEALTHY);

      const artifact = seedArtifact();
      const partition = seedPartition();
      const env = seedEnvironment("production");

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

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
      const artifact = seedArtifact();
      const partition = seedPartition("Acme Corp", { DB_HOST: "prod-db.internal" });
      const env = seedEnvironment("staging", { DB_HOST: "staging-db.internal" });

      healthChecker.willReturn(HEALTHY);

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

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
      const artifact = seedArtifact();
      const partition = seedPartition("Acme Corp", {
        DB_HOST: "prod-db.internal",
        CACHE_HOST: "prod-cache:6379",
      });
      const env = seedEnvironment("staging", {
        DB_HOST: "staging-db.internal",
        CACHE_HOST: "staging-cache:6379",
      });

      healthChecker.willReturn(HEALTHY);

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

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
      const artifact = seedArtifact();
      const partition = seedPartition("Acme Corp", { APP_LABEL: "production-canary" });
      const env = seedEnvironment("staging", { APP_LABEL: "staging-primary" });

      healthChecker.willReturn(HEALTHY);

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

      // Non-connectivity cross-env → proceeds (can't route traffic)
      expect(result.status).toBe("succeeded");
    });

    it("sensitive variable overrides → audit logging without values", async () => {
      const artifact = seedArtifact();
      const partition = seedPartition("Acme Corp", { API_SECRET: "partition-secret-xyz" });
      const env = seedEnvironment("production", { API_SECRET: "default-env-secret" });

      healthChecker.willReturn(HEALTHY);

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

      expect(result.status).toBe("succeeded");
      expect(result.variables.API_SECRET).toBe("partition-secret-xyz");

      const entries = diary.getByDeployment(result.id);
      const sensitiveEntries = findDecisions(entries, "Security-sensitive");
      expect(sensitiveEntries).toHaveLength(1);
      expect(sensitiveEntries[0].reasoning).toContain("audit");

      // Values must NOT appear in context
      const contextStr = JSON.stringify(sensitiveEntries[0].context);
      expect(contextStr).not.toContain("partition-secret-xyz");
      expect(contextStr).not.toContain("default-env-secret");
    });
  });

  // -----------------------------------------------------------------------
  // Decision trail completeness
  // -----------------------------------------------------------------------

  describe("decision trail", () => {
    it("every diary entry has partition isolation via partitionId", async () => {
      const artifact = seedArtifact();
      const partition = seedPartition("Isolated Partition");
      const env = seedEnvironment("production");

      healthChecker.willReturn(HEALTHY);

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);
      const entries = diary.getByDeployment(result.id);

      for (const entry of entries) {
        expect(entry.partitionId).toBe(partition.id);
      }

      const partitionEntries = diary.getByPartition(partition.id);
      // Partition entries include all deployment-scoped entries
      expect(partitionEntries.length).toBeGreaterThanOrEqual(entries.length);
    });

    it("failed deployment trail includes the failing step", async () => {
      healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);

      const artifact = seedArtifact();
      const partition = seedPartition();
      const env = seedEnvironment("production");

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

      expect(result.status).toBe("failed");

      for (const entryId of result.debriefEntryIds) {
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

      const artifact = seedArtifact();
      const partition = seedPartition();
      const env = seedEnvironment("production");

      const trigger = makeTrigger({ artifact, partition, environment: env });
      const result = await agent.triggerDeployment(trigger);

      const stored = deployments.get(result.id);
      expect(stored).toBeDefined();
      expect(stored!.status).toBe("succeeded");
      expect(stored!.variables).toEqual(result.variables);
    });
  });
});
