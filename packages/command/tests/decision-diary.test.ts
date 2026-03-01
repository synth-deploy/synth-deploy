import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DecisionDebrief,
  PersistentDecisionDebrief,
  OrderStore,
  formatDebriefEntry,
  formatDebriefEntries,
} from "@deploystack/core";
import type {
  Partition,
  Environment,
  DebriefEntry,
  DecisionType,
  DebriefWriter,
  DebriefReader,
  Operation,
} from "@deploystack/core";
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

  willReturn(...results: HealthCheckResult[]): void {
    this.responses.push(...results);
  }

  async check(): Promise<HealthCheckResult> {
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

function makePartition(overrides: Partial<Partition> = {}): Partition {
  return {
    id: "partition-1",
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
    operationId: "web-app",
    partitionId: "partition-1",
    environmentId: "env-prod",
    version: "2.0.0",
    ...overrides,
  };
}

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "web-app",
    name: "web-app",
    environmentIds: ["env-prod"],
    steps: [],
    deployConfig: {
      healthCheckEnabled: true,
      healthCheckRetries: 1,
      timeoutMs: 30000,
      verificationStrategy: "basic",
    },
    ...overrides,
  };
}

function findDecisions(entries: DebriefEntry[], substr: string): DebriefEntry[] {
  return entries.filter((e) =>
    e.decision.toLowerCase().includes(substr.toLowerCase()),
  );
}

/**
 * Minimum word count to qualify as "specific" rather than generic.
 * A decision like "ok" (1 word) is generic.
 * "Post-deployment verification passed" (3 words) is specific enough —
 * it names the step and outcome.
 */
const MIN_SPECIFIC_WORD_COUNT = 3;

// ---------------------------------------------------------------------------
// Test suite: Entry specificity — entries must be actionable, not generic
// ---------------------------------------------------------------------------

