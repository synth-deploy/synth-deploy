import { describe, it, expect, beforeEach } from "vitest";
import { PartitionContainer, type ScopedDeploymentReader, type ScopedDebriefReader } from "../src/partition-container.js";
import { PartitionManager, type DeploymentStoreReader } from "../src/partition-manager.js";
import { DecisionDebrief } from "../src/debrief.js";
import type { Partition, Deployment, DebriefEntry, DeploymentId, Environment } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePartition(overrides: Partial<Partition> = {}): Partition {
  return {
    id: "part-1",
    name: "Test Partition",
    variables: { DB_HOST: "db.test" },
    createdAt: new Date(),
    ...overrides,
  };
}

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep-1",
    operationId: "op-1",
    partitionId: "part-1",
    environmentId: "env-1",
    version: "1.0",
    status: "succeeded",
    variables: {},
    debriefEntryIds: [],
    orderId: null,
    completedAt: null,
    failureReason: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    name: "production",
    variables: { APP_ENV: "production", DB_HOST: "db.default" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PartitionContainer tests
// ---------------------------------------------------------------------------

describe("PartitionContainer", () => {
  describe("variable isolation", () => {
    it("returns a copy of variables, not the original reference", () => {
      const partition = makePartition();
      const container = new PartitionContainer(
        partition,
        { get: () => undefined, list: () => [] },
        { list: () => [] },
      );

      const vars1 = container.getVariables();
      vars1.INJECTED = "hacked";
      const vars2 = container.getVariables();

      expect(vars2.INJECTED).toBeUndefined();
    });

    it("setVariables merges without affecting original partition object", () => {
      const partition = makePartition({ variables: { A: "1" } });
      const originalVars = { ...partition.variables };

      const container = new PartitionContainer(
        partition,
        { get: () => undefined, list: () => [] },
        { list: () => [] },
      );

      container.setVariables({ B: "2" });
      expect(container.getVariables()).toEqual({ A: "1", B: "2" });
      expect(partition.variables).toEqual(originalVars);
    });
  });

  describe("variable precedence (resolveVariables)", () => {
    it("trigger > partition > environment", () => {
      const container = new PartitionContainer(
        makePartition({ variables: { DB_HOST: "partition-db", SHARED: "partition-val" } }),
        { get: () => undefined, list: () => [] },
        { list: () => [] },
      );

      const env = makeEnv({ variables: { DB_HOST: "env-db", APP_ENV: "production", SHARED: "env-val" } });
      const result = container.resolveVariables(env, { DB_HOST: "trigger-db" });

      expect(result.resolved.DB_HOST).toBe("trigger-db");
      expect(result.resolved.SHARED).toBe("partition-val");
      expect(result.resolved.APP_ENV).toBe("production");
    });

    it("precedence log records overrides correctly", () => {
      const container = new PartitionContainer(
        makePartition({ variables: { DB_HOST: "partition-db" } }),
        { get: () => undefined, list: () => [] },
        { list: () => [] },
      );

      const env = makeEnv({ variables: { DB_HOST: "env-db" } });
      const result = container.resolveVariables(env);

      const dbEntry = result.precedenceLog.find(e => e.variable === "DB_HOST");
      expect(dbEntry).toBeDefined();
      expect(dbEntry!.source).toBe("partition");
      expect(dbEntry!.overrode).toEqual({ value: "env-db", source: "environment" });
    });

    it("returns empty precedence log for no variables", () => {
      const container = new PartitionContainer(
        makePartition({ variables: {} }),
        { get: () => undefined, list: () => [] },
        { list: () => [] },
      );

      const env = makeEnv({ variables: {} });
      const result = container.resolveVariables(env);
      expect(result.resolved).toEqual({});
      expect(result.precedenceLog).toEqual([]);
    });
  });

  describe("scoped data access", () => {
    it("delegates to scoped deployment reader", () => {
      const deployments: Deployment[] = [makeDeployment()];
      const scopedReader: ScopedDeploymentReader = {
        get: (id) => deployments.find(d => d.id === id),
        list: () => deployments,
      };

      const container = new PartitionContainer(
        makePartition(),
        scopedReader,
        { list: () => [] },
      );

      expect(container.getDeployments()).toHaveLength(1);
      expect(container.getDeployment("dep-1")).toBeDefined();
      expect(container.getDeployment("nonexistent")).toBeUndefined();
    });

    it("delegates to scoped debrief reader", () => {
      const entries: DebriefEntry[] = [{
        id: "e1", timestamp: new Date(), partitionId: "part-1",
        deploymentId: null, agent: "command", decisionType: "system",
        decision: "test", reasoning: "test", context: {},
      }];

      const container = new PartitionContainer(
        makePartition(),
        { get: () => undefined, list: () => [] },
        { list: () => entries },
      );

      expect(container.getDebriefEntries()).toHaveLength(1);
    });
  });

  describe("toPartition", () => {
    it("returns a snapshot that matches the partition data", () => {
      const container = new PartitionContainer(
        makePartition({ id: "p1", name: "Test" }),
        { get: () => undefined, list: () => [] },
        { list: () => [] },
      );

      const snapshot = container.toPartition();
      expect(snapshot.id).toBe("p1");
      expect(snapshot.name).toBe("Test");
      expect(snapshot.variables).toEqual({ DB_HOST: "db.test" });
    });
  });
});

// ---------------------------------------------------------------------------
// PartitionManager tests
// ---------------------------------------------------------------------------

describe("PartitionManager", () => {
  let deploymentStore: DeploymentStoreReader & { save(d: Deployment): void };
  let debrief: DecisionDebrief;
  let manager: PartitionManager;

  beforeEach(() => {
    const deployments = new Map<DeploymentId, Deployment>();
    deploymentStore = {
      get: (id) => deployments.get(id),
      list: () => [...deployments.values()],
      save: (d) => deployments.set(d.id, d),
    };
    debrief = new DecisionDebrief();
    manager = new PartitionManager(deploymentStore, debrief);
  });

  it("creates partitions with isolated containers", () => {
    const a = manager.createPartition("Acme", { DB: "acme" });
    const b = manager.createPartition("Beta", { DB: "beta" });

    expect(a.getVariables().DB).toBe("acme");
    expect(b.getVariables().DB).toBe("beta");
    expect(a.id).not.toBe(b.id);
  });

  it("cross-partition deployment access is impossible", () => {
    const a = manager.createPartition("Acme");
    const b = manager.createPartition("Beta");

    // Deployment belongs to Acme
    deploymentStore.save(makeDeployment({ id: "d-acme", partitionId: a.id }));
    // Deployment belongs to Beta
    deploymentStore.save(makeDeployment({ id: "d-beta", partitionId: b.id }));

    // Acme can only see Acme's deployment
    expect(a.getDeployments()).toHaveLength(1);
    expect(a.getDeployments()[0].id).toBe("d-acme");
    expect(a.getDeployment("d-beta")).toBeUndefined();

    // Beta can only see Beta's deployment
    expect(b.getDeployments()).toHaveLength(1);
    expect(b.getDeployments()[0].id).toBe("d-beta");
    expect(b.getDeployment("d-acme")).toBeUndefined();
  });

  it("cross-partition debrief access is impossible", () => {
    const a = manager.createPartition("Acme");
    const b = manager.createPartition("Beta");

    debrief.record({
      partitionId: a.id, deploymentId: null, agent: "command",
      decisionType: "system", decision: "Acme decision", reasoning: "...",
    });
    debrief.record({
      partitionId: b.id, deploymentId: null, agent: "command",
      decisionType: "system", decision: "Beta decision", reasoning: "...",
    });

    expect(a.getDebriefEntries()).toHaveLength(1);
    expect(a.getDebriefEntries()[0].decision).toBe("Acme decision");
    expect(b.getDebriefEntries()).toHaveLength(1);
    expect(b.getDebriefEntries()[0].decision).toBe("Beta decision");
  });

  it("variable mutation in one partition does not affect another", () => {
    const a = manager.createPartition("Acme", { KEY: "acme" });
    const b = manager.createPartition("Beta", { KEY: "beta" });

    a.setVariables({ KEY: "modified" });

    expect(a.getVariables().KEY).toBe("modified");
    expect(b.getVariables().KEY).toBe("beta");
  });

  it("listPartitions returns all created partitions", () => {
    manager.createPartition("Acme");
    manager.createPartition("Beta");
    manager.createPartition("Gamma");

    expect(manager.listPartitions()).toHaveLength(3);
    expect(manager.size).toBe(3);
  });

  it("getPartition returns the correct container", () => {
    const a = manager.createPartition("Acme");
    expect(manager.getPartition(a.id)).toBe(a);
    expect(manager.getPartition("nonexistent")).toBeUndefined();
  });
});
