import { describe, it, expect, afterEach } from "vitest";
import { PatternStore, computeConfidence } from "../src/pattern-store.js";
import type { CorrectionRecord } from "../src/pattern-store.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-store-test-"));
  return path.join(dir, "patterns.db");
}

const cleanup: (() => void)[] = [];

function createStore(): PatternStore {
  const dbPath = tmpDbPath();
  const store = new PatternStore(dbPath);
  cleanup.push(() => {
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
  });
  return store;
}

afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup.length = 0;
});

// ---------------------------------------------------------------------------
// computeConfidence tests
// ---------------------------------------------------------------------------

describe("computeConfidence", () => {
  it("returns 0 for empty corrections", () => {
    expect(computeConfidence([])).toBe(0);
  });

  it("returns 0.5 for a single correction", () => {
    const corrections: CorrectionRecord[] = [
      { timestamp: new Date(), field: "summary", from: "old", to: "new", artifactId: "a1" },
    ];
    expect(computeConfidence(corrections)).toBe(0.5);
  });

  it("boosts confidence for consistent corrections on the same field", () => {
    const corrections: CorrectionRecord[] = [
      { timestamp: new Date(), field: "summary", from: "old", to: "correct", artifactId: "a1" },
      { timestamp: new Date(), field: "summary", from: "old2", to: "correct", artifactId: "a2" },
    ];
    expect(computeConfidence(corrections)).toBe(0.65);
  });

  it("resets confidence on contradictory corrections", () => {
    const corrections: CorrectionRecord[] = [
      { timestamp: new Date(), field: "summary", from: "old", to: "correct-v1", artifactId: "a1" },
      { timestamp: new Date(), field: "summary", from: "old", to: "correct-v1", artifactId: "a2" },
      { timestamp: new Date(), field: "summary", from: "correct-v1", to: "correct-v2", artifactId: "a3" },
    ];
    // First: 0.5, second: 0.65, third: contradictory -> 0.5
    expect(computeConfidence(corrections)).toBe(0.5);
  });

  it("caps confidence at 0.95", () => {
    // Many consistent corrections
    const corrections: CorrectionRecord[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: new Date(),
      field: "summary",
      from: "old",
      to: "correct",
      artifactId: `a${i}`,
    }));
    expect(computeConfidence(corrections)).toBe(0.95);
  });

  it("tracks fields independently", () => {
    const corrections: CorrectionRecord[] = [
      { timestamp: new Date(), field: "summary", from: "a", to: "b", artifactId: "a1" },
      { timestamp: new Date(), field: "deploymentIntent", from: "x", to: "y", artifactId: "a1" },
      { timestamp: new Date(), field: "summary", from: "a", to: "b", artifactId: "a2" },
    ];
    // First (summary): 0.5
    // Second (deploymentIntent, new field): 0.5 (no boost)
    // Third (summary, consistent): 0.65
    expect(computeConfidence(corrections)).toBe(0.65);
  });
});

// ---------------------------------------------------------------------------
// PatternStore CRUD tests
// ---------------------------------------------------------------------------