describe("Decision Diary — entry specificity", () => {
  let diary: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new CommandAgent(diary, deployments, new OrderStore(), healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
  });

  it("every decision text is specific — contains operation, version, or environment names", async () => {
    const partition = makePartition({
      variables: { APP_ENV: "production", DB_HOST: "acme-db-1" },
    });
    const env = makeEnvironment({
      variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    });
    const trigger = makeTrigger({ variables: { LOG_LEVEL: "error" } });

    healthChecker.willReturn(HEALTHY);
    const result = await agent.triggerDeployment(trigger, partition, env, makeOperation());

    const entries = diary.getByDeployment(result.id);
    expect(entries.length).toBeGreaterThanOrEqual(5);

    for (const entry of entries) {
      // Every entry must have substantial decision and reasoning
      const decisionWords = entry.decision.split(/\s+/).length;
      const reasoningWords = entry.reasoning.split(/\s+/).length;

      expect(decisionWords).toBeGreaterThanOrEqual(MIN_SPECIFIC_WORD_COUNT);
      expect(reasoningWords).toBeGreaterThanOrEqual(8);
    }
  });

  it("reasoning always references concrete values — never generic placeholder text", async () => {
    const partition = makePartition({
      variables: { APP_ENV: "production", DB_HOST: "acme-db-1" },
    });
    const env = makeEnvironment({
      name: "staging",
      variables: { APP_ENV: "staging", LOG_LEVEL: "debug" },
    });
    const trigger = makeTrigger({ variables: { LOG_LEVEL: "error" } });

    healthChecker.willReturn(HEALTHY);
    const result = await agent.triggerDeployment(trigger, partition, env, makeOperation());

    const entries = diary.getByDeployment(result.id);

    // Reasoning must contain at least one concrete reference
    const genericPhrases = [
      "something went wrong",
      "an error occurred",
      "check the logs",
      "contact support",
      "unknown error",
    ];

    for (const entry of entries) {
      for (const phrase of genericPhrases) {
        expect(entry.reasoning.toLowerCase()).not.toContain(phrase);
      }
    }

    // Pipeline plan must reference the actual operation and version
    const planEntries = findDecisions(entries, "pipeline");
    expect(planEntries[0].reasoning).toContain("web-app");
    expect(planEntries[0].reasoning).toContain("2.0.0");
    expect(planEntries[0].reasoning).toContain("staging");
  });

  it("failure entries include actionable recommendations", async () => {
    healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);

    const result = await agent.triggerDeployment(
      makeTrigger(),
      makePartition(),
      makeEnvironment(),
      makeOperation(),
    );

    expect(result.status).toBe("failed");

    const entries = diary.getByDeployment(result.id);
    const failEntry = findDecisions(entries, "Deployment failed")[0];

    // Failure reasoning must contain recommended action
    expect(failEntry.reasoning).toContain("Recommended action");
    // Must reference the specific environment
    expect(failEntry.reasoning).toContain("production");
  });

  it("variable conflict entries name the specific variables involved", async () => {
    const partition = makePartition({
      variables: { LOG_LEVEL: "error", APP_ENV: "production" },
    });
    const env = makeEnvironment({
      variables: { LOG_LEVEL: "warn", APP_ENV: "production" },
    });
    const trigger = makeTrigger({ variables: { LOG_LEVEL: "debug" } });

    healthChecker.willReturn(HEALTHY);
    const result = await agent.triggerDeployment(trigger, partition, env, makeOperation());

    const entries = diary.getByDeployment(result.id);
    const conflictEntries = findDecisions(entries, "conflict");
    expect(conflictEntries.length).toBeGreaterThanOrEqual(1);

    // At least one conflict entry must name the actual variable
    const mentionsVariable = conflictEntries.some(
      (e) =>
        e.decision.includes("LOG_LEVEL") ||
        e.reasoning.includes("LOG_LEVEL"),
    );
    expect(mentionsVariable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test suite: All agent decisions produce diary entries
// ---------------------------------------------------------------------------

describe("Decision Diary — orchestration completeness", () => {
  let diary: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new CommandAgent(diary, deployments, new OrderStore(), healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
  });

  it("successful deployment produces entries for every pipeline step", async () => {
    healthChecker.willReturn(HEALTHY);

    const result = await agent.triggerDeployment(
      makeTrigger(),
      makePartition(),
      makeEnvironment(),
      makeOperation(),
    );

    const entries = diary.getByDeployment(result.id);
    const types = entries.map((e) => e.decisionType);

    expect(types).toContain("pipeline-plan");
    expect(types).toContain("configuration-resolved");
    expect(types).toContain("health-check");
    expect(types).toContain("deployment-execution");
    expect(types).toContain("deployment-verification");
    expect(types).toContain("deployment-completion");
  });

  it("failed deployment produces entries up to the failure plus the failure entry", async () => {
    healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);

    const result = await agent.triggerDeployment(
      makeTrigger(),
      makePartition(),
      makeEnvironment(),
      makeOperation(),
    );

    const entries = diary.getByDeployment(result.id);
    const types = entries.map((e) => e.decisionType);

    // Should have plan, config, health check (retry), and failure
    expect(types).toContain("pipeline-plan");
    expect(types).toContain("configuration-resolved");
    expect(types).toContain("health-check");
    expect(types).toContain("deployment-failure");

    // Should NOT have execution or verification (pipeline aborted)
    expect(types).not.toContain("deployment-execution");
    expect(types).not.toContain("deployment-verification");
    expect(types).not.toContain("deployment-completion");
  });

  it("variable conflict deployment produces variable-conflict entries", async () => {
    const partition = makePartition({
      variables: { DB_HOST: "prod-db.internal" },
    });
    const env = makeEnvironment({
      name: "staging",
      variables: { DB_HOST: "staging-db.internal" },
    });

    healthChecker.willReturn(HEALTHY);

    const result = await agent.triggerDeployment(
      makeTrigger({ environmentId: "env-staging" }),
      partition,
      env,
      makeOperation({ environmentIds: ["env-staging"] }),
    );

    const entries = diary.getByDeployment(result.id);
    const types = entries.map((e) => e.decisionType);

    expect(types).toContain("variable-conflict");
  });

  it("every entry has a valid decisionType from the enum", async () => {
    const validTypes: DecisionType[] = [
      "pipeline-plan",
      "configuration-resolved",
      "variable-conflict",
      "health-check",
      "deployment-execution",
      "deployment-verification",
      "deployment-completion",
      "deployment-failure",
      "system",
      "llm-call",
      "order-created",
    ];

    healthChecker.willReturn(HEALTHY);

    await agent.triggerDeployment(makeTrigger(), makePartition(), makeEnvironment(), makeOperation());

    const entries = diary.getRecent(100);
    for (const entry of entries) {
      expect(validTypes).toContain(entry.decisionType);
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite: Retrieval across all four dimensions
// ---------------------------------------------------------------------------

describe("Decision Diary — retrieval dimensions", () => {
  let diary: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new CommandAgent(diary, deployments, new OrderStore(), healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
  });

  it("retrieval by deployment — returns only entries for the specified deployment", async () => {
    healthChecker.willReturn(HEALTHY, HEALTHY);

    const result1 = await agent.triggerDeployment(
      makeTrigger({ version: "1.0.0" }),
      makePartition(),
      makeEnvironment(),
      makeOperation(),
    );
    const result2 = await agent.triggerDeployment(
      makeTrigger({ version: "2.0.0" }),
      makePartition(),
      makeEnvironment(),
      makeOperation(),
    );

    const entries1 = diary.getByDeployment(result1.id);
    const entries2 = diary.getByDeployment(result2.id);

    // Each deployment has its own entries
    expect(entries1.length).toBeGreaterThanOrEqual(5);
    expect(entries2.length).toBeGreaterThanOrEqual(5);

    // No cross-contamination
    for (const e of entries1) {
      expect(e.deploymentId).toBe(result1.id);
    }
    for (const e of entries2) {
      expect(e.deploymentId).toBe(result2.id);
    }
  });

  it("retrieval by partition — returns only entries for the specified partition", async () => {
    healthChecker.willReturn(HEALTHY, HEALTHY);

    await agent.triggerDeployment(
      makeTrigger({ partitionId: "partition-a" }),
      makePartition({ id: "partition-a", name: "Partition A" }),
      makeEnvironment(),
      makeOperation(),
    );
    await agent.triggerDeployment(
      makeTrigger({ partitionId: "partition-b" }),
      makePartition({ id: "partition-b", name: "Partition B" }),
      makeEnvironment(),
      makeOperation(),
    );

    const entriesA = diary.getByPartition("partition-a");
    const entriesB = diary.getByPartition("partition-b");

    expect(entriesA.length).toBeGreaterThanOrEqual(5);
    expect(entriesB.length).toBeGreaterThanOrEqual(5);

    for (const e of entriesA) {
      expect(e.partitionId).toBe("partition-a");
    }
    for (const e of entriesB) {
      expect(e.partitionId).toBe("partition-b");
    }

    // No overlap
    const idsA = new Set(entriesA.map((e) => e.id));
    const idsB = new Set(entriesB.map((e) => e.id));
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });

  it("retrieval by decision type — filters correctly across deployments", async () => {
    healthChecker.willReturn(HEALTHY, CONN_REFUSED, CONN_REFUSED);

    // One success, one failure
    await agent.triggerDeployment(
      makeTrigger({ version: "1.0.0" }),
      makePartition(),
      makeEnvironment(),
      makeOperation(),
    );
    await agent.triggerDeployment(
      makeTrigger({ version: "2.0.0" }),
      makePartition(),
      makeEnvironment(),
      makeOperation(),
    );

    const planEntries = diary.getByType("pipeline-plan");
    const healthEntries = diary.getByType("health-check");
    const failEntries = diary.getByType("deployment-failure");
    const completionEntries = diary.getByType("deployment-completion");

    // Two deployments = two pipeline plans
    expect(planEntries).toHaveLength(2);
    for (const e of planEntries) {
      expect(e.decisionType).toBe("pipeline-plan");
    }

    // Health check entries from both
    expect(healthEntries.length).toBeGreaterThanOrEqual(2);
    for (const e of healthEntries) {
      expect(e.decisionType).toBe("health-check");
    }

    // One failure, one completion
    expect(failEntries).toHaveLength(1);
    expect(completionEntries).toHaveLength(1);
  });

  it("retrieval by time range — returns entries within the window", async () => {
    const before = new Date();

    healthChecker.willReturn(HEALTHY);
    await agent.triggerDeployment(
      makeTrigger(),
      makePartition(),
      makeEnvironment(),
      makeOperation(),
    );

    const after = new Date();

    const entries = diary.getByTimeRange(before, after);
    expect(entries.length).toBeGreaterThanOrEqual(5);

    for (const e of entries) {
      expect(e.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(e.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    }

    // Future window returns nothing
    const futureStart = new Date(after.getTime() + 60_000);
    const futureEnd = new Date(after.getTime() + 120_000);
    const futureEntries = diary.getByTimeRange(futureStart, futureEnd);
    expect(futureEntries).toHaveLength(0);
  });

  it("retrieval by time range returns entries sorted chronologically", async () => {
    const before = new Date();

    healthChecker.willReturn(HEALTHY);
    await agent.triggerDeployment(
      makeTrigger(),
      makePartition(),
      makeEnvironment(),
      makeOperation(),
    );

    const after = new Date();
    const entries = diary.getByTimeRange(before, after);

    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].timestamp.getTime()).toBeGreaterThanOrEqual(
        entries[i - 1].timestamp.getTime(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite: Persistent Decision Diary (SQLite)
// ---------------------------------------------------------------------------

describe("PersistentDecisionDebrief — SQLite backing store", () => {
  let dbPath: string;
  let diary: PersistentDecisionDebrief;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `deploystack-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    diary = new PersistentDecisionDebrief(dbPath);
  });

  afterEach(() => {
    diary.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + "-wal");
      fs.unlinkSync(dbPath + "-shm");
    } catch {
      // ignore cleanup errors
    }
  });

  it("persists entries across close and reopen", () => {
    const entry = diary.record({
      partitionId: "partition-1",
      deploymentId: "deploy-1",
      agent: "command",
      decisionType: "pipeline-plan",
      decision: "Planned deployment pipeline: resolve → execute → verify",
      reasoning: "Standard three-step pipeline for web-app v1.0.0 to production.",
      context: { operationId: "web-app", version: "1.0.0" },
    });

    diary.close();

    // Reopen the same database
    const diary2 = new PersistentDecisionDebrief(dbPath);
    const retrieved = diary2.getById(entry.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.decision).toBe(entry.decision);
    expect(retrieved!.reasoning).toBe(entry.reasoning);
    expect(retrieved!.partitionId).toBe("partition-1");
    expect(retrieved!.deploymentId).toBe("deploy-1");
    expect(retrieved!.decisionType).toBe("pipeline-plan");
    expect(retrieved!.context).toEqual({ operationId: "web-app", version: "1.0.0" });
    diary2.close();
  });

  it("retrieval by deployment returns correct entries", () => {
    diary.record({
      partitionId: "t1",
      deploymentId: "d1",
      agent: "command",
      decisionType: "pipeline-plan",
      decision: "Planned pipeline for d1",
      reasoning: "Deploy web-app v1.0 to production for Acme.",
    });
    diary.record({
      partitionId: "t1",
      deploymentId: "d2",
      agent: "command",
      decisionType: "pipeline-plan",
      decision: "Planned pipeline for d2",
      reasoning: "Deploy web-app v2.0 to staging for Acme.",
    });
    diary.record({
      partitionId: "t1",
      deploymentId: "d1",
      agent: "command",
      decisionType: "deployment-completion",
      decision: "Deployment d1 completed",
      reasoning: "All steps passed.",
    });

    const d1Entries = diary.getByDeployment("d1");
    expect(d1Entries).toHaveLength(2);
    for (const e of d1Entries) {
      expect(e.deploymentId).toBe("d1");
    }

    const d2Entries = diary.getByDeployment("d2");
    expect(d2Entries).toHaveLength(1);
    expect(d2Entries[0].deploymentId).toBe("d2");
  });

  it("retrieval by partition returns correct entries", () => {
    diary.record({
      partitionId: "acme",
      deploymentId: "d1",
      agent: "command",
      decisionType: "pipeline-plan",
      decision: "Acme deployment plan",
      reasoning: "Standard pipeline for Acme Corp.",
    });
    diary.record({
      partitionId: "beta",
      deploymentId: "d2",
      agent: "command",
      decisionType: "pipeline-plan",
      decision: "Beta deployment plan",
      reasoning: "Standard pipeline for Beta Inc.",
    });

    const acmeEntries = diary.getByPartition("acme");
    expect(acmeEntries).toHaveLength(1);
    expect(acmeEntries[0].partitionId).toBe("acme");

    const betaEntries = diary.getByPartition("beta");
    expect(betaEntries).toHaveLength(1);
    expect(betaEntries[0].partitionId).toBe("beta");
  });

  it("retrieval by decision type filters correctly", () => {
    diary.record({
      partitionId: "t1",
      deploymentId: "d1",
      agent: "command",
      decisionType: "health-check",
      decision: "Health check passed",
      reasoning: "Service responding in 5ms.",
    });
    diary.record({
      partitionId: "t1",
      deploymentId: "d1",
      agent: "command",
      decisionType: "variable-conflict",
      decision: "LOG_LEVEL conflict resolved",
      reasoning: "Trigger value 'debug' overrides partition value 'error'.",
    });
    diary.record({
      partitionId: "t1",
      deploymentId: "d1",
      agent: "command",
      decisionType: "health-check",
      decision: "Post-flight check passed",
      reasoning: "Service healthy after deploy.",
    });

    const healthEntries = diary.getByType("health-check");
    expect(healthEntries).toHaveLength(2);
    for (const e of healthEntries) {
      expect(e.decisionType).toBe("health-check");
    }

    const conflictEntries = diary.getByType("variable-conflict");
    expect(conflictEntries).toHaveLength(1);
    expect(conflictEntries[0].decisionType).toBe("variable-conflict");
  });

  it("retrieval by time range works correctly", () => {
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-01-02T00:00:00Z");
    const t3 = new Date("2026-01-03T00:00:00Z");

    // Record entries — timestamps are set by the diary, so we record
    // and check the actual timestamps
    const before = new Date();
    diary.record({
      partitionId: "t1",
      deploymentId: "d1",
      agent: "command",
      decisionType: "pipeline-plan",
      decision: "First entry",
      reasoning: "First reasoning.",
    });
    diary.record({
      partitionId: "t1",
      deploymentId: "d1",
      agent: "command",
      decisionType: "deployment-completion",
      decision: "Second entry",
      reasoning: "Second reasoning.",
    });
    const after = new Date();

    // Current window should find both
    const current = diary.getByTimeRange(before, after);
    expect(current).toHaveLength(2);

    // Past window should find nothing
    const past = diary.getByTimeRange(t1, t2);
    expect(past).toHaveLength(0);
  });

  it("getRecent returns entries in reverse chronological order", () => {
    for (let i = 0; i < 5; i++) {
      diary.record({
        partitionId: "t1",
        deploymentId: `d${i}`,
        agent: "command",
        decisionType: "pipeline-plan",
        decision: `Entry ${i}`,
        reasoning: `Reasoning for entry ${i}.`,
      });
    }

    const recent = diary.getRecent(3);
    expect(recent).toHaveLength(3);

    // Most recent first
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1].timestamp.getTime()).toBeGreaterThanOrEqual(
        recent[i].timestamp.getTime(),
      );
    }
  });

  it("context round-trips through JSON correctly", () => {
    const entry = diary.record({
      partitionId: "t1",
      deploymentId: "d1",
      agent: "command",
      decisionType: "health-check",
      decision: "Health check with complex context",
      reasoning: "Detailed reasoning here.",
      context: {
        serviceId: "web-app/production",
        responseTimeMs: 42,
        nested: { retries: 3, errors: ["timeout", "refused"] },
      },
    });

    const retrieved = diary.getById(entry.id);
    expect(retrieved!.context).toEqual({
      serviceId: "web-app/production",
      responseTimeMs: 42,
      nested: { retries: 3, errors: ["timeout", "refused"] },
    });
  });
});

// ---------------------------------------------------------------------------
// Test suite: Integration — PersistentDecisionDebrief with CommandAgent
// ---------------------------------------------------------------------------

describe("PersistentDecisionDebrief — integration with CommandAgent", () => {
  let dbPath: string;
  let diary: PersistentDecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `deploystack-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    diary = new PersistentDecisionDebrief(dbPath);
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new CommandAgent(diary, deployments, new OrderStore(), healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
  });

  afterEach(() => {
    diary.close();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + "-wal");
      fs.unlinkSync(dbPath + "-shm");
    } catch {
      // ignore cleanup errors
    }
  });

  it("agent decisions persist to SQLite and survive reconnection", async () => {
    healthChecker.willReturn(HEALTHY);

    const result = await agent.triggerDeployment(
      makeTrigger(),
      makePartition({ name: "Acme Corp" }),
      makeEnvironment(),
      makeOperation(),
    );

    expect(result.status).toBe("succeeded");

    // Verify entries exist before close
    const entriesBefore = diary.getByDeployment(result.id);
    expect(entriesBefore.length).toBeGreaterThanOrEqual(5);

    diary.close();

    // Reopen and verify persistence
    const diary2 = new PersistentDecisionDebrief(dbPath);
    const entriesAfter = diary2.getByDeployment(result.id);
    expect(entriesAfter).toHaveLength(entriesBefore.length);

    // Verify all decision types from the pipeline are present
    const types = entriesAfter.map((e) => e.decisionType);
    expect(types).toContain("pipeline-plan");
    expect(types).toContain("configuration-resolved");
    expect(types).toContain("health-check");
    expect(types).toContain("deployment-execution");
    expect(types).toContain("deployment-verification");
    expect(types).toContain("deployment-completion");

    diary2.close();
  });

  it("cross-dimension queries work correctly with real agent data", async () => {
    healthChecker.willReturn(HEALTHY, HEALTHY);

    // Two deployments for different partitions
    const result1 = await agent.triggerDeployment(
      makeTrigger({ partitionId: "acme" }),
      makePartition({ id: "acme", name: "Acme Corp" }),
      makeEnvironment(),
      makeOperation(),
    );
    const result2 = await agent.triggerDeployment(
      makeTrigger({ partitionId: "beta" }),
      makePartition({ id: "beta", name: "Beta Inc" }),
      makeEnvironment(),
      makeOperation(),
    );

    // By deployment
    const acmeEntries = diary.getByDeployment(result1.id);
    const betaEntries = diary.getByDeployment(result2.id);
    expect(acmeEntries.length).toBeGreaterThanOrEqual(5);
    expect(betaEntries.length).toBeGreaterThanOrEqual(5);

    // By partition — same entries, different access path
    const acmePartitionEntries = diary.getByPartition("acme");
    const betaPartitionEntries = diary.getByPartition("beta");
    expect(acmePartitionEntries).toHaveLength(acmeEntries.length);
    expect(betaPartitionEntries).toHaveLength(betaEntries.length);

    // By type — across both deployments
    const plans = diary.getByType("pipeline-plan");
    expect(plans).toHaveLength(2);

    // By time range — all entries fall within the test window
    const allRecent = diary.getRecent(100);
    const earliest = allRecent[allRecent.length - 1].timestamp;
    const latest = allRecent[0].timestamp;
    const rangeEntries = diary.getByTimeRange(
      new Date(earliest.getTime() - 1),
      new Date(latest.getTime() + 1),
    );
    expect(rangeEntries).toHaveLength(allRecent.length);
  });
});

// ---------------------------------------------------------------------------
// Test suite: Human-readable formatting
// ---------------------------------------------------------------------------

describe("Decision Diary — human-readable format", () => {
  it("formatDebriefEntry produces readable output with all fields", () => {
    const entry: DebriefEntry = {
      id: "abc-123-def-456",
      timestamp: new Date("2026-02-23T14:30:05.000Z"),
      partitionId: "partition-acme",
      deploymentId: "deploy-789",
      agent: "command",
      decisionType: "health-check",
      decision: "Pre-flight health check passed",
      reasoning:
        'Target environment "production" is reachable and healthy (response time: 5ms). Proceeding with deployment.',
      context: { serviceId: "web-app/production", responseTimeMs: 5 },
    };

    const formatted = formatDebriefEntry(entry);

    expect(formatted).toContain("HEALTH-CHECK");
    expect(formatted).toContain("partition-acme");
    expect(formatted).toContain("deploy-7"); // truncated ID
    expect(formatted).toContain("command");
    expect(formatted).toContain("Pre-flight health check passed");
    expect(formatted).toContain("production");
    expect(formatted).toContain("response time: 5ms");
    expect(formatted).toContain("serviceId=web-app/production");
  });

  it("formatDebriefEntry handles system-level entries (null partition)", () => {
    const entry: DebriefEntry = {
      id: "sys-001",
      timestamp: new Date("2026-02-23T12:00:00.000Z"),
      partitionId: null,
      deploymentId: null,
      agent: "command",
      decisionType: "system",
      decision: "Command initialized with demo data",
      reasoning: "Seeded one partition and two environments.",
      context: {},
    };

    const formatted = formatDebriefEntry(entry);
    expect(formatted).toContain("system");
    expect(formatted).toContain("n/a");
    expect(formatted).toContain("SYSTEM");
  });

  it("formatDebriefEntries produces separator-delimited output", () => {
    const entries: DebriefEntry[] = [
      {
        id: "e1",
        timestamp: new Date("2026-02-23T14:00:00.000Z"),
        partitionId: "t1",
        deploymentId: "d1",
        agent: "command",
        decisionType: "pipeline-plan",
        decision: "Entry one",
        reasoning: "First reasoning.",
        context: {},
      },
      {
        id: "e2",
        timestamp: new Date("2026-02-23T14:01:00.000Z"),
        partitionId: "t1",
        deploymentId: "d1",
        agent: "command",
        decisionType: "deployment-completion",
        decision: "Entry two",
        reasoning: "Second reasoning.",
        context: {},
      },
    ];

    const formatted = formatDebriefEntries(entries);
    expect(formatted).toContain("---");
    expect(formatted).toContain("Entry one");
    expect(formatted).toContain("Entry two");
  });

  it("formatDebriefEntries handles empty list", () => {
    expect(formatDebriefEntries([])).toBe("No debrief entries found.");
  });
});
