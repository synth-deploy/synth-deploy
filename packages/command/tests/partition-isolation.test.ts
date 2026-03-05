import { describe, it, expect, beforeEach } from "vitest";
import {
  DecisionDebrief,
  PartitionManager,
  PartitionStore,
  EnvironmentStore,
  ArtifactStore,
} from "@deploystack/core";
import type { Environment, DebriefEntry } from "@deploystack/core";
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
  async check(): Promise<HealthCheckResult> {
    const next = this.responses.shift();
    if (next) return next;
    return { reachable: true, responseTimeMs: 1, error: null };
  }
  willReturn(...results: HealthCheckResult[]): void {
    this.responses.push(...results);
  }
}

const HEALTHY: HealthCheckResult = {
  reachable: true,
  responseTimeMs: 1,
  error: null,
};

const CONN_REFUSED: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "ECONNREFUSED: Connection refused",
};

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-prod",
    name: "production",
    variables: {},
    ...overrides,
  };
}

function findDecisions(entries: DebriefEntry[], substr: string): DebriefEntry[] {
  return entries.filter((e) =>
    e.decision.toLowerCase().includes(substr.toLowerCase()),
  );
}

// Shared stores for CommandAgent
let artifactStore: ArtifactStore;
let envStore: EnvironmentStore;
let partStore: PartitionStore;

/** Insert a partition into the store with a specific ID (bypassing UUID generation). */
function forceInsertPartition(id: string, name: string, variables: Record<string, string>) {
  if (partStore.get(id)) return;
  (partStore as any).partitions.set(id, { id, name, variables, createdAt: new Date() });
}

/** Insert an environment into the store with a specific ID. */
function forceInsertEnvironment(id: string, name: string, variables: Record<string, string>) {
  if (envStore.get(id)) return;
  (envStore as any).environments.set(id, { id, name, variables });
}

