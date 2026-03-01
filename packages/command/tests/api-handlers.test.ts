import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  DecisionDebrief,
  PartitionStore,
  OperationStore,
  EnvironmentStore,
  OrderStore,
  SettingsStore,
} from "@deploystack/core";
import { CommandAgent, InMemoryDeploymentStore } from "../src/agent/command-agent.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";
import { registerOperationRoutes } from "../src/api/operations.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";
import { registerSettingsRoutes } from "../src/api/settings.js";
import { registerOrderRoutes } from "../src/api/orders.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerHealthRoutes } from "../src/api/health.js";

// ---------------------------------------------------------------------------
// Shared test server factory
// ---------------------------------------------------------------------------

interface TestContext {
  app: FastifyInstance;
  diary: DecisionDebrief;
  partitions: PartitionStore;
  operations: OperationStore;
  environments: EnvironmentStore;
  deployments: InMemoryDeploymentStore;
  orders: OrderStore;
  settings: SettingsStore;
  agent: CommandAgent;
}

async function createTestServer(): Promise<TestContext> {
  const diary = new DecisionDebrief();
  const partitions = new PartitionStore();
  const operations = new OperationStore();
  const environments = new EnvironmentStore();
  const deployments = new InMemoryDeploymentStore();
  const orders = new OrderStore();
  const settings = new SettingsStore();
  const agent = new CommandAgent(diary, deployments, orders, undefined, {
    healthCheckBackoffMs: 1,
    executionDelayMs: 1,
  }, settings);

  const app = Fastify();
  registerPartitionRoutes(app, partitions, deployments, diary);
  registerOperationRoutes(app, operations, environments);
  registerEnvironmentRoutes(app, environments, operations);
  registerSettingsRoutes(app, settings);
  registerOrderRoutes(app, orders, agent, partitions, environments, operations, deployments, diary, settings);
  registerDeploymentRoutes(app, agent, partitions, environments, deployments, diary, operations, orders, settings);
  registerHealthRoutes(app);

  await app.ready();
  return { app, diary, partitions, operations, environments, deployments, orders, settings, agent };
}

/**
 * Helper: creates an Order via HTTP, then triggers deployment.
 * Replaces the old pattern of posting directly to /api/deployments with operationId/version.
 */
async function deployViaHttp(
  server: FastifyInstance,
  params: { operationId: string; partitionId: string; environmentId: string; version: string; variables?: Record<string, string> },
) {
  const orderRes = await server.inject({
    method: "POST",
    url: "/api/orders",
    payload: {
      operationId: params.operationId,
      partitionId: params.partitionId,
      environmentId: params.environmentId,
      version: params.version,
    },
  });
  if (orderRes.statusCode !== 201) {
    throw new Error(`Failed to create order: ${orderRes.payload}`);
  }
  const orderId = JSON.parse(orderRes.payload).order.id;

  return server.inject({
    method: "POST",
    url: "/api/deployments",
    payload: {
      orderId,
      partitionId: params.partitionId,
      environmentId: params.environmentId,
      triggeredBy: "user",
      ...(params.variables ? { variables: params.variables } : {}),
    },
  });
}

// ===========================================================================
// Partition Routes
// ===========================================================================

