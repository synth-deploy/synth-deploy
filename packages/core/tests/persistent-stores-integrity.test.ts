import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  openEntityDatabase,
  safeJsonParse,
  PersistentPartitionStore,
  PersistentEnvironmentStore,
  PersistentDeploymentStore,
  PersistentSettingsStore,
} from "../src/persistent-stores.js";
import { DEFAULT_APP_SETTINGS } from "../src/types.js";
import type { Deployment } from "../src/types.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDbPath(): string {
  return path.join(os.tmpdir(), "test-integrity-" + crypto.randomUUID() + ".db");
}

// ---------------------------------------------------------------------------
// safeJsonParse
// ---------------------------------------------------------------------------

describe("safeJsonParse", () => {
  it("parses valid JSON normally", () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJsonParse("[]", [])).toEqual([]);
    expect(safeJsonParse('"hello"', "")).toBe("hello");
  });

  it("returns fallback for corrupted JSON without throwing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = safeJsonParse("NOT_JSON{{", { fallback: true });
    expect(result).toEqual({ fallback: true });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("Corrupted JSON skipped");
    warnSpy.mockRestore();
  });

  it("includes table/row/column context in warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    safeJsonParse("{bad", [], { table: "orders", rowId: "abc-123", column: "steps" });
    expect(warnSpy.mock.calls[0][0]).toContain("table=orders");
    expect(warnSpy.mock.calls[0][0]).toContain("row=abc-123");
    expect(warnSpy.mock.calls[0][0]).toContain("column=steps");
    warnSpy.mockRestore();
  });

  it("truncates long corrupted values in the warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const longBadJson = "X".repeat(500);
    safeJsonParse(longBadJson, {});
    // The warning should contain at most 120 chars of the bad value
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).not.toContain("X".repeat(200));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Integrity check on database open
// ---------------------------------------------------------------------------

describe("Database integrity check on open", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    // Also try to clean up WAL/SHM files
    try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  it("opens a fresh database without warnings", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = openEntityDatabase(dbPath);
    // No integrity warning should fire on a fresh database
    const integrityWarnings = warnSpy.mock.calls.filter(
      (call) => String(call[0]).includes("integrity check warning"),
    );
    expect(integrityWarnings).toHaveLength(0);
    db.close();
    warnSpy.mockRestore();
  });

  it("creates schema_version table with correct version", () => {
    const db = openEntityDatabase(dbPath);
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(row.version).toBe(11);
    db.close();
  });

  it("warns on schema version mismatch without crashing", () => {
    // First open creates version 11
    const db1 = openEntityDatabase(dbPath);
    // Manually bump the stored version to simulate a future schema
    db1.prepare("UPDATE schema_version SET version = 999").run();
    db1.close();

    // Second open should warn about mismatch but not crash
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db2 = openEntityDatabase(dbPath);
    const versionWarnings = warnSpy.mock.calls.filter(
      (call) => String(call[0]).includes("Schema version mismatch"),
    );
    expect(versionWarnings).toHaveLength(1);
    expect(String(versionWarnings[0][0])).toContain("v999");
    db2.close();
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Corrupted JSON rows handled gracefully
// ---------------------------------------------------------------------------

describe("Corrupted JSON recovery", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openEntityDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  it("partition with corrupted variables JSON returns empty object instead of crashing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = crypto.randomUUID();

    // Insert a partition with corrupted JSON in the variables column
    db.prepare(
      "INSERT INTO partitions (id, name, variables, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, "corrupted-partition", "NOT_VALID_JSON", new Date().toISOString());

    const store = new PersistentPartitionStore(db);
    const partition = store.get(id);

    expect(partition).toBeDefined();
    expect(partition!.name).toBe("corrupted-partition");
    expect(partition!.variables).toEqual({}); // fallback
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("environment with corrupted variables JSON returns empty object instead of crashing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = crypto.randomUUID();

    db.prepare(
      "INSERT INTO environments (id, name, variables) VALUES (?, ?, ?)",
    ).run(id, "corrupted-env", "{{{broken");

    const store = new PersistentEnvironmentStore(db);
    const env = store.get(id);

    expect(env).toBeDefined();
    expect(env!.name).toBe("corrupted-env");
    expect(env!.variables).toEqual({});
    warnSpy.mockRestore();
  });

  it("deployment with corrupted JSON columns returns fallback values instead of crashing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = crypto.randomUUID();

    db.prepare(
      `INSERT INTO deployments (id, artifact_id, environment_id, partition_id, version, status, variables, debrief_entry_ids, created_at, completed_at, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, "art-1", "env-1", "part-1", "1.0.0", "pending",
      "CORRUPT_VARS", "CORRUPT_IDS",
      new Date().toISOString(), null, null,
    );

    const store = new PersistentDeploymentStore(db);
    const deployment = store.get(id);

    expect(deployment).toBeDefined();
    expect(deployment!.variables).toEqual({});
    expect(deployment!.debriefEntryIds).toEqual([]);
    expect(deployment!.version).toBe("1.0.0");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("settings with corrupted JSON returns defaults instead of crashing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Manually corrupt the settings value
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
      "app", "TOTALLY_BROKEN_JSON",
    );

    const store = new PersistentSettingsStore(db);
    const settings = store.get();

    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("list() with mix of good and corrupted rows returns all rows with fallbacks", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new PersistentPartitionStore(db);

    // Create a good partition through the store
    const good = store.create("good-partition", { REGION: "us-east" });

    // Inject a corrupted partition directly
    const corruptId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO partitions (id, name, variables, created_at) VALUES (?, ?, ?, ?)",
    ).run(corruptId, "bad-partition", "<<<CORRUPT>>>", new Date().toISOString());

    const all = store.list();
    const goodResult = all.find((p) => p.id === good.id);
    const badResult = all.find((p) => p.id === corruptId);

    expect(goodResult).toBeDefined();
    expect(goodResult!.variables).toEqual({ REGION: "us-east" });

    expect(badResult).toBeDefined();
    expect(badResult!.name).toBe("bad-partition");
    expect(badResult!.variables).toEqual({}); // fallback, not crash
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Normal operation still works after integrity additions
// ---------------------------------------------------------------------------

describe("Normal operation unaffected by integrity checks", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = openEntityDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  it("partition CRUD works normally", () => {
    const store = new PersistentPartitionStore(db);
    const p = store.create("Test Corp", { REGION: "eu-west" });
    expect(p.name).toBe("Test Corp");
    expect(p.variables).toEqual({ REGION: "eu-west" });

    const fetched = store.get(p.id);
    expect(fetched!.variables.REGION).toBe("eu-west");

    store.setVariables(p.id, { TIER: "premium" });
    expect(store.get(p.id)!.variables).toEqual({ REGION: "eu-west", TIER: "premium" });
  });

  it("deployment save/get roundtrips correctly", () => {
    const store = new PersistentDeploymentStore(db);
    const d: Deployment = {
      id: crypto.randomUUID(),
      artifactId: crypto.randomUUID(),
      partitionId: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
      version: "2.0.0",
      status: "succeeded",
      variables: { APP_ENV: "production" },
      debriefEntryIds: ["entry-1", "entry-2"],
      createdAt: new Date(),
      completedAt: new Date(),
      failureReason: "none",
    };
    store.save(d);
    const fetched = store.get(d.id)!;
    expect(fetched.variables).toEqual({ APP_ENV: "production" });
    expect(fetched.debriefEntryIds).toEqual(["entry-1", "entry-2"]);
    expect(fetched.status).toBe("succeeded");
  });

  it("settings roundtrip works correctly", () => {
    const store = new PersistentSettingsStore(db);
    const defaults = store.get();
    expect(defaults).toEqual(DEFAULT_APP_SETTINGS);

    store.update({ environmentsEnabled: false });
    expect(store.get().environmentsEnabled).toBe(false);
  });
});