/** Seed a minimal artifact and return it. */
function getOrCreateArtifact() {
  const existing = artifactStore.list();
  if (existing.length > 0) return existing[0];
  return artifactStore.create({
    name: "web-app",
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

/**
 * Deploy via CommandAgent using a PartitionContainer (from PartitionManager).
 * Ensures all entities are registered in the agent's stores before triggering.
 */
async function testDeployWithPartition(
  agent: CommandAgent,
  partitionLike: { id: string; toPartition: () => { id: string; name: string; variables: Record<string, string> } },
  env: Environment,
  version = "1.0.0",
  variables?: Record<string, string>,
) {
  const partition = partitionLike.toPartition();

  // Sync PartitionManager's partition into the agent's PartitionStore
  forceInsertPartition(partition.id, partition.name, partition.variables);
  if (partStore.get(partition.id)) {
    partStore.setVariables(partition.id, partition.variables);
  }

  // Sync environment into the agent's EnvironmentStore
  forceInsertEnvironment(env.id, env.name, env.variables);

  const artifact = getOrCreateArtifact();

  const trigger = {
    artifactId: artifact.id,
    artifactVersionId: version,
    partitionId: partition.id,
    environmentId: env.id,
    triggeredBy: "user" as const,
    ...(variables ? { variables } : {}),
  };
  return agent.triggerDeployment(trigger);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Partition Isolation", () => {
  let diary: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;
  let manager: PartitionManager;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    artifactStore = new ArtifactStore();
    envStore = new EnvironmentStore();
    partStore = new PartitionStore();
    agent = new CommandAgent(
      diary, deployments, artifactStore, envStore, partStore,
      healthChecker, { healthCheckBackoffMs: 1, executionDelayMs: 1 },
    );
    manager = new PartitionManager(deployments, diary);
  });

  // -----------------------------------------------------------------------
  // 1. Variable isolation — setting vars on A does not touch B
  // -----------------------------------------------------------------------

  describe("variable isolation", () => {
    it("setting variables on Partition A has zero effect on Partition B", () => {
      const partitionA = manager.createPartition("Acme Corp", {
        DB_HOST: "acme-db",
        LOG_LEVEL: "warn",
      });
      const partitionB = manager.createPartition("Beta Inc", {
        DB_HOST: "beta-db",
        LOG_LEVEL: "info",
      });

      // Mutate A's variables
      partitionA.setVariables({ DB_HOST: "acme-db-v2", NEW_VAR: "only-acme" });

      // B is completely unaffected
      expect(partitionB.getVariables()).toEqual({
        DB_HOST: "beta-db",
        LOG_LEVEL: "info",
      });

      // A has the updated values
      expect(partitionA.getVariables()).toEqual({
        DB_HOST: "acme-db-v2",
        LOG_LEVEL: "warn",
        NEW_VAR: "only-acme",
      });
    });

    it("getVariables returns a copy — external mutation cannot corrupt internal state", () => {
      const partition = manager.createPartition("Acme Corp", { DB_HOST: "acme-db" });

      const vars = partition.getVariables();
      vars.DB_HOST = "CORRUPTED";
      vars.INJECTED = "malicious";

      // Internal state is untouched
      expect(partition.getVariables()).toEqual({ DB_HOST: "acme-db" });
    });
  });

  // -----------------------------------------------------------------------
  // 2. Deployment visibility — A's deployments invisible to B
  // -----------------------------------------------------------------------

  describe("deployment visibility isolation", () => {
    it("Partition A deployments are invisible to Partition B", async () => {
      const partitionA = manager.createPartition("Acme Corp");
      const partitionB = manager.createPartition("Beta Inc");
      const env = makeEnvironment();

      // Deploy to Partition A
      const resultA = await testDeployWithPartition(agent, partitionA, env);
      expect(resultA.status).toBe("succeeded");

      // Partition A sees its deployment
      expect(partitionA.getDeployments()).toHaveLength(1);
      expect(partitionA.getDeployments()[0].id).toBe(resultA.id);

      // Partition B sees nothing
      expect(partitionB.getDeployments()).toHaveLength(0);
    });

    it("Partition B cannot access Partition A deployment by ID", async () => {
      const partitionA = manager.createPartition("Acme Corp");
      const partitionB = manager.createPartition("Beta Inc");
      const env = makeEnvironment();

      const resultA = await testDeployWithPartition(agent, partitionA, env);

      // Partition A can access by ID
      expect(partitionA.getDeployment(resultA.id)).toBeDefined();
      expect(partitionA.getDeployment(resultA.id)!.id).toBe(resultA.id);

      // Partition B cannot access A's deployment — returns undefined
      expect(partitionB.getDeployment(resultA.id)).toBeUndefined();
    });

    it("multiple deployments across partitions stay fully partitioned", async () => {
      const partitionA = manager.createPartition("Acme Corp");
      const partitionB = manager.createPartition("Beta Inc");
      const env = makeEnvironment();

      // Deploy 3 times to A, 2 times to B
      for (let i = 0; i < 3; i++) {
        await testDeployWithPartition(agent, partitionA, env, `a-${i}`);
      }
      for (let i = 0; i < 2; i++) {
        await testDeployWithPartition(agent, partitionB, env, `b-${i}`);
      }

      expect(partitionA.getDeployments()).toHaveLength(3);
      expect(partitionB.getDeployments()).toHaveLength(2);

      // Every deployment in A belongs to A
      for (const d of partitionA.getDeployments()) {
        expect(d.partitionId).toBe(partitionA.id);
      }
      // Every deployment in B belongs to B
      for (const d of partitionB.getDeployments()) {
        expect(d.partitionId).toBe(partitionB.id);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 3. Diary isolation — A's diary entries invisible to B
  // -----------------------------------------------------------------------

  describe("diary entry isolation", () => {
    it("Partition A diary entries are invisible to Partition B", async () => {
      const partitionA = manager.createPartition("Acme Corp");
      const partitionB = manager.createPartition("Beta Inc");
      const env = makeEnvironment();

      await testDeployWithPartition(agent, partitionA, env);

      // A has diary entries
      const entriesA = partitionA.getDebriefEntries();
      expect(entriesA.length).toBeGreaterThan(0);

      // B has none
      expect(partitionB.getDebriefEntries()).toHaveLength(0);

      // Every entry in A is tagged with A's partitionId
      for (const entry of entriesA) {
        expect(entry.partitionId).toBe(partitionA.id);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 4. Error containment — failure in A doesn't affect B
  // -----------------------------------------------------------------------

  describe("error containment", () => {
    it("deployment failure on Partition A does not prevent Partition B deployment", async () => {
      const partitionA = manager.createPartition("Acme Corp");
      const partitionB = manager.createPartition("Beta Inc");
      const env = makeEnvironment();

      // Partition A: deployment fails (health check fails)
      healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);
      const resultA = await testDeployWithPartition(agent, partitionA, env);
      expect(resultA.status).toBe("failed");

      // Partition B: deployment succeeds — A's failure had no effect
      const resultB = await testDeployWithPartition(agent, partitionB, env);
      expect(resultB.status).toBe("succeeded");

      // Each partition sees only their own result
      expect(partitionA.getDeployments()).toHaveLength(1);
      expect(partitionA.getDeployments()[0].status).toBe("failed");

      expect(partitionB.getDeployments()).toHaveLength(1);
      expect(partitionB.getDeployments()[0].status).toBe("succeeded");
    });

    it("A's failure diary entries don't leak into B's diary", async () => {
      const partitionA = manager.createPartition("Acme Corp");
      const partitionB = manager.createPartition("Beta Inc");
      const env = makeEnvironment();

      // A fails
      healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);
      await testDeployWithPartition(agent, partitionA, env);

      // B succeeds
      await testDeployWithPartition(agent, partitionB, env);

      // A has failure entries
      const failEntries = findDecisions(
        partitionA.getDebriefEntries(),
        "failed",
      );
      expect(failEntries.length).toBeGreaterThan(0);

      // B has zero failure entries
      const bFailEntries = findDecisions(
        partitionB.getDebriefEntries(),
        "failed",
      );
      expect(bFailEntries).toHaveLength(0);

      // B only has success-path entries
      const bSuccess = findDecisions(
        partitionB.getDebriefEntries(),
        "Marking deployment of",
      );
      expect(bSuccess).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 5. PartitionManager access control
  // -----------------------------------------------------------------------

  describe("manager access control", () => {
    it("getPartition returns undefined for non-existent partition", () => {
      expect(manager.getPartition("does-not-exist")).toBeUndefined();
    });

    it("listPartitions exposes metadata only — not data access paths", () => {
      manager.createPartition("Acme Corp", { SECRET: "s3cret" });
      manager.createPartition("Beta Inc");

      const list = manager.listPartitions();
      expect(list).toHaveLength(2);

      // List contains id and name only
      for (const item of list) {
        expect(Object.keys(item)).toEqual(["id", "name"]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Variable precedence resolution
// ---------------------------------------------------------------------------

describe("Variable Precedence Resolution", () => {
  let diary: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let manager: PartitionManager;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    manager = new PartitionManager(deployments, diary);
  });

  it("partition-level values override environment defaults", () => {
    const partition = manager.createPartition("Acme Corp", {
      LOG_LEVEL: "error",
      DB_HOST: "acme-db",
    });
    const env = makeEnvironment({
      variables: { LOG_LEVEL: "warn", APP_ENV: "production" },
    });

    const { resolved, precedenceLog } = partition.resolveVariables(env);

    expect(resolved.LOG_LEVEL).toBe("error"); // partition wins
    expect(resolved.APP_ENV).toBe("production"); // env only
    expect(resolved.DB_HOST).toBe("acme-db"); // partition only

    // Precedence log records the override
    const logOverride = precedenceLog.find((e) => e.variable === "LOG_LEVEL");
    expect(logOverride).toBeDefined();
    expect(logOverride!.source).toBe("partition");
    expect(logOverride!.resolvedValue).toBe("error");
    expect(logOverride!.overrode).toEqual({
      value: "warn",
      source: "environment",
    });
    expect(logOverride!.reason).toContain("overrides");
    expect(logOverride!.reason).toContain("environment");
  });

  it("trigger overrides both partition and environment", () => {
    const partition = manager.createPartition("Acme Corp", {
      LOG_LEVEL: "error",
    });
    const env = makeEnvironment({
      variables: { LOG_LEVEL: "warn", APP_ENV: "production" },
    });

    const { resolved, precedenceLog } = partition.resolveVariables(env, {
      LOG_LEVEL: "debug",
      APP_ENV: "staging",
    });

    expect(resolved.LOG_LEVEL).toBe("debug"); // trigger > partition
    expect(resolved.APP_ENV).toBe("staging"); // trigger > environment

    // LOG_LEVEL trigger overrode partition
    const logLevel = precedenceLog.find((e) => e.variable === "LOG_LEVEL");
    expect(logLevel!.source).toBe("trigger");
    expect(logLevel!.overrode).toEqual({ value: "error", source: "partition" });

    // APP_ENV trigger overrode environment
    const appEnv = precedenceLog.find((e) => e.variable === "APP_ENV");
    expect(appEnv!.source).toBe("trigger");
    expect(appEnv!.overrode).toEqual({
      value: "production",
      source: "environment",
    });
  });

  it("full three-layer resolution: trigger > partition > environment", () => {
    const partition = manager.createPartition("Acme Corp", {
      DB_HOST: "acme-db",
      LOG_LEVEL: "error",
    });
    const env = makeEnvironment({
      variables: {
        APP_ENV: "production",
        LOG_LEVEL: "warn",
        REGION: "us-east-1",
      },
    });

    const { resolved, precedenceLog } = partition.resolveVariables(env, {
      LOG_LEVEL: "debug",
    });

    // Full merged result
    expect(resolved).toEqual({
      APP_ENV: "production", // env only
      LOG_LEVEL: "debug", // trigger > partition > env
      REGION: "us-east-1", // env only
      DB_HOST: "acme-db", // partition only
    });

    // Every variable has a log entry
    expect(precedenceLog).toHaveLength(4);

    // LOG_LEVEL: trigger wins over partition
    const logLevel = precedenceLog.find((e) => e.variable === "LOG_LEVEL")!;
    expect(logLevel.source).toBe("trigger");
    expect(logLevel.overrode!.source).toBe("partition");
    expect(logLevel.overrode!.value).toBe("error");

    // REGION: environment default, no override
    const region = precedenceLog.find((e) => e.variable === "REGION")!;
    expect(region.source).toBe("environment");
    expect(region.overrode).toBeNull();
    expect(region.reason).toContain("no higher-level override");

    // DB_HOST: partition-only
    const dbHost = precedenceLog.find((e) => e.variable === "DB_HOST")!;
    expect(dbHost.source).toBe("partition");
    expect(dbHost.overrode).toBeNull();
    expect(dbHost.reason).toContain("not defined at environment level");
  });

  it("non-conflicting variables from all levels merge correctly", () => {
    const partition = manager.createPartition("Acme Corp", {
      PARTITION_ONLY: "t-val",
    });
    const env = makeEnvironment({
      variables: { ENV_ONLY: "e-val" },
    });

    const { resolved, precedenceLog } = partition.resolveVariables(env, {
      TRIGGER_ONLY: "tr-val",
    });

    expect(resolved).toEqual({
      ENV_ONLY: "e-val",
      PARTITION_ONLY: "t-val",
      TRIGGER_ONLY: "tr-val",
    });

    // No overrides — all variables come from distinct levels
    for (const entry of precedenceLog) {
      expect(entry.overrode).toBeNull();
    }
  });

  it("same value at multiple levels is not reported as an override", () => {
    const partition = manager.createPartition("Acme Corp", {
      APP_ENV: "production",
    });
    const env = makeEnvironment({
      variables: { APP_ENV: "production" },
    });

    const { resolved, precedenceLog } = partition.resolveVariables(env);

    expect(resolved.APP_ENV).toBe("production");

    // Partition "wins" by precedence but value is the same — no override reported
    const appEnv = precedenceLog.find((e) => e.variable === "APP_ENV")!;
    expect(appEnv.source).toBe("partition");
    expect(appEnv.overrode).toBeNull();
  });

  it("precedence log entries have plain-language reason for every conflict", () => {
    const partition = manager.createPartition("Acme Corp", {
      DB_HOST: "acme-db",
      LOG_LEVEL: "error",
    });
    const env = makeEnvironment({
      variables: { DB_HOST: "default-db", LOG_LEVEL: "warn", REGION: "us-east-1" },
    });

    const { precedenceLog } = partition.resolveVariables(env, {
      LOG_LEVEL: "debug",
    });

    // Every entry has a non-empty reason
    for (const entry of precedenceLog) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }

    // Overrides explain what was overridden
    const dbHost = precedenceLog.find((e) => e.variable === "DB_HOST")!;
    expect(dbHost.reason).toContain("overrides");
    expect(dbHost.reason).toContain("environment");

    const logLevel = precedenceLog.find((e) => e.variable === "LOG_LEVEL")!;
    expect(logLevel.reason).toContain("takes precedence");
    expect(logLevel.reason).toContain("partition");
  });
});

// ---------------------------------------------------------------------------
// Variable precedence integrated with CommandAgent + Decision Diary
// ---------------------------------------------------------------------------

describe("Precedence Recording in Decision Diary", () => {
  let diary: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;
  let manager: PartitionManager;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    artifactStore = new ArtifactStore();
    envStore = new EnvironmentStore();
    partStore = new PartitionStore();
    agent = new CommandAgent(
      diary, deployments, artifactStore, envStore, partStore,
      healthChecker, { healthCheckBackoffMs: 1, executionDelayMs: 1 },
    );
    manager = new PartitionManager(deployments, diary);
  });

  it("CommandAgent records variable conflicts to the diary with full reasoning", async () => {
    const partition = manager.createPartition("Acme Corp", {
      LOG_LEVEL: "error",
    });
    const env = makeEnvironment({
      variables: { LOG_LEVEL: "warn", APP_ENV: "production" },
    });

    const result = await testDeployWithPartition(
      agent,
      partition,
      env,
      "1.0.0",
      { LOG_LEVEL: "debug" },
    );

    expect(result.status).toBe("succeeded");

    // The agent's diary entries record the conflict resolution
    const entries = partition.getDebriefEntries();
    const configEntries = findDecisions(entries, "Accepted configuration");
    expect(configEntries).toHaveLength(1);
    expect(configEntries[0].reasoning).toContain("precedence");
    expect(configEntries[0].reasoning).toContain("conflict");

    // The standard override was recorded
    const overrideEntries = findDecisions(entries, "precedence rules");
    expect(overrideEntries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scale: 50 partitions
// ---------------------------------------------------------------------------

describe("Scale: 50 Partitions", () => {
  let diary: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;
  let manager: PartitionManager;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    artifactStore = new ArtifactStore();
    envStore = new EnvironmentStore();
    partStore = new PartitionStore();
    agent = new CommandAgent(
      diary, deployments, artifactStore, envStore, partStore,
      healthChecker, { healthCheckBackoffMs: 1, executionDelayMs: 1 },
    );
    manager = new PartitionManager(deployments, diary);
  });

  it("creates 50 partitions without performance degradation", () => {
    const start = performance.now();

    const partitions = Array.from({ length: 50 }, (_, i) =>
      manager.createPartition(`Partition-${i}`, {
        DB_HOST: `db-${i}.internal`,
        APP_ENV: "production",
        PARTITION_ID: `t-${i}`,
      }),
    );

    const elapsed = performance.now() - start;

    expect(manager.size).toBe(50);
    expect(partitions).toHaveLength(50);

    // Creation of 50 partitions should complete in well under 1 second
    expect(elapsed).toBeLessThan(1000);

    // Each partition has unique id
    const ids = new Set(partitions.map((t) => t.id));
    expect(ids.size).toBe(50);
  });

  it("50 partitions maintain full isolation across deployments", async () => {
    const env = makeEnvironment({
      variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    });

    // Create 50 partitions with distinct variables
    const partitions = Array.from({ length: 50 }, (_, i) =>
      manager.createPartition(`Partition-${i}`, {
        DB_HOST: `db-${i}.internal`,
        PARTITION_MARKER: `marker-${i}`,
      }),
    );

    // Deploy to all 50 partitions
    const start = performance.now();
    const results = await Promise.all(
      partitions.map((partition) =>
        testDeployWithPartition(agent, partition, env),
      ),
    );
    const elapsed = performance.now() - start;

    // All 50 succeed
    for (const result of results) {
      expect(result.status).toBe("succeeded");
    }

    // 50 deployments in under 5 seconds (generous bound)
    expect(elapsed).toBeLessThan(5000);

    // Isolation: each partition sees exactly 1 deployment
    for (let i = 0; i < 50; i++) {
      const partitionDeployments = partitions[i].getDeployments();
      expect(partitionDeployments).toHaveLength(1);
      expect(partitionDeployments[0].partitionId).toBe(partitions[i].id);

      // Variables resolved with this partition's specific values
      expect(partitionDeployments[0].variables.DB_HOST).toBe(
        `db-${i}.internal`,
      );
      expect(partitionDeployments[0].variables.PARTITION_MARKER).toBe(
        `marker-${i}`,
      );
      expect(partitionDeployments[0].variables.APP_ENV).toBe("production");
    }
  });

  it("partition lookup is O(1) — constant time regardless of count", () => {
    // Create 50 partitions
    const partitions = Array.from({ length: 50 }, (_, i) =>
      manager.createPartition(`Partition-${i}`),
    );

    // Lookup the 1st, 25th, and 50th partition — all should be fast
    const ids = [partitions[0].id, partitions[24].id, partitions[49].id];
    const times: number[] = [];

    for (const id of ids) {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        manager.getPartition(id);
      }
      times.push(performance.now() - start);
    }

    // All 1000 lookups per partition should be sub-millisecond territory
    // (generous bound: 50ms for 1000 lookups)
    for (const t of times) {
      expect(t).toBeLessThan(50);
    }

    // No dramatic variance — first and last should be within 10x of each other
    const ratio = Math.max(...times) / Math.min(...times);
    expect(ratio).toBeLessThan(10);
  });

  it("diary entries stay partitioned across all 50 partitions", async () => {
    const env = makeEnvironment();

    const partitions = Array.from({ length: 50 }, (_, i) =>
      manager.createPartition(`Partition-${i}`),
    );

    // Deploy to all 50
    await Promise.all(
      partitions.map((partition) =>
        testDeployWithPartition(agent, partition, env),
      ),
    );

    // The full diary has entries for all 50
    const allEntries = diary.getRecent(10000);
    expect(allEntries.length).toBeGreaterThan(0);

    // But each container only sees its own
    for (let i = 0; i < 50; i++) {
      const entries = partitions[i].getDebriefEntries();
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.partitionId).toBe(partitions[i].id);
      }
    }

    // No partition sees another partition's entries
    for (let i = 0; i < 50; i++) {
      const myEntries = partitions[i].getDebriefEntries();
      for (const entry of myEntries) {
        // This entry should NOT appear in any other partition's view
        for (let j = 0; j < 50; j++) {
          if (j === i) continue;
          const otherEntries = partitions[j].getDebriefEntries();
          const leaked = otherEntries.find((e) => e.id === entry.id);
          expect(leaked).toBeUndefined();
        }
      }
    }
  });

  it("variable resolution at scale — 50 partitions with different overrides", () => {
    const env = makeEnvironment({
      variables: {
        APP_ENV: "production",
        LOG_LEVEL: "warn",
        REGION: "us-east-1",
      },
    });

    const partitions = Array.from({ length: 50 }, (_, i) =>
      manager.createPartition(`Partition-${i}`, {
        LOG_LEVEL: i % 2 === 0 ? "error" : "info",
        DB_HOST: `db-${i}.internal`,
      }),
    );

    const start = performance.now();

    for (let i = 0; i < 50; i++) {
      const { resolved, precedenceLog } = partitions[i].resolveVariables(env);

      // Correct precedence applied
      expect(resolved.APP_ENV).toBe("production"); // env
      expect(resolved.REGION).toBe("us-east-1"); // env
      expect(resolved.DB_HOST).toBe(`db-${i}.internal`); // partition
      expect(resolved.LOG_LEVEL).toBe(i % 2 === 0 ? "error" : "info"); // partition overrides env

      // LOG_LEVEL override recorded
      const logEntry = precedenceLog.find((e) => e.variable === "LOG_LEVEL")!;
      expect(logEntry.source).toBe("partition");
      expect(logEntry.overrode).toEqual({ value: "warn", source: "environment" });
      expect(logEntry.reason).toContain("overrides");
    }

    const elapsed = performance.now() - start;
    // 50 resolutions in under 500ms
    expect(elapsed).toBeLessThan(500);
  });
});
