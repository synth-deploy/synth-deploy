import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief, PartitionStore, TelemetryStore } from "@synth-deploy/core";
import { InMemoryDeploymentStore } from "../src/agent/synth-agent.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";

function addMockAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    request.user = {
      id: "test-user-id" as any,
      email: "test@example.com",
      name: "Test User",
      permissions: [
        "partition.create", "partition.update", "partition.delete", "partition.view",
        "deployment.view",
      ],
    };
  });
}

describe("Partition deletion guard", () => {
  let app: FastifyInstance;
  let partitions: PartitionStore;
  let deployments: InMemoryDeploymentStore;
  let debrief: DecisionDebrief;
  let telemetry: TelemetryStore;

  beforeEach(async () => {
    app = Fastify();
    addMockAuth(app);
    partitions = new PartitionStore();
    deployments = new InMemoryDeploymentStore();
    debrief = new DecisionDebrief();
    telemetry = new TelemetryStore();
    registerPartitionRoutes(app, partitions, deployments, debrief, telemetry);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("deletes partition with no links", async () => {
    const partition = partitions.create("test", {});

    const res = await app.inject({
      method: "DELETE",
      url: `/api/partitions/${partition.id}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
  });

  it("blocks deletion when partition has deployments (409)", async () => {
    const partition = partitions.create("test", {});
    deployments.save({
      id: "dep-1",
      artifactId: "artifact-1",
      partitionId: partition.id,
      environmentId: "env-1",
      version: "1.0",
      status: "succeeded",
      variables: {},
      debriefEntryIds: [],
      createdAt: new Date(),
      completedAt: null,
      failureReason: null,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/partitions/${partition.id}`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().deployments).toBe(1);
    expect(res.json().hint).toContain("cascade");
  });

  it("allows cascade deletion with ?cascade=true", async () => {
    const partition = partitions.create("test", {});
    deployments.save({
      id: "dep-1",
      artifactId: "artifact-1",
      partitionId: partition.id,
      environmentId: "env-1",
      version: "1.0",
      status: "succeeded",
      variables: {},
      debriefEntryIds: [],
      createdAt: new Date(),
      completedAt: null,
      failureReason: null,
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/partitions/${partition.id}?cascade=true`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(res.json().cascade).toBe(true);
  });

  it("logs cascade deletion to Decision Diary", async () => {
    const partition = partitions.create("test-partition", {});
    deployments.save({
      id: "dep-1",
      artifactId: "artifact-1",
      partitionId: partition.id,
      environmentId: "env-1",
      version: "1.0",
      status: "succeeded",
      variables: {},
      debriefEntryIds: [],
      createdAt: new Date(),
      completedAt: null,
      failureReason: null,
    });

    await app.inject({
      method: "DELETE",
      url: `/api/partitions/${partition.id}?cascade=true`,
    });

    const entries = debrief.getRecent(1);
    expect(entries.length).toBe(1);
    expect(entries[0].decision).toContain("Cascade-deleted");
    expect(entries[0].decision).toContain("test-partition");
  });

  it("returns 404 for non-existent partition", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/partitions/nonexistent",
    });

    expect(res.statusCode).toBe(404);
  });
});