describe("PatternStore — CRUD", () => {
  it("creates a pattern on first correction", () => {
    const store = createStore();
    const pattern = store.recordCorrection(
      { source: "docker-registry", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "generic", to: "Production Node.js service", artifactId: "art-1" },
    );

    expect(pattern.id).toBeDefined();
    expect(pattern.source).toBe("docker-registry");
    expect(pattern.artifactType).toBe("dockerfile");
    expect(pattern.namePattern).toBe("Dockerfile");
    expect(pattern.corrections.length).toBe(1);
    expect(pattern.confidence).toBe(0.5);
    expect(pattern.appliedCount).toBe(0);
    expect(pattern.derivedAnalysis.summary).toBe("Production Node.js service");
  });

  it("appends to existing pattern on subsequent corrections", () => {
    const store = createStore();
    store.recordCorrection(
      { source: "s3", artifactType: "node-package", namePattern: "package.json" },
      { field: "summary", from: "a", to: "b", artifactId: "art-1" },
    );

    const updated = store.recordCorrection(
      { source: "s3", artifactType: "node-package", namePattern: "package.json" },
      { field: "summary", from: "a", to: "b", artifactId: "art-2" },
    );

    expect(updated.corrections.length).toBe(2);
    expect(updated.confidence).toBe(0.65);
  });

  it("retrieves pattern by ID", () => {
    const store = createStore();
    const created = store.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "*" },
      { field: "deploymentIntent", from: "", to: "ECS Fargate", artifactId: "a1" },
    );

    const fetched = store.getById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.derivedAnalysis.deploymentIntent).toBe("ECS Fargate");
  });

  it("lists all patterns", () => {
    const store = createStore();
    store.recordCorrection(
      { source: "s1", artifactType: "t1", namePattern: "p1" },
      { field: "summary", from: "", to: "x", artifactId: "a1" },
    );
    store.recordCorrection(
      { source: "s2", artifactType: "t2", namePattern: "p2" },
      { field: "summary", from: "", to: "y", artifactId: "a2" },
    );

    const all = store.listAll();
    expect(all.length).toBe(2);
  });

  it("deletes a pattern", () => {
    const store = createStore();
    const pattern = store.recordCorrection(
      { source: "s1", artifactType: "t1", namePattern: "p1" },
      { field: "summary", from: "", to: "x", artifactId: "a1" },
    );

    const deleted = store.delete(pattern.id);
    expect(deleted).toBe(true);
    expect(store.getById(pattern.id)).toBeUndefined();
  });

  it("returns false when deleting non-existent pattern", () => {
    const store = createStore();
    expect(store.delete("nonexistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PatternStore — matching tests
// ---------------------------------------------------------------------------

describe("PatternStore — matching", () => {
  it("finds exact name matches", () => {
    const store = createStore();
    store.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "", to: "x", artifactId: "a1" },
    );

    const matches = store.findMatches("ecr", "dockerfile", "Dockerfile");
    expect(matches.length).toBe(1);
    expect(matches[0].mode).toBe("suggest"); // only 1 correction, < 0.7
  });

  it("finds glob pattern matches", () => {
    const store = createStore();
    store.recordCorrection(
      { source: "s3", artifactType: "tarball", namePattern: "release-*.tar.gz" },
      { field: "summary", from: "", to: "x", artifactId: "a1" },
    );

    const matches = store.findMatches("s3", "tarball", "release-v2.3.tar.gz");
    expect(matches.length).toBe(1);
  });

  it("does not match different source", () => {
    const store = createStore();
    store.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "", to: "x", artifactId: "a1" },
    );

    const matches = store.findMatches("s3", "dockerfile", "Dockerfile");
    expect(matches.length).toBe(0);
  });

  it("does not match different artifact type", () => {
    const store = createStore();
    store.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "", to: "x", artifactId: "a1" },
    );

    const matches = store.findMatches("ecr", "node-package", "Dockerfile");
    expect(matches.length).toBe(0);
  });

  it("returns 'auto' mode when >= 2 corrections and confidence >= 0.7", () => {
    const store = createStore();
    // Build up to >= 2 corrections with consistent values
    store.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "", to: "corrected", artifactId: "a1" },
    );
    store.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "", to: "corrected", artifactId: "a2" },
    );
    // confidence is now 0.65, not yet 0.7
    store.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "", to: "corrected", artifactId: "a3" },
    );
    // confidence is now 0.80

    const matches = store.findMatches("ecr", "dockerfile", "Dockerfile");
    expect(matches.length).toBe(1);
    expect(matches[0].mode).toBe("auto");
    expect(matches[0].pattern.confidence).toBe(0.8);
  });

  it("returns 'suggest' mode when corrections < 2", () => {
    const store = createStore();
    store.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "", to: "corrected", artifactId: "a1" },
    );

    const matches = store.findMatches("ecr", "dockerfile", "Dockerfile");
    expect(matches[0].mode).toBe("suggest");
  });

  it("tracks application count", () => {
    const store = createStore();
    const pattern = store.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "", to: "corrected", artifactId: "a1" },
    );

    expect(pattern.appliedCount).toBe(0);
    store.recordApplication(pattern.id);
    store.recordApplication(pattern.id);

    const updated = store.getById(pattern.id);
    expect(updated!.appliedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// PatternStore — derived analysis
// ---------------------------------------------------------------------------

describe("PatternStore — derived analysis", () => {
  it("derives summary from corrections", () => {
    const store = createStore();
    const pattern = store.recordCorrection(
      { source: "s", artifactType: "t", namePattern: "p" },
      { field: "summary", from: "old", to: "New summary", artifactId: "a1" },
    );
    expect(pattern.derivedAnalysis.summary).toBe("New summary");
  });

  it("derives deploymentIntent from corrections", () => {
    const store = createStore();
    const pattern = store.recordCorrection(
      { source: "s", artifactType: "t", namePattern: "p" },
      { field: "deploymentIntent", from: "", to: "Kubernetes CronJob", artifactId: "a1" },
    );
    expect(pattern.derivedAnalysis.deploymentIntent).toBe("Kubernetes CronJob");
  });

  it("derives dependencies from comma-separated corrections", () => {
    const store = createStore();
    const pattern = store.recordCorrection(
      { source: "s", artifactType: "t", namePattern: "p" },
      { field: "dependencies", from: "", to: "redis, postgresql, rabbitmq", artifactId: "a1" },
    );
    expect(pattern.derivedAnalysis.dependencies).toEqual(["redis", "postgresql", "rabbitmq"]);
  });

  it("derives configuration expectations from config.* fields", () => {
    const store = createStore();
    store.recordCorrection(
      { source: "s", artifactType: "t", namePattern: "p" },
      { field: "config.DATABASE_URL", from: "", to: "PostgreSQL connection string", artifactId: "a1" },
    );
    const pattern = store.recordCorrection(
      { source: "s", artifactType: "t", namePattern: "p" },
      { field: "config.REDIS_URL", from: "", to: "Redis connection URL", artifactId: "a1" },
    );
    expect(pattern.derivedAnalysis.configurationExpectations).toEqual({
      DATABASE_URL: "PostgreSQL connection string",
      REDIS_URL: "Redis connection URL",
    });
  });

  it("uses latest correction value when field is corrected multiple times", () => {
    const store = createStore();
    store.recordCorrection(
      { source: "s", artifactType: "t", namePattern: "p" },
      { field: "summary", from: "old", to: "first correction", artifactId: "a1" },
    );
    const pattern = store.recordCorrection(
      { source: "s", artifactType: "t", namePattern: "p" },
      { field: "summary", from: "first correction", to: "second correction", artifactId: "a2" },
    );
    // Note: this is a contradictory correction (different `to` value)
    expect(pattern.derivedAnalysis.summary).toBe("second correction");
    // Confidence should reset due to contradiction
    expect(pattern.confidence).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// PatternStore — persistence
// ---------------------------------------------------------------------------

describe("PatternStore — persistence", () => {
  it("survives close and reopen", () => {
    const dbPath = tmpDbPath();
    cleanup.push(() => {
      try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
      try { fs.rmdirSync(path.dirname(dbPath)); } catch { /* ignore */ }
    });

    // Write
    const store1 = new PatternStore(dbPath);
    store1.recordCorrection(
      { source: "ecr", artifactType: "dockerfile", namePattern: "Dockerfile" },
      { field: "summary", from: "", to: "Persisted summary", artifactId: "a1" },
    );
    store1.close();

    // Reopen
    const store2 = new PatternStore(dbPath);
    const patterns = store2.listAll();
    expect(patterns.length).toBe(1);
    expect(patterns[0].derivedAnalysis.summary).toBe("Persisted summary");
    store2.close();
  });
});