describe("Partition Routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  afterAll(async () => {
    // Fastify instances are cleaned up per-test via beforeEach
  });

  // --- POST /api/partitions ---

  describe("POST /api/partitions", () => {
    it("creates a partition and returns 201", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/partitions",
        payload: { name: "Acme Corp", variables: { DB_HOST: "acme-db" } },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.partition).toBeDefined();
      expect(body.partition.name).toBe("Acme Corp");
      expect(body.partition.variables.DB_HOST).toBe("acme-db");
      expect(body.partition.id).toBeDefined();
    });

    it("creates a partition without variables", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/partitions",
        payload: { name: "Bare Partition" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.partition.name).toBe("Bare Partition");
      expect(body.partition.variables).toEqual({});
    });

    it("returns 400 for missing name", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/partitions",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe("Invalid input");
    });

    it("returns 400 for empty name", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/partitions",
        payload: { name: "" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("trims whitespace from name", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/partitions",
        payload: { name: "  Padded Name  " },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.partition.name).toBe("Padded Name");
    });
  });

  // --- GET /api/partitions ---

  describe("GET /api/partitions", () => {
    it("returns empty list when no partitions exist", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/partitions",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.partitions).toEqual([]);
    });

    it("returns all partitions", async () => {
      ctx.partitions.create("Alpha");
      ctx.partitions.create("Beta");

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/partitions",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.partitions).toHaveLength(2);
    });
  });

  // --- GET /api/partitions/:id ---

  describe("GET /api/partitions/:id", () => {
    it("returns a specific partition by ID", async () => {
      const partition = ctx.partitions.create("Acme Corp", { KEY: "val" });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/partitions/${partition.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.partition.id).toBe(partition.id);
      expect(body.partition.name).toBe("Acme Corp");
      expect(body.partition.variables.KEY).toBe("val");
    });

    it("returns 404 for non-existent partition", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/partitions/does-not-exist",
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe("Partition not found");
    });
  });

  // --- PUT /api/partitions/:id ---

  describe("PUT /api/partitions/:id", () => {
    it("updates partition name", async () => {
      const partition = ctx.partitions.create("Old Name");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/partitions/${partition.id}`,
        payload: { name: "New Name" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.partition.name).toBe("New Name");
    });

    it("returns 404 for non-existent partition", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/partitions/does-not-exist",
        payload: { name: "Irrelevant" },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for invalid input (empty name)", async () => {
      const partition = ctx.partitions.create("Valid");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/partitions/${partition.id}`,
        payload: { name: "" },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // --- DELETE /api/partitions/:id ---

  describe("DELETE /api/partitions/:id", () => {
    it("deletes an existing partition", async () => {
      const partition = ctx.partitions.create("To Delete");

      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/partitions/${partition.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deleted).toBe(true);

      // Verify it's gone
      expect(ctx.partitions.get(partition.id)).toBeUndefined();
    });

    it("returns 404 for non-existent partition", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/partitions/does-not-exist",
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // --- PUT /api/partitions/:id/variables ---

  describe("PUT /api/partitions/:id/variables", () => {
    it("sets variables on a partition", async () => {
      const partition = ctx.partitions.create("Acme");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/partitions/${partition.id}/variables`,
        payload: { variables: { DB_HOST: "new-db", LOG_LEVEL: "debug" } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.partition.variables.DB_HOST).toBe("new-db");
      expect(body.partition.variables.LOG_LEVEL).toBe("debug");
    });

    it("returns 404 for non-existent partition", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/partitions/does-not-exist/variables",
        payload: { variables: { KEY: "val" } },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for invalid input", async () => {
      const partition = ctx.partitions.create("Acme");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/partitions/${partition.id}/variables`,
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // --- GET /api/partitions/:id/history ---

  describe("GET /api/partitions/:id/history", () => {
    it("returns history for a partition", async () => {
      const partition = ctx.partitions.create("Acme");

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/partitions/${partition.id}/history`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.history).toBeDefined();
    });

    it("returns 404 for non-existent partition", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/partitions/does-not-exist/history",
      });

      expect(res.statusCode).toBe(404);
    });
  });
});

// ===========================================================================
// Operation Routes
// ===========================================================================

describe("Operation Routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  // --- POST /api/operations ---

  describe("POST /api/operations", () => {
    it("creates an operation and returns 201", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/operations",
        payload: { name: "web-app" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.operation).toBeDefined();
      expect(body.operation.name).toBe("web-app");
      expect(body.operation.environmentIds).toEqual([]);
      expect(body.operation.steps).toEqual([]);
      expect(body.operation.deployConfig).toBeDefined();
    });

    it("creates an operation with environment IDs", async () => {
      const env = ctx.environments.create("production");

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/operations",
        payload: { name: "web-app", environmentIds: [env.id] },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.operation.environmentIds).toEqual([env.id]);
    });

    it("returns 404 when environment ID does not exist", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/operations",
        payload: { name: "web-app", environmentIds: ["nonexistent"] },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("Environment not found");
    });

    it("returns 400 for missing name", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/operations",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty name", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/operations",
        payload: { name: "" },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // --- GET /api/operations ---

  describe("GET /api/operations", () => {
    it("returns empty list when no operations exist", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/operations",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.operations).toEqual([]);
    });

    it("returns all operations", async () => {
      ctx.operations.create("op-1");
      ctx.operations.create("op-2");

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/operations",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.operations).toHaveLength(2);
    });
  });

  // --- GET /api/operations/:id ---

  describe("GET /api/operations/:id", () => {
    it("returns an operation with environment details", async () => {
      const env = ctx.environments.create("production");
      const op = ctx.operations.create("web-app", [env.id]);

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/operations/${op.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.operation.id).toBe(op.id);
      expect(body.operation.name).toBe("web-app");
      expect(body.environments).toHaveLength(1);
      expect(body.environments[0].id).toBe(env.id);
    });

    it("returns 404 for non-existent operation", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/operations/does-not-exist",
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe("Operation not found");
    });
  });

  // --- PUT /api/operations/:id ---

  describe("PUT /api/operations/:id", () => {
    it("updates operation name", async () => {
      const op = ctx.operations.create("old-name");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/operations/${op.id}`,
        payload: { name: "new-name" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.operation.name).toBe("new-name");
    });

    it("returns 404 for non-existent operation", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/operations/does-not-exist",
        payload: { name: "irrelevant" },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for invalid input", async () => {
      const op = ctx.operations.create("valid");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/operations/${op.id}`,
        payload: { name: "" },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // --- DELETE /api/operations/:id ---

  describe("DELETE /api/operations/:id", () => {
    it("deletes an existing operation", async () => {
      const op = ctx.operations.create("to-delete");

      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/operations/${op.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deleted).toBe(true);
      expect(ctx.operations.get(op.id)).toBeUndefined();
    });

    it("returns 404 for non-existent operation", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/operations/does-not-exist",
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // --- POST /api/operations/:id/environments ---

  describe("POST /api/operations/:id/environments", () => {
    it("adds an environment to an operation", async () => {
      const env = ctx.environments.create("staging");
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/operations/${op.id}/environments`,
        payload: { environmentId: env.id },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.operation.environmentIds).toContain(env.id);
    });

    it("returns 404 when environment does not exist", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/operations/${op.id}/environments`,
        payload: { environmentId: "nonexistent" },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("Environment not found");
    });

    it("returns 404 when operation does not exist", async () => {
      const env = ctx.environments.create("staging");

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/operations/nonexistent/environments",
        payload: { environmentId: env.id },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for invalid input", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/operations/${op.id}/environments`,
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // --- DELETE /api/operations/:id/environments/:envId ---

  describe("DELETE /api/operations/:id/environments/:envId", () => {
    it("removes an environment from an operation", async () => {
      const env = ctx.environments.create("staging");
      const op = ctx.operations.create("web-app", [env.id]);

      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/operations/${op.id}/environments/${env.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.operation.environmentIds).not.toContain(env.id);
    });

    it("returns 404 when operation does not exist", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/operations/nonexistent/environments/some-env",
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // --- Steps CRUD ---

  describe("Steps CRUD", () => {
    it("GET /api/operations/:id/steps returns steps for an operation", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/operations/${op.id}/steps`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.steps).toEqual([]);
    });

    it("GET /api/operations/:id/steps returns 404 for non-existent operation", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/operations/nonexistent/steps",
      });

      expect(res.statusCode).toBe(404);
    });

    it("POST /api/operations/:id/steps creates a step and returns 201", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/operations/${op.id}/steps`,
        payload: {
          name: "Install deps",
          type: "pre-deploy",
          command: "npm ci",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.step.name).toBe("Install deps");
      expect(body.step.type).toBe("pre-deploy");
      expect(body.step.command).toBe("npm ci");
      expect(body.step.id).toBeDefined();
      expect(body.step.order).toBeDefined();
    });

    it("POST /api/operations/:id/steps returns 404 for non-existent operation", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/operations/nonexistent/steps",
        payload: {
          name: "Install",
          type: "pre-deploy",
          command: "npm ci",
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it("POST /api/operations/:id/steps returns 400 for invalid step type", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/operations/${op.id}/steps`,
        payload: {
          name: "Bad Step",
          type: "invalid-type",
          command: "echo hi",
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("POST /api/operations/:id/steps returns 400 for missing required fields", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/operations/${op.id}/steps`,
        payload: { name: "Missing fields" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("PUT /api/operations/:id/steps/:stepId updates a step", async () => {
      const op = ctx.operations.create("web-app");
      ctx.operations.addStep(op.id, {
        id: "step-1",
        name: "Old Name",
        type: "pre-deploy",
        command: "old-cmd",
        order: 0,
      });

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/operations/${op.id}/steps/step-1`,
        payload: { name: "New Name", command: "new-cmd" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.step.name).toBe("New Name");
      expect(body.step.command).toBe("new-cmd");
    });

    it("PUT /api/operations/:id/steps/:stepId returns 404 for non-existent operation", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/operations/nonexistent/steps/step-1",
        payload: { name: "Irrelevant" },
      });

      expect(res.statusCode).toBe(404);
    });

    it("PUT /api/operations/:id/steps/:stepId returns 404 for non-existent step", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/operations/${op.id}/steps/nonexistent`,
        payload: { name: "Irrelevant" },
      });

      expect(res.statusCode).toBe(404);
    });

    it("DELETE /api/operations/:id/steps/:stepId deletes a step", async () => {
      const op = ctx.operations.create("web-app");
      ctx.operations.addStep(op.id, {
        id: "step-to-delete",
        name: "Step",
        type: "pre-deploy",
        command: "echo",
        order: 0,
      });

      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/operations/${op.id}/steps/step-to-delete`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deleted).toBe(true);
    });

    it("DELETE /api/operations/:id/steps/:stepId returns 404 for non-existent", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/operations/nonexistent/steps/nonexistent",
      });

      expect(res.statusCode).toBe(404);
    });

    it("POST /api/operations/:id/steps/reorder reorders steps", async () => {
      const op = ctx.operations.create("web-app");
      ctx.operations.addStep(op.id, {
        id: "step-a",
        name: "A",
        type: "pre-deploy",
        command: "a",
        order: 0,
      });
      ctx.operations.addStep(op.id, {
        id: "step-b",
        name: "B",
        type: "post-deploy",
        command: "b",
        order: 1,
      });

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/operations/${op.id}/steps/reorder`,
        payload: { stepIds: ["step-b", "step-a"] },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.steps[0].id).toBe("step-b");
      expect(body.steps[1].id).toBe("step-a");
    });

    it("POST /api/operations/:id/steps/reorder returns 404 for non-existent operation", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/operations/nonexistent/steps/reorder",
        payload: { stepIds: ["step-a"] },
      });

      expect(res.statusCode).toBe(404);
    });

    it("POST /api/operations/:id/steps/reorder returns 400 for invalid step IDs", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/operations/${op.id}/steps/reorder`,
        payload: { stepIds: ["nonexistent"] },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("Step not found");
    });

    it("POST /api/operations/:id/steps/reorder returns 400 for invalid input", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: `/api/operations/${op.id}/steps/reorder`,
        payload: { stepIds: [] },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // --- Deploy Config ---

  describe("Deploy Config", () => {
    it("GET /api/operations/:id/deploy-config returns deploy config", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/operations/${op.id}/deploy-config`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deployConfig).toBeDefined();
      expect(body.deployConfig.healthCheckEnabled).toBe(true);
      expect(body.deployConfig.verificationStrategy).toBe("basic");
    });

    it("GET /api/operations/:id/deploy-config returns 404 for non-existent operation", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/operations/nonexistent/deploy-config",
      });

      expect(res.statusCode).toBe(404);
    });

    it("PUT /api/operations/:id/deploy-config updates deploy config", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/operations/${op.id}/deploy-config`,
        payload: {
          healthCheckEnabled: false,
          timeoutMs: 60000,
          verificationStrategy: "full",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deployConfig.healthCheckEnabled).toBe(false);
      expect(body.deployConfig.timeoutMs).toBe(60000);
      expect(body.deployConfig.verificationStrategy).toBe("full");
    });

    it("PUT /api/operations/:id/deploy-config returns 404 for non-existent operation", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/operations/nonexistent/deploy-config",
        payload: { healthCheckEnabled: false },
      });

      expect(res.statusCode).toBe(404);
    });

    it("PUT /api/operations/:id/deploy-config returns 400 for invalid config", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/operations/${op.id}/deploy-config`,
        payload: { verificationStrategy: "invalid-strategy" },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});

// ===========================================================================
// Environment Routes
// ===========================================================================

describe("Environment Routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  // --- POST /api/environments ---

  describe("POST /api/environments", () => {
    it("creates an environment and returns 201", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/environments",
        payload: { name: "production", variables: { APP_ENV: "production" } },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.environment).toBeDefined();
      expect(body.environment.name).toBe("production");
      expect(body.environment.variables.APP_ENV).toBe("production");
      expect(body.environment.id).toBeDefined();
    });

    it("creates an environment without variables", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/environments",
        payload: { name: "bare-env" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.environment.variables).toEqual({});
    });

    it("returns 400 for missing name", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/environments",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for empty name", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/environments",
        payload: { name: "" },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // --- GET /api/environments ---

  describe("GET /api/environments", () => {
    it("returns empty list when no environments exist", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/environments",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.environments).toEqual([]);
    });

    it("returns all environments", async () => {
      ctx.environments.create("production");
      ctx.environments.create("staging");

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/environments",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.environments).toHaveLength(2);
    });
  });

  // --- GET /api/environments/:id ---

  describe("GET /api/environments/:id", () => {
    it("returns a specific environment", async () => {
      const env = ctx.environments.create("production", { KEY: "val" });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/environments/${env.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.environment.id).toBe(env.id);
      expect(body.environment.name).toBe("production");
    });

    it("returns 404 for non-existent environment", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/environments/does-not-exist",
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe("Environment not found");
    });
  });

  // --- PUT /api/environments/:id ---

  describe("PUT /api/environments/:id", () => {
    it("updates environment name", async () => {
      const env = ctx.environments.create("old-name");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/environments/${env.id}`,
        payload: { name: "new-name" },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.environment.name).toBe("new-name");
    });

    it("updates environment variables", async () => {
      const env = ctx.environments.create("production", { OLD_KEY: "old" });

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/environments/${env.id}`,
        payload: { variables: { NEW_KEY: "new" } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.environment.variables.NEW_KEY).toBe("new");
      // Existing variables are merged
      expect(body.environment.variables.OLD_KEY).toBe("old");
    });

    it("returns 404 for non-existent environment", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/environments/does-not-exist",
        payload: { name: "irrelevant" },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for invalid input (empty name)", async () => {
      const env = ctx.environments.create("valid");

      const res = await ctx.app.inject({
        method: "PUT",
        url: `/api/environments/${env.id}`,
        payload: { name: "" },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // --- DELETE /api/environments/:id ---

  describe("DELETE /api/environments/:id", () => {
    it("deletes an environment not linked to any operations", async () => {
      const env = ctx.environments.create("to-delete");

      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/environments/${env.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deleted).toBe(true);
      expect(ctx.environments.get(env.id)).toBeUndefined();
    });

    it("returns 404 for non-existent environment", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/environments/does-not-exist",
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 409 when environment is linked to operations", async () => {
      const env = ctx.environments.create("production");
      ctx.operations.create("web-app", [env.id]);

      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/environments/${env.id}`,
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("linked to");
      expect(body.linkedOperations).toHaveLength(1);
    });
  });
});

// ===========================================================================
// Settings Routes
// ===========================================================================

describe("Settings Routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  // --- GET /api/settings ---

  describe("GET /api/settings", () => {
    it("returns default settings", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/settings",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.settings).toBeDefined();
      expect(body.settings.environmentsEnabled).toBe(true);
      expect(body.settings.agent).toBeDefined();
      expect(body.settings.agent.conflictPolicy).toBe("permissive");
      expect(body.settings.deploymentDefaults).toBeDefined();
      expect(body.settings.envoy).toBeDefined();
    });
  });

  // --- PUT /api/settings ---

  describe("PUT /api/settings", () => {
    it("updates environmentsEnabled", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { environmentsEnabled: false },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.settings.environmentsEnabled).toBe(false);
    });

    it("updates agent settings", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: {
          agent: {
            conflictPolicy: "strict",
            defaultTimeoutMs: 60000,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.settings.agent.conflictPolicy).toBe("strict");
      expect(body.settings.agent.defaultTimeoutMs).toBe(60000);
    });

    it("updates envoy settings", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: {
          envoy: {
            url: "http://envoy:3001",
            timeoutMs: 5000,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.settings.envoy.url).toBe("http://envoy:3001");
      expect(body.settings.envoy.timeoutMs).toBe(5000);
    });

    it("returns 400 for invalid settings", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: {
          agent: {
            conflictPolicy: "invalid-policy",
          },
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for invalid envoy URL", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: {
          envoy: {
            url: "not-a-url",
          },
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // --- GET /api/settings/command-info ---

  describe("GET /api/settings/command-info", () => {
    it("returns command info with version and timing", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/settings/command-info",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.info).toBeDefined();
      expect(body.info.version).toBe("0.1.0");
      expect(body.info.startedAt).toBeDefined();
    });
  });
});

// ===========================================================================
// Order Routes
// ===========================================================================

describe("Order Routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  // --- POST /api/orders ---

  describe("POST /api/orders", () => {
    it("creates an order and returns 201", async () => {
      const env = ctx.environments.create("production", { APP_ENV: "production" });
      const partition = ctx.partitions.create("Acme", { DB_HOST: "acme-db" });
      const op = ctx.operations.create("web-app", [env.id]);

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: {
          operationId: op.id,
          partitionId: partition.id,
          environmentId: env.id,
          version: "1.0.0",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.order).toBeDefined();
      expect(body.order.operationId).toBe(op.id);
      expect(body.order.partitionId).toBe(partition.id);
      expect(body.order.version).toBe("1.0.0");
      // Variables should be resolved (env + partition)
      expect(body.order.variables.APP_ENV).toBe("production");
      expect(body.order.variables.DB_HOST).toBe("acme-db");
    });

    it("returns 400 for missing required fields", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 404 when operation does not exist", async () => {
      const partition = ctx.partitions.create("Acme");

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: {
          operationId: "nonexistent",
          partitionId: partition.id,
          environmentId: "env-id",
          version: "1.0.0",
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("Operation not found");
    });

    it("returns 404 when partition does not exist", async () => {
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: {
          operationId: op.id,
          partitionId: "nonexistent",
          environmentId: "env-id",
          version: "1.0.0",
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("Partition not found");
    });

    it("returns 404 when environment does not exist (environments enabled)", async () => {
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: {
          operationId: op.id,
          partitionId: partition.id,
          environmentId: "nonexistent",
          version: "1.0.0",
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("Environment not found");
    });

    it("returns 400 when environments are enabled but environmentId is missing", async () => {
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: {
          operationId: op.id,
          partitionId: partition.id,
          version: "1.0.0",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("environmentId");
    });

    it("creates an order without environment when environments are disabled", async () => {
      // Disable environments
      ctx.settings.update({ environmentsEnabled: false });

      const partition = ctx.partitions.create("Acme", { DB_HOST: "acme-db" });
      const op = ctx.operations.create("web-app");

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: {
          operationId: op.id,
          partitionId: partition.id,
          version: "1.0.0",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.order.variables.DB_HOST).toBe("acme-db");
    });
  });

  // --- GET /api/orders ---

  describe("GET /api/orders", () => {
    it("returns empty list when no orders exist", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/orders",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.orders).toEqual([]);
    });

    it("returns all orders", async () => {
      // Create prerequisite data and an order
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app", [env.id]);

      ctx.orders.create({
        operationId: op.id,
        operationName: op.name,
        partitionId: partition.id,
        environmentId: env.id,
        environmentName: env.name,
        version: "1.0.0",
        steps: [],
        deployConfig: op.deployConfig,
        variables: {},
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/orders",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.orders).toHaveLength(1);
    });

    it("filters orders by operationId", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op1 = ctx.operations.create("web-app");
      const op2 = ctx.operations.create("api-service");

      ctx.orders.create({
        operationId: op1.id,
        operationName: op1.name,
        partitionId: partition.id,
        environmentId: env.id,
        environmentName: env.name,
        version: "1.0.0",
        steps: [],
        deployConfig: op1.deployConfig,
        variables: {},
      });
      ctx.orders.create({
        operationId: op2.id,
        operationName: op2.name,
        partitionId: partition.id,
        environmentId: env.id,
        environmentName: env.name,
        version: "1.0.0",
        steps: [],
        deployConfig: op2.deployConfig,
        variables: {},
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/orders?operationId=${op1.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.orders).toHaveLength(1);
      expect(body.orders[0].operationId).toBe(op1.id);
    });

    it("filters orders by partitionId", async () => {
      const env = ctx.environments.create("production");
      const p1 = ctx.partitions.create("Acme");
      const p2 = ctx.partitions.create("Beta");
      const op = ctx.operations.create("web-app");

      ctx.orders.create({
        operationId: op.id,
        operationName: op.name,
        partitionId: p1.id,
        environmentId: env.id,
        environmentName: env.name,
        version: "1.0.0",
        steps: [],
        deployConfig: op.deployConfig,
        variables: {},
      });
      ctx.orders.create({
        operationId: op.id,
        operationName: op.name,
        partitionId: p2.id,
        environmentId: env.id,
        environmentName: env.name,
        version: "1.0.0",
        steps: [],
        deployConfig: op.deployConfig,
        variables: {},
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/orders?partitionId=${p1.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.orders).toHaveLength(1);
      expect(body.orders[0].partitionId).toBe(p1.id);
    });
  });

  // --- GET /api/orders/:id ---

  describe("GET /api/orders/:id", () => {
    it("returns an order by ID with related deployments", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app");

      const order = ctx.orders.create({
        operationId: op.id,
        operationName: op.name,
        partitionId: partition.id,
        environmentId: env.id,
        environmentName: env.name,
        version: "1.0.0",
        steps: [],
        deployConfig: op.deployConfig,
        variables: {},
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/orders/${order.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.order).toBeDefined();
      expect(body.order.id).toBe(order.id);
      expect(body.deployments).toBeDefined();
      expect(Array.isArray(body.deployments)).toBe(true);
    });

    it("returns 404 for non-existent order", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/orders/does-not-exist",
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe("Order not found");
    });
  });
});

// ===========================================================================
// Deployment Routes
// ===========================================================================

describe("Deployment Routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  // --- POST /api/deployments ---

  describe("POST /api/deployments", () => {
    it("triggers a deployment and returns 201", async () => {
      const env = ctx.environments.create("production", { APP_ENV: "production" });
      const partition = ctx.partitions.create("Acme", { DB_HOST: "acme-db" });
      const op = ctx.operations.create("web-app", [env.id]);

      const res = await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.deployment).toBeDefined();
      expect(body.deployment.operationId).toBe(op.id);
      expect(body.deployment.partitionId).toBe(partition.id);
      expect(body.deployment.version).toBe("1.0.0");
      expect(body.debrief).toBeDefined();
      expect(Array.isArray(body.debrief)).toBe(true);
    });

    it("returns 400 for invalid trigger", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/deployments",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("Invalid");
    });

    it("returns 404 when order does not exist", async () => {
      const partition = ctx.partitions.create("Acme");

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/deployments",
        payload: {
          orderId: "nonexistent-order",
          partitionId: partition.id,
          environmentId: "env-id",
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 404 when partition does not exist", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app", [env.id]);

      // Create a valid order, but reference a non-existent partition in the trigger
      const orderRes = await ctx.app.inject({
        method: "POST",
        url: "/api/orders",
        payload: { operationId: op.id, partitionId: partition.id, environmentId: env.id, version: "1.0.0" },
      });
      const orderId = JSON.parse(orderRes.payload).order.id;

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/deployments",
        payload: {
          orderId,
          partitionId: "nonexistent",
          environmentId: env.id,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it("succeeds when environments are disabled", async () => {
      ctx.settings.update({ environmentsEnabled: false });
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app");

      const res = await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: partition.id,
        environmentId: "",
        version: "1.0.0",
      });

      expect(res.statusCode).toBe(201);
    });
  });

  // --- GET /api/deployments ---

  describe("GET /api/deployments", () => {
    it("returns empty list when no deployments exist", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/deployments",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deployments).toEqual([]);
    });

    it("returns deployments after triggering one", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app", [env.id]);

      await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/deployments",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deployments.length).toBeGreaterThanOrEqual(1);
    });

    it("filters deployments by partitionId", async () => {
      const env = ctx.environments.create("production");
      const p1 = ctx.partitions.create("Acme");
      const p2 = ctx.partitions.create("Beta");
      const op = ctx.operations.create("web-app", [env.id]);

      await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: p1.id,
        environmentId: env.id,
        version: "1.0.0",
      });
      await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: p2.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/deployments?partitionId=${p1.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deployments).toHaveLength(1);
      expect(body.deployments[0].partitionId).toBe(p1.id);
    });
  });

  // --- GET /api/deployments/:id ---

  describe("GET /api/deployments/:id", () => {
    it("returns a deployment with debrief entries", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app", [env.id]);

      const triggerRes = await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });
      const deploymentId = JSON.parse(triggerRes.payload).deployment.id;

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/deployments/${deploymentId}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deployment.id).toBe(deploymentId);
      expect(body.debrief).toBeDefined();
      expect(Array.isArray(body.debrief)).toBe(true);
    });

    it("returns 404 for non-existent deployment", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/deployments/does-not-exist",
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe("Deployment not found");
    });
  });

  // --- GET /api/deployments/:id/postmortem ---

  describe("GET /api/deployments/:id/postmortem", () => {
    it("returns a postmortem for a deployment", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app", [env.id]);

      const triggerRes = await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });
      const deploymentId = JSON.parse(triggerRes.payload).deployment.id;

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/deployments/${deploymentId}/postmortem`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.postmortem).toBeDefined();
    });

    it("returns 404 for non-existent deployment", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/deployments/does-not-exist/postmortem",
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // --- GET /api/operations/:operationId/deployments ---

  describe("GET /api/operations/:operationId/deployments", () => {
    it("returns deployments filtered by operation", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op1 = ctx.operations.create("web-app", [env.id]);
      const op2 = ctx.operations.create("api-service", [env.id]);

      await deployViaHttp(ctx.app, {
        operationId: op1.id,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });
      await deployViaHttp(ctx.app, {
        operationId: op2.id,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/operations/${op1.id}/deployments`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deployments).toHaveLength(1);
      expect(body.deployments[0].operationId).toBe(op1.id);
    });
  });

  // --- GET /api/debrief ---

  describe("GET /api/debrief", () => {
    it("returns recent debrief entries", async () => {
      // Trigger a deployment to generate debrief entries
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app", [env.id]);

      await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/debrief",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.entries).toBeDefined();
      expect(body.entries.length).toBeGreaterThan(0);
    });

    it("respects limit parameter", async () => {
      // Generate a few entries
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const op = ctx.operations.create("web-app", [env.id]);

      await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/debrief?limit=2",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.entries.length).toBeLessThanOrEqual(2);
    });

    it("filters by partitionId", async () => {
      const env = ctx.environments.create("production");
      const p1 = ctx.partitions.create("Acme");
      const p2 = ctx.partitions.create("Beta");
      const op = ctx.operations.create("web-app", [env.id]);

      await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: p1.id,
        environmentId: env.id,
        version: "1.0.0",
      });
      await deployViaHttp(ctx.app, {
        operationId: op.id,
        partitionId: p2.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/debrief?partitionId=${p1.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      for (const entry of body.entries) {
        expect(entry.partitionId).toBe(p1.id);
      }
    });
  });
});

// ===========================================================================
// Health Routes
// ===========================================================================

describe("Health Routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  describe("GET /health", () => {
    it("returns healthy status", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/health",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe("ok");
      expect(body.service).toBe("deploystack-server");
      expect(body.timestamp).toBeDefined();
      // Validate timestamp is a valid ISO date
      expect(() => new Date(body.timestamp)).not.toThrow();
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });
  });
});
