import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief, PartitionStore, OrderStore, DEFAULT_DEPLOY_CONFIG } from "@deploystack/core";
import { InMemoryDeploymentStore } from "../src/agent/command-agent.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";

describe("Partition deletion guard", () => {
  let app: FastifyInstance;
  let partitions: PartitionStore;
  let deployments: InMemoryDeploymentStore;
  let debrief: DecisionDebrief;
  let orders: OrderStore;

  beforeEach(async () => {
    app = Fastify();
    partitions = new PartitionStore();
    deployments = new InMemoryDeploymentStore();
    debrief = new DecisionDebrief();
    orders = new OrderStore();
    registerPartitionRoutes(app, partitions, deployments, debrief, orders);
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
      operationId: "op-1",
      partitionId: partition.id,
      environmentId: "env-1",
      version: "1.0",
      status: "succeeded",
      variables: {},
      debriefEntryIds: [],
      orderId: null,
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

  it("blocks deletion when partition has orders (409)", async () => {
    const partition = partitions.create("test", {});
    orders.create({
      operationId: "op-1",
      operationName: "web-app",
      partitionId: partition.id,
      environmentId: "env-1",
      environmentName: "production",
      version: "1.0",
      steps: [],
      deployConfig: DEFAULT_DEPLOY_CONFIG,
      variables: {},
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/api/partitions/${partition.id}`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().orders).toBe(1);
    expect(res.json().hint).toContain("cascade");
  });

  it("allows cascade deletion with ?cascade=true", async () => {
    const partition = partitions.create("test", {});
    deployments.save({
      id: "dep-1",
      operationId: "op-1",
      partitionId: partition.id,
      environmentId: "env-1",
      version: "1.0",
      status: "succeeded",
      variables: {},
      debriefEntryIds: [],
      orderId: null,
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
      operationId: "op-1",
      partitionId: partition.id,
      environmentId: "env-1",
      version: "1.0",
      status: "succeeded",
      variables: {},
      debriefEntryIds: [],
      orderId: null,
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
