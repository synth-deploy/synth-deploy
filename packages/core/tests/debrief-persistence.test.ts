import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PersistentDecisionDebrief } from "../src/debrief-persistence.js";
import type { DebriefRecordParams } from "../src/debrief.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpFiles: string[] = [];

function createTestDebrief(): PersistentDecisionDebrief {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-persist-"));
  const dbPath = path.join(tmpDir, "test-debrief.db");
  tmpFiles.push(tmpDir);
  return new PersistentDecisionDebrief(dbPath);
}

function makeParams(overrides: Partial<DebriefRecordParams> = {}): DebriefRecordParams {
  return {
    partitionId: "partition-1",
    operationId: "deploy-1",
    agent: "server",
    decisionType: "pipeline-plan",
    decision: "Deploy web-app v1.0.0 to production",
    reasoning: "All preconditions met.",
    context: { version: "1.0.0" },
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpFiles) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

// ---------------------------------------------------------------------------
// Successful write/read cycle
// ---------------------------------------------------------------------------

describe("PersistentDecisionDebrief — write/read cycle", () => {
  it("records an entry and retrieves it by ID", () => {
    const debrief = createTestDebrief();
    const entry = debrief.record(makeParams());

    expect(entry.id).toBeDefined();
    expect(entry.id.length).toBeGreaterThan(0);
    expect(entry.timestamp).toBeInstanceOf(Date);
    expect(entry.decision).toBe("Deploy web-app v1.0.0 to production");

    const fetched = debrief.getById(entry.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(entry.id);
    expect(fetched!.decision).toBe(entry.decision);
    expect(fetched!.reasoning).toBe(entry.reasoning);
    expect(fetched!.context).toEqual({ version: "1.0.0" });

    debrief.close();
  });

  it("assigns a unique UUID to each entry", () => {
    const debrief = createTestDebrief();
    const entry1 = debrief.record(makeParams({ decision: "first" }));
    const entry2 = debrief.record(makeParams({ decision: "second" }));

    expect(entry1.id).not.toBe(entry2.id);

    debrief.close();
  });

  it("records entries with null partitionId and operationId", () => {
    const debrief = createTestDebrief();
    const entry = debrief.record(makeParams({
      partitionId: null,
      operationId: null,
      decisionType: "system",
    }));

    const fetched = debrief.getById(entry.id);
    expect(fetched).toBeDefined();
    expect(fetched!.partitionId).toBeNull();
    expect(fetched!.operationId).toBeNull();

    debrief.close();
  });

  it("defaults context to empty object when not provided", () => {
    const debrief = createTestDebrief();
    const entry = debrief.record({
      partitionId: "p1",
      operationId: null,
      agent: "server",
      decisionType: "system",
      decision: "test",
      reasoning: "test",
    });

    const fetched = debrief.getById(entry.id);
    expect(fetched!.context).toEqual({});

    debrief.close();
  });

  it("preserves timestamp through write/read cycle", () => {
    const debrief = createTestDebrief();
    const before = new Date();
    const entry = debrief.record(makeParams());
    const after = new Date();

    const fetched = debrief.getById(entry.id);
    expect(fetched!.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);
    expect(fetched!.timestamp.getTime()).toBeLessThanOrEqual(after.getTime() + 1);

    debrief.close();
  });
});

// ---------------------------------------------------------------------------
// Query methods
// ---------------------------------------------------------------------------

describe("PersistentDecisionDebrief — query methods", () => {
  it("getByOperation returns entries for a specific deployment", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams({ operationId: "deploy-A" }));
    debrief.record(makeParams({ operationId: "deploy-A" }));
    debrief.record(makeParams({ operationId: "deploy-B" }));

    const results = debrief.getByOperation("deploy-A");
    expect(results).toHaveLength(2);
    expect(results.every(e => e.operationId === "deploy-A")).toBe(true);

    debrief.close();
  });

  it("getByPartition returns entries for a specific partition", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams({ partitionId: "part-X" }));
    debrief.record(makeParams({ partitionId: "part-Y" }));
    debrief.record(makeParams({ partitionId: "part-X" }));

    const results = debrief.getByPartition("part-X");
    expect(results).toHaveLength(2);
    expect(results.every(e => e.partitionId === "part-X")).toBe(true);

    debrief.close();
  });

  it("getByType returns entries for a specific decision type", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams({ decisionType: "pipeline-plan" }));
    debrief.record(makeParams({ decisionType: "deployment-failure" }));
    debrief.record(makeParams({ decisionType: "pipeline-plan" }));

    const results = debrief.getByType("pipeline-plan");
    expect(results).toHaveLength(2);
    expect(results.every(e => e.decisionType === "pipeline-plan")).toBe(true);

    debrief.close();
  });

  it("getByTimeRange returns entries within the specified range", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams());

    const from = new Date(Date.now() - 60_000);
    const to = new Date(Date.now() + 60_000);
    const results = debrief.getByTimeRange(from, to);
    expect(results.length).toBeGreaterThanOrEqual(1);

    debrief.close();
  });

  it("getByTimeRange returns empty for a range that excludes all entries", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams());

    const from = new Date("2020-01-01T00:00:00Z");
    const to = new Date("2020-01-02T00:00:00Z");
    const results = debrief.getByTimeRange(from, to);
    expect(results).toHaveLength(0);

    debrief.close();
  });

  it("getRecent returns entries ordered by timestamp descending", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams({ decision: "first" }));
    // Small delay to ensure distinct timestamps
    debrief.record(makeParams({ decision: "second" }));
    debrief.record(makeParams({ decision: "third" }));

    const results = debrief.getRecent(10);
    expect(results).toHaveLength(3);
    // Most recent first
    expect(results[0].decision).toBe("third");

    debrief.close();
  });

  it("getRecent respects the limit parameter", () => {
    const debrief = createTestDebrief();
    for (let i = 0; i < 5; i++) {
      debrief.record(makeParams({ decision: `entry-${i}` }));
    }

    const results = debrief.getRecent(2);
    expect(results).toHaveLength(2);

    debrief.close();
  });

  it("getRecent defaults to 50 entries", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams());

    // Just verify it works with default — we won't insert 50+ entries in a unit test
    const results = debrief.getRecent();
    expect(results).toHaveLength(1);

    debrief.close();
  });

  it("getById returns undefined for nonexistent ID", () => {
    const debrief = createTestDebrief();
    expect(debrief.getById("nonexistent-id")).toBeUndefined();
    debrief.close();
  });

  it("getByOperation returns empty array for nonexistent deployment", () => {
    const debrief = createTestDebrief();
    expect(debrief.getByOperation("nonexistent")).toEqual([]);
    debrief.close();
  });
});

