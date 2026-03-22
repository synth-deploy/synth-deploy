import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  openEntityDatabase,
  PersistentPartitionStore,
  PersistentEnvironmentStore,
  PersistentSettingsStore,
  PersistentDeploymentStore,
} from "../src/persistent-stores.js";
import { DEFAULT_APP_SETTINGS } from "../src/types.js";
import type { Deployment } from "../src/types.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath(): string {
  return path.join(os.tmpdir(), "test-" + crypto.randomUUID() + ".db");
}

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: crypto.randomUUID(),
    input: { type: "deploy", artifactId: crypto.randomUUID() },
    partitionId: crypto.randomUUID(),
    environmentId: crypto.randomUUID(),
    version: "1.0.0",
    status: "pending",
    variables: {},
    debriefEntryIds: [],
    createdAt: new Date(),
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

  it("stores failure reason and artifactVersionId", () => {
    const d = makeDeployment({
      status: "failed",
      failureReason: "disk full",
      input: { type: "deploy", artifactId: crypto.randomUUID(), artifactVersionId: "ver-1" },
    });
    store.save(d);
    const fetched = store.get(d.id)!;
    expect(fetched.failureReason).toBe("disk full");
    expect((fetched.input as { type: "deploy"; artifactId: string; artifactVersionId?: string }).artifactVersionId).toBe("ver-1");
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
});
