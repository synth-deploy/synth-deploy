import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  openEntityDatabase,
  PersistentPartitionStore,
  PersistentOperationStore,
  PersistentEnvironmentStore,
  PersistentSettingsStore,
  PersistentDeploymentStore,
  PersistentOrderStore,
} from "../src/persistent-stores.js";
import { DEFAULT_DEPLOY_CONFIG, DEFAULT_APP_SETTINGS } from "../src/types.js";
import type { Deployment, DeploymentStep } from "../src/types.js";
import type { CreateOrderParams } from "../src/order-store.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath(): string {
  return path.join(os.tmpdir(), "test-" + crypto.randomUUID() + ".db");
}

function makeStep(overrides: Partial<DeploymentStep> = {}): DeploymentStep {
  return {
    id: crypto.randomUUID(),
    name: "build",
    type: "pre-deploy",
    command: "npm run build",
    order: 0,
    ...overrides,
  };
}

function makeOrderParams(overrides: Partial<CreateOrderParams> = {}): CreateOrderParams {
  return {
    operationId: crypto.randomUUID(),
    operationName: "web-app",
    partitionId: crypto.randomUUID(),
    environmentId: crypto.randomUUID(),
    environmentName: "production",
    version: "1.0.0",
    steps: [makeStep()],
    deployConfig: { ...DEFAULT_DEPLOY_CONFIG },
    variables: { APP_ENV: "production" },
    ...overrides,
  };
}

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    partitionId: crypto.randomUUID(),
    environmentId: crypto.randomUUID(),
    version: "1.0.0",
    status: "pending",
    variables: {},
    debriefEntryIds: [],
    orderId: null,
    createdAt: new Date(),
    completedAt: null,
    failureReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PersistentPartitionStore
// ---------------------------------------------------------------------------