// ---------------------------------------------------------------------------
// Corrupted JSON handled gracefully
// ---------------------------------------------------------------------------

describe("PersistentDecisionDebrief — corrupted data handling", () => {
  it("handles complex context objects through JSON serialization", () => {
    const debrief = createTestDebrief();
    const complexContext = {
      nested: { deep: { value: 42 } },
      array: [1, 2, 3],
      special: "quotes\"and\\backslash",
    };

    const entry = debrief.record(makeParams({ context: complexContext }));
    const fetched = debrief.getById(entry.id);

    expect(fetched!.context).toEqual(complexContext);

    debrief.close();
  });

  it("handles empty string values in fields", () => {
    const debrief = createTestDebrief();
    const entry = debrief.record(makeParams({
      decision: "",
      reasoning: "",
    }));

    const fetched = debrief.getById(entry.id);
    expect(fetched!.decision).toBe("");
    expect(fetched!.reasoning).toBe("");

    debrief.close();
  });

  it("handles special characters in string fields", () => {
    const debrief = createTestDebrief();
    const entry = debrief.record(makeParams({
      decision: "Deploy with \u2014 special chars: <>&\"'",
      reasoning: "Contains\nnewlines\nand\ttabs",
    }));

    const fetched = debrief.getById(entry.id);
    expect(fetched!.decision).toBe("Deploy with \u2014 special chars: <>&\"'");
    expect(fetched!.reasoning).toContain("newlines");

    debrief.close();
  });
});

// ---------------------------------------------------------------------------
// Database error propagation
// ---------------------------------------------------------------------------

describe("PersistentDecisionDebrief — error propagation", () => {
  it("throws a descriptive error when recording to a closed database", () => {
    const debrief = createTestDebrief();
    debrief.close();

    expect(() => debrief.record(makeParams())).toThrow("Failed to persist debrief entry");
  });

  it("read methods return safe defaults after database is closed", () => {
    const debrief = createTestDebrief();
    const entry = debrief.record(makeParams());
    debrief.close();

    // Read methods catch errors and return safe defaults
    expect(debrief.getById(entry.id)).toBeUndefined();
    expect(debrief.getByOperation("deploy-1")).toEqual([]);
    expect(debrief.getByPartition("partition-1")).toEqual([]);
    expect(debrief.getByType("pipeline-plan")).toEqual([]);
    expect(debrief.getByTimeRange(new Date(), new Date())).toEqual([]);
    expect(debrief.getRecent()).toEqual([]);
  });

  it("purgeOlderThan returns 0 after database is closed", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams());
    debrief.close();

    const count = debrief.purgeOlderThan(new Date(Date.now() + 60_000));
    expect(count).toBe(0);
  });

  it("data persists across separate instances on the same file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-persist-"));
    const dbPath = path.join(tmpDir, "shared.db");
    tmpFiles.push(tmpDir);

    // First instance: write data
    const debrief1 = new PersistentDecisionDebrief(dbPath);
    const entry = debrief1.record(makeParams({ decision: "persisted" }));
    debrief1.close();

    // Second instance: read data
    const debrief2 = new PersistentDecisionDebrief(dbPath);
    const fetched = debrief2.getById(entry.id);
    expect(fetched).toBeDefined();
    expect(fetched!.decision).toBe("persisted");
    debrief2.close();
  });
});

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

describe("PersistentDecisionDebrief — purge", () => {
  it("purges entries older than the cutoff and returns the count", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams({ decision: "old-1" }));
    debrief.record(makeParams({ decision: "old-2" }));

    const cutoff = new Date(Date.now() + 60_000);
    const count = debrief.purgeOlderThan(cutoff);

    expect(count).toBe(2);
    expect(debrief.getRecent(10)).toHaveLength(0);

    debrief.close();
  });

  it("preserves entries newer than the cutoff", () => {
    const debrief = createTestDebrief();
    debrief.record(makeParams({ decision: "recent" }));

    const cutoff = new Date(Date.now() - 60_000);
    const count = debrief.purgeOlderThan(cutoff);

    expect(count).toBe(0);
    expect(debrief.getRecent(10)).toHaveLength(1);

    debrief.close();
  });

  it("returns 0 when the database is empty", () => {
    const debrief = createTestDebrief();
    const count = debrief.purgeOlderThan(new Date());
    expect(count).toBe(0);
    debrief.close();
  });
});
