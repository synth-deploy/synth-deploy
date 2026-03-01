import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PersistentDecisionDebrief } from "../src/debrief-persistence.js";

describe("PersistentDecisionDebrief.purgeOlderThan", () => {
  const tmpFiles: string[] = [];

  function createTestDebrief(): PersistentDecisionDebrief {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "debrief-retention-"));
    const dbPath = path.join(tmpDir, "test-debrief.db");
    tmpFiles.push(tmpDir);
    return new PersistentDecisionDebrief(dbPath);
  }

  afterEach(() => {
    for (const dir of tmpFiles) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpFiles.length = 0;
  });

  it("purges entries older than the cutoff date", () => {
    const debrief = createTestDebrief();

    // Record an entry
    debrief.record({
      partitionId: "p1",
      deploymentId: null,
      agent: "command",
      decisionType: "system",
      decision: "old entry",
      reasoning: "test",
    });

    // Purge with a cutoff in the future (should purge everything)
    const cutoff = new Date(Date.now() + 60_000);
    const count = debrief.purgeOlderThan(cutoff);

    expect(count).toBe(1);
    expect(debrief.getRecent(10)).toHaveLength(0);

    debrief.close();
  });

  it("does not purge entries newer than cutoff", () => {
    const debrief = createTestDebrief();

    debrief.record({
      partitionId: "p1",
      deploymentId: null,
      agent: "command",
      decisionType: "system",
      decision: "recent entry",
      reasoning: "test",
    });

    // Cutoff in the past — should not purge anything
    const cutoff = new Date(Date.now() - 60_000);
    const count = debrief.purgeOlderThan(cutoff);

    expect(count).toBe(0);
    expect(debrief.getRecent(10)).toHaveLength(1);

    debrief.close();
  });

  it("returns 0 when database is empty", () => {
    const debrief = createTestDebrief();
    const cutoff = new Date();
    const count = debrief.purgeOlderThan(cutoff);
    expect(count).toBe(0);
    debrief.close();
  });
});