describe("PersistentPartitionStore", () => {
  let dbPath: string;
  let db: Database.Database;
  let store: PersistentPartitionStore;

  beforeAll(() => {
    dbPath = tmpDbPath();
    db = openEntityDatabase(dbPath);
    store = new PersistentPartitionStore(db);
  });

  afterAll(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("creates a partition with a unique id", () => {
    const p = store.create("Acme Corp");
    expect(p.id).toBeDefined();
    expect(p.name).toBe("Acme Corp");
    expect(p.variables).toEqual({});
    expect(p.createdAt).toBeInstanceOf(Date);
  });

  it("creates a partition with variables", () => {
    const p = store.create("Beta Inc", { REGION: "us-east" });
    expect(p.variables.REGION).toBe("us-east");
  });

  it("gets a partition by id", () => {
    const created = store.create("Test Corp");
    const fetched = store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("Test Corp");
    expect(fetched!.createdAt).toBeInstanceOf(Date);
  });

  it("returns undefined for nonexistent id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("lists all partitions", () => {
    const before = store.list().length;
    store.create("List Test A");
    store.create("List Test B");
    expect(store.list().length).toBe(before + 2);
  });

  it("updates partition name", () => {
    const p = store.create("Old Name");
    const updated = store.update(p.id, { name: "New Name" });
    expect(updated.name).toBe("New Name");
    expect(store.get(p.id)!.name).toBe("New Name");
  });

  it("throws when updating nonexistent partition", () => {
    expect(() => store.update("missing", { name: "x" })).toThrow("Partition not found");
  });

  it("sets and merges variables", () => {
    const p = store.create("Vars Test", { A: "1" });
    const updated = store.setVariables(p.id, { B: "2" });
    expect(updated.variables).toEqual({ A: "1", B: "2" });
  });

  it("deletes a partition", () => {
    const p = store.create("Delete Me");
    expect(store.delete(p.id)).toBe(true);
    expect(store.get(p.id)).toBeUndefined();
  });

  it("returns false when deleting nonexistent partition", () => {
    expect(store.delete("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PersistentEnvironmentStore
// ---------------------------------------------------------------------------

describe("PersistentEnvironmentStore", () => {
  let dbPath: string;
  let db: Database.Database;
  let store: PersistentEnvironmentStore;

  beforeAll(() => {
    dbPath = tmpDbPath();
    db = openEntityDatabase(dbPath);
    store = new PersistentEnvironmentStore(db);
  });

  afterAll(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("creates an environment with a unique id", () => {
    const env = store.create("production");
    expect(env.id).toBeDefined();
    expect(env.name).toBe("production");
    expect(env.variables).toEqual({});
  });

  it("creates an environment with variables", () => {
    const env = store.create("staging", { DB_HOST: "staging-db" });
    expect(env.variables.DB_HOST).toBe("staging-db");
  });

  it("gets by id", () => {
    const created = store.create("env-get-test");
    const fetched = store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("env-get-test");
  });

  it("returns undefined for nonexistent id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("lists all environments", () => {
    const before = store.list().length;
    store.create("list-a");
    store.create("list-b");
    expect(store.list().length).toBe(before + 2);
  });

  it("updates name and merges variables", () => {
    const env = store.create("old-env", { A: "1" });
    const updated = store.update(env.id, { name: "new-env", variables: { B: "2" } });
    expect(updated.name).toBe("new-env");
    expect(updated.variables).toEqual({ A: "1", B: "2" });
  });

  it("throws when updating nonexistent environment", () => {
    expect(() => store.update("missing", { name: "x" })).toThrow("Environment not found");
  });

  it("deletes an environment", () => {
    const env = store.create("delete-me");
    expect(store.delete(env.id)).toBe(true);
    expect(store.get(env.id)).toBeUndefined();
  });

  it("returns false when deleting nonexistent environment", () => {
    expect(store.delete("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PersistentOperationStore
// ---------------------------------------------------------------------------

describe("PersistentOperationStore", () => {
  let dbPath: string;
  let db: Database.Database;
  let store: PersistentOperationStore;

  beforeAll(() => {
    dbPath = tmpDbPath();
    db = openEntityDatabase(dbPath);
    store = new PersistentOperationStore(db);
  });

  afterAll(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("creates an operation with defaults", () => {
    const op = store.create("web-app");
    expect(op.id).toBeDefined();
    expect(op.name).toBe("web-app");
    expect(op.environmentIds).toEqual([]);
    expect(op.steps).toEqual([]);
    expect(op.deployConfig).toEqual(DEFAULT_DEPLOY_CONFIG);
  });

  it("creates with environment IDs", () => {
    const envStore = new PersistentEnvironmentStore(db);
    const env = envStore.create("prod");
    const op = store.create("app-with-env", [env.id]);
    expect(op.environmentIds).toEqual([env.id]);
  });

  it("gets by id", () => {
    const created = store.create("get-test");
    const fetched = store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("get-test");
  });

  it("returns undefined for nonexistent id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("lists all operations", () => {
    const before = store.list().length;
    store.create("list-a");
    store.create("list-b");
    expect(store.list().length).toBe(before + 2);
  });

  it("updates operation name", () => {
    const op = store.create("old-name");
    const updated = store.update(op.id, { name: "new-name" });
    expect(updated.name).toBe("new-name");
    expect(store.get(op.id)!.name).toBe("new-name");
  });

  it("deletes an operation and its links and steps", () => {
    const op = store.create("delete-me");
    store.addStep(op.id, makeStep());
    expect(store.delete(op.id)).toBe(true);
    expect(store.get(op.id)).toBeUndefined();
  });

  it("adds and removes environment links", () => {
    const op = store.create("env-link-test");
    store.addEnvironment(op.id, "env-1");
    expect(store.get(op.id)!.environmentIds).toEqual(["env-1"]);

    store.removeEnvironment(op.id, "env-1");
    expect(store.get(op.id)!.environmentIds).toEqual([]);
  });

  it("addStep inserts and sorts by order", () => {
    const op = store.create("step-test");
    store.addStep(op.id, makeStep({ order: 2, name: "second" }));
    store.addStep(op.id, makeStep({ order: 1, name: "first" }));
    const steps = store.get(op.id)!.steps;
    expect(steps).toHaveLength(2);
    expect(steps[0].name).toBe("first");
    expect(steps[1].name).toBe("second");
  });

  it("updateStep modifies step fields", () => {
    const op = store.create("update-step-test");
    const step = makeStep({ name: "build" });
    store.addStep(op.id, step);
    const updated = store.updateStep(op.id, step.id, { name: "compile", command: "tsc" });
    expect(updated.steps[0].name).toBe("compile");
    expect(updated.steps[0].command).toBe("tsc");
  });

  it("removeStep removes a step", () => {
    const op = store.create("remove-step-test");
    const step = makeStep();
    store.addStep(op.id, step);
    store.removeStep(op.id, step.id);
    expect(store.get(op.id)!.steps).toHaveLength(0);
  });

  it("reorderSteps assigns new order values", () => {
    const op = store.create("reorder-test");
    const s1 = makeStep({ order: 0, name: "first" });
    const s2 = makeStep({ order: 1, name: "second" });
    store.addStep(op.id, s1);
    store.addStep(op.id, s2);
    store.reorderSteps(op.id, [s2.id, s1.id]);
    const steps = store.get(op.id)!.steps;
    expect(steps[0].name).toBe("second");
    expect(steps[1].name).toBe("first");
  });

  it("updateDeployConfig merges partial config", () => {
    const op = store.create("config-test");
    store.updateDeployConfig(op.id, { healthCheckRetries: 5 });
    const config = store.get(op.id)!.deployConfig;
    expect(config.healthCheckRetries).toBe(5);
    expect(config.healthCheckEnabled).toBe(DEFAULT_DEPLOY_CONFIG.healthCheckEnabled);
  });
});

// ---------------------------------------------------------------------------
// PersistentOrderStore
// ---------------------------------------------------------------------------

describe("PersistentOrderStore", () => {
  let dbPath: string;
  let db: Database.Database;
  let store: PersistentOrderStore;

  beforeAll(() => {
    dbPath = tmpDbPath();
    db = openEntityDatabase(dbPath);
    store = new PersistentOrderStore(db);
  });

  afterAll(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("creates an order with unique id and timestamp", () => {
    const before = new Date();
    const order = store.create(makeOrderParams());
    expect(order.id).toBeDefined();
    expect(order.createdAt).toBeInstanceOf(Date);
    expect(order.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("gets by id", () => {
    const order = store.create(makeOrderParams());
    const fetched = store.get(order.id);
    expect(fetched).toBeDefined();
    expect(fetched!.operationName).toBe("web-app");
    expect(fetched!.createdAt).toBeInstanceOf(Date);
  });

  it("returns undefined for nonexistent id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("lists all orders", () => {
    const before = store.list().length;
    store.create(makeOrderParams());
    store.create(makeOrderParams({ version: "2.0.0" }));
    expect(store.list().length).toBe(before + 2);
  });

  it("getByOperation filters correctly", () => {
    const opId = crypto.randomUUID();
    store.create(makeOrderParams({ operationId: opId }));
    store.create(makeOrderParams({ operationId: opId }));
    expect(store.getByOperation(opId)).toHaveLength(2);
  });

  it("getByPartition filters correctly", () => {
    const partId = crypto.randomUUID();
    store.create(makeOrderParams({ partitionId: partId }));
    expect(store.getByPartition(partId)).toHaveLength(1);
  });

  it("stores and retrieves steps as JSON", () => {
    const steps = [makeStep({ name: "build" }), makeStep({ name: "test", order: 1 })];
    const order = store.create(makeOrderParams({ steps }));
    const fetched = store.get(order.id)!;
    expect(fetched.steps).toHaveLength(2);
    expect(fetched.steps[0].name).toBe("build");
    expect(fetched.steps[1].name).toBe("test");
  });

  it("stores and retrieves variables", () => {
    const variables = { APP_ENV: "prod", DB_HOST: "db-1" };
    const order = store.create(makeOrderParams({ variables }));
    const fetched = store.get(order.id)!;
    expect(fetched.variables).toEqual(variables);
  });
});

// ---------------------------------------------------------------------------
// PersistentDeploymentStore
// ---------------------------------------------------------------------------

describe("PersistentDeploymentStore", () => {
  let dbPath: string;
  let db: Database.Database;
  let store: PersistentDeploymentStore;

  beforeAll(() => {
    dbPath = tmpDbPath();
    db = openEntityDatabase(dbPath);
    store = new PersistentDeploymentStore(db);
  });

  afterAll(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("saves and retrieves a deployment", () => {
    const d = makeDeployment();
    store.save(d);
    const fetched = store.get(d.id);
    expect(fetched).toBeDefined();
    expect(fetched!.version).toBe("1.0.0");
    expect(fetched!.status).toBe("pending");
    expect(fetched!.createdAt).toBeInstanceOf(Date);
  });

  it("upserts (updates existing deployment)", () => {
    const d = makeDeployment();
    store.save(d);
    d.status = "succeeded";
    d.completedAt = new Date();
    store.save(d);
    const fetched = store.get(d.id)!;
    expect(fetched.status).toBe("succeeded");
    expect(fetched.completedAt).toBeInstanceOf(Date);
  });

  it("returns undefined for nonexistent id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("getByPartition filters correctly", () => {
    const partId = crypto.randomUUID();
    store.save(makeDeployment({ partitionId: partId }));
    store.save(makeDeployment({ partitionId: partId }));
    store.save(makeDeployment()); // different partition
    expect(store.getByPartition(partId)).toHaveLength(2);
  });

  it("lists all deployments", () => {
    const before = store.list().length;
    store.save(makeDeployment());
    expect(store.list().length).toBe(before + 1);
  });

  it("stores failure reason and orderId", () => {
    const d = makeDeployment({
      status: "failed",
      failureReason: "disk full",
      orderId: "order-1",
    });
    store.save(d);
    const fetched = store.get(d.id)!;
    expect(fetched.failureReason).toBe("disk full");
    expect(fetched.orderId).toBe("order-1");
  });

  it("stores and retrieves debrief entry IDs", () => {
    const d = makeDeployment({ debriefEntryIds: ["entry-1", "entry-2"] });
    store.save(d);
    const fetched = store.get(d.id)!;
    expect(fetched.debriefEntryIds).toEqual(["entry-1", "entry-2"]);
  });
});

// ---------------------------------------------------------------------------
// PersistentSettingsStore
// ---------------------------------------------------------------------------

describe("PersistentSettingsStore", () => {
  let dbPath: string;
  let db: Database.Database;
  let store: PersistentSettingsStore;

  beforeAll(() => {
    dbPath = tmpDbPath();
    db = openEntityDatabase(dbPath);
    store = new PersistentSettingsStore(db);
  });

  afterAll(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("returns defaults on first read", () => {
    const settings = store.get();
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("updates environmentsEnabled", () => {
    store.update({ environmentsEnabled: false });
    expect(store.get().environmentsEnabled).toBe(false);
    // Reset for subsequent tests
    store.update({ environmentsEnabled: true });
  });

  it("merges agent settings", () => {
    store.update({ agent: { conflictPolicy: "strict" } as any });
    const settings = store.get();
    expect(settings.agent.conflictPolicy).toBe("strict");
    expect(settings.agent.defaultHealthCheckRetries).toBe(
      DEFAULT_APP_SETTINGS.agent.defaultHealthCheckRetries,
    );
  });

  it("merges envoy settings", () => {
    store.update({ envoy: { url: "http://envoy:9000" } as any });
    const settings = store.get();
    expect(settings.envoy.url).toBe("http://envoy:9000");
    expect(settings.envoy.timeoutMs).toBe(DEFAULT_APP_SETTINGS.envoy.timeoutMs);
  });

  it("persists across store instances sharing the same db", () => {
    store.update({ environmentsEnabled: false });
    const store2 = new PersistentSettingsStore(db);
    expect(store2.get().environmentsEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Partition isolation — cross-store data boundaries
// ---------------------------------------------------------------------------

describe("Partition isolation", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeAll(() => {
    dbPath = tmpDbPath();
    db = openEntityDatabase(dbPath);
  });

  afterAll(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("deployments in different partitions are fully isolated", () => {
    const deployStore = new PersistentDeploymentStore(db);
    const partA = crypto.randomUUID();
    const partB = crypto.randomUUID();

    deployStore.save(makeDeployment({ partitionId: partA }));
    deployStore.save(makeDeployment({ partitionId: partA }));
    deployStore.save(makeDeployment({ partitionId: partB }));

    const aDeployments = deployStore.getByPartition(partA);
    const bDeployments = deployStore.getByPartition(partB);

    expect(aDeployments).toHaveLength(2);
    expect(bDeployments).toHaveLength(1);

    // No cross-contamination
    expect(aDeployments.every((d) => d.partitionId === partA)).toBe(true);
    expect(bDeployments.every((d) => d.partitionId === partB)).toBe(true);
  });

  it("orders in different partitions are fully isolated", () => {
    const orderStore = new PersistentOrderStore(db);
    const partA = crypto.randomUUID();
    const partB = crypto.randomUUID();

    orderStore.create(makeOrderParams({ partitionId: partA }));
    orderStore.create(makeOrderParams({ partitionId: partB }));
    orderStore.create(makeOrderParams({ partitionId: partB }));

    const aOrders = orderStore.getByPartition(partA);
    const bOrders = orderStore.getByPartition(partB);

    expect(aOrders).toHaveLength(1);
    expect(bOrders).toHaveLength(2);

    expect(aOrders.every((o) => o.partitionId === partA)).toBe(true);
    expect(bOrders.every((o) => o.partitionId === partB)).toBe(true);
  });
});
