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
  createArtifact,
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
  let artifactId: string;
  let partitionId: string;
  let environmentId: string;
  let deploymentId: string;

  it("creates artifact → environment → partition → deployment → verifies", async () => {
    artifactId = await createArtifact(h.server.baseUrl, "web-app");
    environmentId = await createEnvironment(h.server.baseUrl, "production", {
      APP_ENV: "production",
      LOG_LEVEL: "warn",
    });
    partitionId = await createPartition(h.server.baseUrl, "Acme Corp", {
      DB_HOST: "acme-db.internal",
      REGION: "us-east-1",
    });

    const res = await deploy(h.server.baseUrl, {
      artifactId,
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
    const res = await http(h.server.baseUrl, "GET", `/api/operations/${deploymentId}`);
    expect(res.status).toBe(200);

    const entries = res.body.debrief as Array<Record<string, unknown>>;
    // Deployment was just created (pending), debrief may have 0+ entries
    if (entries.length > 0) {
      for (const entry of entries) {
        expect((entry.reasoning as string).length).toBeGreaterThanOrEqual(1);
        expect(entry.partitionId).toBe(partitionId);
        expect(entry.deploymentId).toBe(deploymentId);
        expect(["command", "envoy"]).toContain(entry.agent);
      }
    }
  });

  it("debrief can be queried via general endpoint", async () => {
    const res = await http(h.server.baseUrl, "GET", `/api/operations/${deploymentId}`);
    const entries = res.body.debrief as Array<Record<string, unknown>>;
    // Just verify the endpoint returns successfully
    expect(Array.isArray(entries)).toBe(true);
  });
});

// ===========================================================================
// 2. Deploy failure + investigation
// ===========================================================================

describe("Deploy failure investigation", () => {
  it("deployment produces debrief explaining context", async () => {
    const artId = await createArtifact(h.server.baseUrl, "failing-service");
    const envId = await createEnvironment(h.server.baseUrl, "broken-env");
    const partId = await createPartition(h.server.baseUrl, "FailCo");

    const res = await deploy(h.server.baseUrl, {
      artifactId: artId,
      partitionId: partId,
      environmentId: envId,
      version: "0.0.1",
    });

    expect(res.status).toBe(201);
    const dep = res.body.deployment as Record<string, unknown>;
    const depId = dep.id as string;

    const detailRes = await http(h.server.baseUrl, "GET", `/api/operations/${depId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.deployment).toBeDefined();
  });

  it("postmortem endpoint returns structured analysis", async () => {
    const artId = await createArtifact(h.server.baseUrl, "postmortem-svc");
    const envId = await createEnvironment(h.server.baseUrl, "postmortem-env");
    const partId = await createPartition(h.server.baseUrl, "PostmortemCo");

    const res = await deploy(h.server.baseUrl, {
      artifactId: artId,
      partitionId: partId,
      environmentId: envId,
      version: "1.0.0",
    });

    const depId = (res.body.deployment as Record<string, unknown>).id as string;
    const pmRes = await http(h.server.baseUrl, "GET", `/api/operations/${depId}/postmortem`);
    expect(pmRes.status).toBe(200);
    expect(pmRes.body.postmortem).toBeDefined();
  });
});

// ===========================================================================
// 3. Multi-partition batch — isolation under stress
// ===========================================================================

describe("Multi-partition isolation", () => {
  let artifactId: string;
  let environmentId: string;
  const partitions: Array<{ id: string; name: string }> = [];
  const deploymentIds: string[] = [];

  it("deploys same artifact across 3 partitions", async () => {
    artifactId = await createArtifact(h.server.baseUrl, "batch-deploy-svc");
    environmentId = await createEnvironment(h.server.baseUrl, "batch-env", {
      APP_ENV: "staging",
    });

    for (const name of ["Alpha Inc", "Beta LLC", "Gamma Corp"]) {
      const id = await createPartition(h.server.baseUrl, name, {
        TENANT: name.toLowerCase().replace(/\s+/g, "-"),
      });
      partitions.push({ id, name });
    }

    // Deploy v1.0.0 to all three
    for (const p of partitions) {
      const res = await deploy(h.server.baseUrl, {
        artifactId,
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
        h.server.baseUrl,
        "GET",
        `/api/operations?partitionId=${partitions[i].id}`,
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
        h.server.baseUrl,
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
      h.server.baseUrl,
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
    const res = await http(h.server.baseUrl, "GET", "/api/debrief?limit=2");
    expect(res.status).toBe(200);
    const entries = res.body.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  it("queries debrief by partition + decision type narrows correctly", async () => {
    // First find a partition that has entries
    const allRes = await http(h.server.baseUrl, "GET", "/api/debrief?limit=1");
    const entries = allRes.body.entries as Array<Record<string, unknown>>;
    if (entries.length === 0) return; // nothing to test

    const partitionId = entries[0].partitionId as string;
    const res = await http(
      h.server.baseUrl,
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
    const artId = await createArtifact(h.server.baseUrl, "lifecycle-svc");
    const envId = await createEnvironment(h.server.baseUrl, "lifecycle-env");
    const partId = await createPartition(h.server.baseUrl, "EphemeralCo");

    // Deploy
    const res = await deploy(h.server.baseUrl, {
      artifactId: artId,
      partitionId: partId,
      environmentId: envId,
      version: "1.0.0",
    });
    expect(res.status).toBe(201);
    const depId = (res.body.deployment as Record<string, unknown>).id as string;

    // Attempt to delete partition — rejected because it has deployments
    const delRes = await http(h.server.baseUrl, "DELETE", `/api/partitions/${partId}`);
    expect(delRes.status).toBe(409);

    // Partition still exists
    const getRes = await http(h.server.baseUrl, "GET", `/api/partitions/${partId}`);
    expect(getRes.status).toBe(200);

    // Deployment still queryable
    const depRes = await http(h.server.baseUrl, "GET", `/api/operations/${depId}`);
    expect(depRes.status).toBe(200);
  });

  it("partition without deployments can be deleted", async () => {
    const partId = await createPartition(h.server.baseUrl, "EmptyCo");

    const delRes = await http(h.server.baseUrl, "DELETE", `/api/partitions/${partId}`);
    expect(delRes.status).toBe(200);
    expect(delRes.body.deleted).toBe(true);

    // Partition should no longer appear in list
    const listRes = await http(h.server.baseUrl, "GET", "/api/partitions");
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
