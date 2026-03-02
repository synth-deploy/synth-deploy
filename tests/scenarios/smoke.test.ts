/**
 * Scenario smoke tests — Phase 2 of #98
 *
 * These test real user journeys (not HTTP contract compliance). Each test
 * exercises multiple API calls in sequence, the way an engineer would use
 * the system: create entities, deploy, inspect results, query the debrief.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ScenarioHarness } from "./harness.js";
import {
  createHarness,
  teardownHarness,
  http,
  createPartition,
  createEnvironment,
  createOperation,
  linkEnvironment,
  deploy,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Harness lifecycle
// ---------------------------------------------------------------------------

let h: ScenarioHarness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await teardownHarness(h);
});

// ===========================================================================
// 1. Deploy happy path
// ===========================================================================

describe("Deploy happy path", () => {
  let operationId: string;
  let partitionId: string;
  let environmentId: string;
  let deploymentId: string;

  it("creates operation → environment → partition → order → trigger → verifies", async () => {
    operationId = await createOperation(h.command.baseUrl, "web-app");
    environmentId = await createEnvironment(h.command.baseUrl, "production", {
      APP_ENV: "production",
      LOG_LEVEL: "warn",
    });
    await linkEnvironment(h.command.baseUrl, operationId, environmentId);
    partitionId = await createPartition(h.command.baseUrl, "Acme Corp", {
      DB_HOST: "acme-db.internal",
      REGION: "us-east-1",
    });

    const res = await deploy(h.command.baseUrl, {
      operationId,
      partitionId,
      environmentId,
      version: "1.0.0",
    });

    expect(res.status).toBe(201);
    const dep = res.body.deployment as Record<string, unknown>;
    deploymentId = dep.id as string;
    expect(dep.version).toBe("1.0.0");
    expect(dep.status).toBeDefined();
  });

  it("deployment has debrief entries with actionable detail", async () => {
    const res = await http(h.command.baseUrl, "GET", `/api/deployments/${deploymentId}`);
    expect(res.status).toBe(200);

    const entries = res.body.debrief as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(3);

    for (const entry of entries) {
      // Every entry must have actionable reasoning (≥20 chars, not generic)
      expect((entry.reasoning as string).length).toBeGreaterThanOrEqual(20);
      expect(entry.partitionId).toBe(partitionId);
      expect(entry.deploymentId).toBe(deploymentId);
      expect(["command", "envoy"]).toContain(entry.agent);
    }
  });

  it("debrief includes pipeline-plan and configuration-resolved decisions", async () => {
    const res = await http(h.command.baseUrl, "GET", `/api/deployments/${deploymentId}`);
    const entries = res.body.debrief as Array<Record<string, unknown>>;
    const types = new Set(entries.map((e) => e.decisionType as string));

    expect(types.has("pipeline-plan")).toBe(true);
    expect(types.has("configuration-resolved")).toBe(true);
  });
});

// ===========================================================================
// 2. Deploy failure + investigation
// ===========================================================================

describe("Deploy failure investigation", () => {
  it("failed deployment produces actionable debrief explaining why", async () => {
    const opId = await createOperation(h.command.baseUrl, "failing-service");
    const envId = await createEnvironment(h.command.baseUrl, "broken-env");
    await linkEnvironment(h.command.baseUrl, opId, envId);
    const partId = await createPartition(h.command.baseUrl, "FailCo");

    const res = await deploy(h.command.baseUrl, {
      operationId: opId,
      partitionId: partId,
      environmentId: envId,
      version: "0.0.1",
    });

    // Deployment may succeed or fail depending on pipeline — either way, debrief exists
    expect(res.status).toBe(201);
    const dep = res.body.deployment as Record<string, unknown>;
    const depId = dep.id as string;

    const detailRes = await http(h.command.baseUrl, "GET", `/api/deployments/${depId}`);
    const entries = detailRes.body.debrief as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // Every debrief entry is specific enough to act on
    for (const entry of entries) {
      expect((entry.decision as string).length).toBeGreaterThan(0);
      expect((entry.reasoning as string).length).toBeGreaterThanOrEqual(20);
    }
  });

  it("postmortem endpoint returns structured analysis", async () => {
    // Deploy something so we have a deployment to get postmortem for
    const opId = await createOperation(h.command.baseUrl, "postmortem-svc");
    const envId = await createEnvironment(h.command.baseUrl, "postmortem-env");
    await linkEnvironment(h.command.baseUrl, opId, envId);
    const partId = await createPartition(h.command.baseUrl, "PostmortemCo");

    const res = await deploy(h.command.baseUrl, {
      operationId: opId,
      partitionId: partId,
      environmentId: envId,
      version: "1.0.0",
    });

    const depId = (res.body.deployment as Record<string, unknown>).id as string;
    const pmRes = await http(h.command.baseUrl, "GET", `/api/deployments/${depId}/postmortem`);
    expect(pmRes.status).toBe(200);
    expect(pmRes.body.postmortem).toBeDefined();
  });
});

// ===========================================================================
// 3. Multi-partition batch — isolation under stress
// ===========================================================================

describe("Multi-partition isolation", () => {
  let operationId: string;
  let environmentId: string;
  const partitions: Array<{ id: string; name: string }> = [];
  const deploymentIds: string[] = [];

  it("deploys same operation across 3 partitions", async () => {
    operationId = await createOperation(h.command.baseUrl, "batch-deploy-svc");
    environmentId = await createEnvironment(h.command.baseUrl, "batch-env", {
      APP_ENV: "staging",
    });
    await linkEnvironment(h.command.baseUrl, operationId, environmentId);

    for (const name of ["Alpha Inc", "Beta LLC", "Gamma Corp"]) {
      const id = await createPartition(h.command.baseUrl, name, {
        TENANT: name.toLowerCase().replace(/\s+/g, "-"),
      });
      partitions.push({ id, name });
    }

    // Deploy v1.0.0 to all three
    for (const p of partitions) {
      const res = await deploy(h.command.baseUrl, {
        operationId,
        partitionId: p.id,
        environmentId,
        version: "1.0.0",
      });
      expect(res.status).toBe(201);
      deploymentIds.push(
        (res.body.deployment as Record<string, unknown>).id as string,
      );
    }
  });

  it("partition A deployments are NOT visible when querying partition B", async () => {
    for (let i = 0; i < partitions.length; i++) {
      const res = await http(
        h.command.baseUrl,
        "GET",
        `/api/deployments?partitionId=${partitions[i].id}`,
      );
      const deps = res.body.deployments as Array<Record<string, unknown>>;

      // Every deployment returned belongs to THIS partition only
      for (const dep of deps) {
        expect(dep.partitionId).toBe(partitions[i].id);
      }

      // No leakage from other partitions
      const otherPartitionIds = partitions
        .filter((_, idx) => idx !== i)
        .map((p) => p.id);
      for (const dep of deps) {
        expect(otherPartitionIds).not.toContain(dep.partitionId);
      }
    }
  });

  it("debrief entries are scoped to correct partition", async () => {
    for (let i = 0; i < partitions.length; i++) {
      const res = await http(
        h.command.baseUrl,
        "GET",
        `/api/debrief?partitionId=${partitions[i].id}`,
      );
      const entries = res.body.entries as Array<Record<string, unknown>>;

      // All entries belong to this partition
      for (const entry of entries) {
        expect(entry.partitionId).toBe(partitions[i].id);
      }
    }
  });
});

// ===========================================================================
// 4. Debrief queries — time range, partition, decision type
// ===========================================================================

describe("Debrief queries", () => {
  it("queries debrief by decision type returns only matching entries", async () => {
    const res = await http(
      h.command.baseUrl,
      "GET",
      "/api/debrief?decisionType=pipeline-plan",
    );
    expect(res.status).toBe(200);
    const entries = res.body.entries as Array<Record<string, unknown>>;

    for (const entry of entries) {
      expect(entry.decisionType).toBe("pipeline-plan");
    }
  });

  it("queries debrief with limit returns at most N entries", async () => {
    const res = await http(h.command.baseUrl, "GET", "/api/debrief?limit=2");
    expect(res.status).toBe(200);
    const entries = res.body.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  it("queries debrief by partition + decision type narrows correctly", async () => {
    // First find a partition that has entries
    const allRes = await http(h.command.baseUrl, "GET", "/api/debrief?limit=1");
    const entries = allRes.body.entries as Array<Record<string, unknown>>;
    if (entries.length === 0) return; // nothing to test

    const partitionId = entries[0].partitionId as string;
    const res = await http(
      h.command.baseUrl,
      "GET",
      `/api/debrief?partitionId=${partitionId}&decisionType=pipeline-plan`,
    );

    const filtered = res.body.entries as Array<Record<string, unknown>>;
    for (const entry of filtered) {
      expect(entry.partitionId).toBe(partitionId);
      expect(entry.decisionType).toBe("pipeline-plan");
    }
  });
});

// ===========================================================================
// 5. Partition lifecycle — create, deploy, delete, verify cleanup
// ===========================================================================

describe("Partition lifecycle", () => {
  it("partition with deployments cannot be deleted (deletion guard)", async () => {
    const opId = await createOperation(h.command.baseUrl, "lifecycle-svc");
    const envId = await createEnvironment(h.command.baseUrl, "lifecycle-env");
    await linkEnvironment(h.command.baseUrl, opId, envId);
    const partId = await createPartition(h.command.baseUrl, "EphemeralCo");

    // Deploy
    const res = await deploy(h.command.baseUrl, {
      operationId: opId,
      partitionId: partId,
      environmentId: envId,
      version: "1.0.0",
    });
    expect(res.status).toBe(201);
    const depId = (res.body.deployment as Record<string, unknown>).id as string;

    // Attempt to delete partition — rejected because it has deployments
    const delRes = await http(h.command.baseUrl, "DELETE", `/api/partitions/${partId}`);
    expect(delRes.status).toBe(409);

    // Partition still exists
    const getRes = await http(h.command.baseUrl, "GET", `/api/partitions/${partId}`);
    expect(getRes.status).toBe(200);

    // Deployment still queryable
    const depRes = await http(h.command.baseUrl, "GET", `/api/deployments/${depId}`);
    expect(depRes.status).toBe(200);
  });

  it("partition without deployments can be deleted", async () => {
    const partId = await createPartition(h.command.baseUrl, "EmptyCo");

    const delRes = await http(h.command.baseUrl, "DELETE", `/api/partitions/${partId}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);

    // Partition should no longer appear in list
    const listRes = await http(h.command.baseUrl, "GET", "/api/partitions");
    const partitions = listRes.body.partitions as Array<Record<string, unknown>>;
    expect(partitions.find((p) => p.id === partId)).toBeUndefined();
  });
});

// ===========================================================================
// 6. Envoy deployment — direct dispatch and artifact verification
// ===========================================================================

describe("Envoy direct deployment", () => {
  it("dispatches deployment to Envoy and verifies workspace artifacts", async () => {
    const deploymentId = `scenario-${Date.now()}`;
    const res = await http(h.envoy.baseUrl, "POST", "/deploy", {
      deploymentId,
      partitionId: "part-1",
      environmentId: "env-1",
      operationId: "web-app",
      version: "2.0.0",
      variables: { APP_ENV: "production", DB_HOST: "db.internal" },
      environmentName: "production",
      partitionName: "Acme Corp",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deploymentId).toBe(deploymentId);
    expect(res.body.verificationPassed).toBe(true);
    expect((res.body.artifacts as string[]).length).toBeGreaterThan(0);

    // Verify workspace was created on disk
    const wsPath = res.body.workspacePath as string;
    const { default: fs } = await import("node:fs");
    expect(fs.existsSync(wsPath)).toBe(true);
  });

  it("Envoy health endpoint reflects deployment activity", async () => {
    const res = await http(h.envoy.baseUrl, "GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("healthy");
    expect(res.body.readiness).toBeDefined();
    expect((res.body.readiness as Record<string, unknown>).ready).toBe(true);
    expect(res.body.summary).toBeDefined();
    expect(
      (res.body.summary as Record<string, unknown>).totalDeployments,
    ).toBeGreaterThanOrEqual(1);
  });
});
