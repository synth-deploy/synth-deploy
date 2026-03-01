import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief, PartitionStore, OperationStore, EnvironmentStore, OrderStore, SettingsStore } from "@deploystack/core";
import type { Deployment, DebriefEntry, PostmortemReport, OperationHistory } from "@deploystack/core";
import { CommandAgent, InMemoryDeploymentStore } from "../src/agent/command-agent.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerOperationRoutes } from "../src/api/operations.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";

// ---------------------------------------------------------------------------
// Test server setup — mirrors index.ts but without MCP or static serving
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let diary: DecisionDebrief;
let partitions: PartitionStore;
let operations: OperationStore;
let environments: EnvironmentStore;
let deployments: InMemoryDeploymentStore;
let orders: OrderStore;
let settings: SettingsStore;
let agent: CommandAgent;

beforeAll(async () => {
  diary = new DecisionDebrief();
  partitions = new PartitionStore();
  operations = new OperationStore();
  environments = new EnvironmentStore();
  deployments = new InMemoryDeploymentStore();
  orders = new OrderStore();
  settings = new SettingsStore();
  agent = new CommandAgent(diary, deployments, orders);

  app = Fastify();
  registerDeploymentRoutes(app, agent, partitions, environments, deployments, diary, operations, orders, settings);
  registerOperationRoutes(app, operations, environments);
  registerPartitionRoutes(app, partitions, deployments, diary);
  registerEnvironmentRoutes(app, environments, operations);

  await app.ready();
});

// ---------------------------------------------------------------------------
// Complete user journey — exercising every API the UI depends on
// ---------------------------------------------------------------------------

describe("Complete UI user journey", () => {
  let operationId: string;
  let partitionId: string;
  let productionEnvId: string;
  let stagingEnvId: string;
  let firstDeploymentId: string;
  let secondDeploymentId: string;

  // ---- Step 1: Create environments ----

  it("creates a production environment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "production", variables: { APP_ENV: "production", LOG_LEVEL: "warn" } },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.environment.name).toBe("production");
    expect(body.environment.variables.APP_ENV).toBe("production");
    productionEnvId = body.environment.id;
  });

  it("creates a staging environment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "staging", variables: { APP_ENV: "staging", LOG_LEVEL: "debug" } },
    });

    expect(res.statusCode).toBe(201);
    stagingEnvId = JSON.parse(res.payload).environment.id;
  });

  // ---- Step 2: Create an operation ----

  it("creates an operation linked to both environments", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operations",
      payload: { name: "web-app", environmentIds: [productionEnvId, stagingEnvId] },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.operation.name).toBe("web-app");
    expect(body.operation.environmentIds).toHaveLength(2);
    operationId = body.operation.id;
  });

  it("lists the operation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/operations" });
    const body = JSON.parse(res.payload);
    expect(body.operations).toHaveLength(1);
    expect(body.operations[0].name).toBe("web-app");
  });

  it("gets operation detail with environment info", async () => {
    const res = await app.inject({ method: "GET", url: `/api/operations/${operationId}` });
    const body = JSON.parse(res.payload);
    expect(body.operation.name).toBe("web-app");
    expect(body.environments).toHaveLength(2);
    expect(body.environments.map((e: any) => e.name).sort()).toEqual(["production", "staging"]);
  });

  // ---- Step 3: Create a partition ----

  it("creates a partition", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/partitions",
      payload: { name: "Acme Corp" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.partition.name).toBe("Acme Corp");
    partitionId = body.partition.id;
  });

  // ---- Step 4: Configure partition variables ----

  it("updates partition variables", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/partitions/${partitionId}/variables`,
      payload: { variables: { DB_HOST: "acme-db-1", APP_ENV: "production" } },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.partition.variables.DB_HOST).toBe("acme-db-1");
    expect(body.partition.variables.APP_ENV).toBe("production");
  });

  it("gets partition by ID with variables", async () => {
    const res = await app.inject({ method: "GET", url: `/api/partitions/${partitionId}` });
    const body = JSON.parse(res.payload);
    expect(body.partition.name).toBe("Acme Corp");
    expect(body.partition.variables.DB_HOST).toBe("acme-db-1");
  });

  // ---- Step 5: Trigger first deployment ----

  it("triggers a deployment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        operationId,
        partitionId,
        environmentId: productionEnvId,
        version: "1.0.0",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.deployment.status).toBe("succeeded");
    expect(body.deployment.version).toBe("1.0.0");
    expect(body.debrief.length).toBeGreaterThan(0);
    firstDeploymentId = body.deployment.id;
  });

  // ---- Step 6: Read deployment history ----

  it("lists deployments filtered by partition", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/deployments?partitionId=${partitionId}`,
    });

    const body = JSON.parse(res.payload);
    expect(body.deployments).toHaveLength(1);
    expect(body.deployments[0].id).toBe(firstDeploymentId);
  });

  // ---- Step 7: Read deployment detail with diary entries ----

  it("gets deployment detail with Decision Diary entries", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/deployments/${firstDeploymentId}`,
    });

    const body = JSON.parse(res.payload);
    expect(body.deployment.id).toBe(firstDeploymentId);
    expect(body.deployment.status).toBe("succeeded");

    // Decision Diary entries must exist and be specific
    expect(body.debrief.length).toBeGreaterThanOrEqual(3);

    // Verify diary entry structure
    const entry = body.debrief[0] as DebriefEntry;
    expect(entry.id).toBeDefined();
    expect(entry.decision).toBeDefined();
    expect(entry.reasoning).toBeDefined();
    expect(entry.decisionType).toBeDefined();
    expect(entry.agent).toBe("command");

    // Every entry should be tagged with our deployment
    for (const de of body.debrief) {
      expect(de.deploymentId).toBe(firstDeploymentId);
    }
  });

  // ---- Step 8: Read postmortem ----

  it("generates a postmortem report", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/deployments/${firstDeploymentId}/postmortem`,
    });

    const body = JSON.parse(res.payload);
    const pm: PostmortemReport = body.postmortem;

    expect(pm.summary).toContain("1.0.0");
    expect(pm.summary).toContain("SUCCEEDED");
    expect(pm.timeline.length).toBeGreaterThan(0);
    expect(pm.configuration.variableCount).toBeGreaterThan(0);
    expect(pm.failureAnalysis).toBeNull(); // succeeded, no failure analysis
    expect(pm.outcome).toBeDefined();
    expect(pm.formatted).toBeDefined();
    expect(pm.formatted.length).toBeGreaterThan(100);
  });

  // ---- Step 9: Trigger a second deployment ----

  it("triggers a second deployment (version upgrade)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        operationId,
        partitionId,
        environmentId: productionEnvId,
        version: "1.1.0",
        variables: { FEATURE_FLAG: "new-ui" },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.deployment.status).toBe("succeeded");
    expect(body.deployment.version).toBe("1.1.0");
    secondDeploymentId = body.deployment.id;
  });

  // ---- Step 10: Read partition history with both deployments ----

  it("generates partition deployment history", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/partitions/${partitionId}/history`,
    });

    const body = JSON.parse(res.payload);
    const history: OperationHistory = body.history;

    expect(history.overview.totalDeployments).toBe(2);
    expect(history.overview.succeeded).toBe(2);
    expect(history.overview.successRate).toBe("100%");
    expect(history.overview.versions).toContain("1.0.0");
    expect(history.overview.versions).toContain("1.1.0");
    expect(history.deployments).toHaveLength(2);
    expect(history.formatted).toBeDefined();
    expect(history.formatted).toContain("1.0.0");
    expect(history.formatted).toContain("1.1.0");
  });

  // ---- Step 11: Verify full deployment list ----

  it("lists all deployments for partition showing both", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/deployments?partitionId=${partitionId}`,
    });

    const body = JSON.parse(res.payload);
    expect(body.deployments).toHaveLength(2);

    const versions = body.deployments.map((d: Deployment) => d.version).sort();
    expect(versions).toEqual(["1.0.0", "1.1.0"]);
  });

  // ---- Step 12: List operation deployments ----

  it("lists deployments filtered by operation", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/operations/${operationId}/deployments`,
    });

    const body = JSON.parse(res.payload);
    expect(body.deployments).toHaveLength(2);
  });

  // ---- Step 13: List all entities (Dashboard queries) ----

  it("lists all partitions", async () => {
    const res = await app.inject({ method: "GET", url: "/api/partitions" });
    const body = JSON.parse(res.payload);
    expect(body.partitions.length).toBeGreaterThanOrEqual(1);
    expect(body.partitions.some((t: any) => t.name === "Acme Corp")).toBe(true);
  });

  it("lists all environments", async () => {
    const res = await app.inject({ method: "GET", url: "/api/environments" });
    const body = JSON.parse(res.payload);
    expect(body.environments.length).toBeGreaterThanOrEqual(2);
  });

  it("lists all deployments", async () => {
    const res = await app.inject({ method: "GET", url: "/api/deployments" });
    const body = JSON.parse(res.payload);
    expect(body.deployments.length).toBeGreaterThanOrEqual(2);
  });

  it("gets recent diary entries", async () => {
    const res = await app.inject({ method: "GET", url: "/api/debrief?limit=10" });
    const body = JSON.parse(res.payload);
    expect(body.entries.length).toBeGreaterThan(0);

    // Entries should have full structure
    for (const entry of body.entries) {
      expect(entry.decision).toBeDefined();
      expect(entry.reasoning).toBeDefined();
      expect(entry.decisionType).toBeDefined();
    }
  });

  // ---- Step 14: Error handling ----

  it("returns 404 for nonexistent operation", async () => {
    const res = await app.inject({ method: "GET", url: "/api/operations/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for nonexistent partition", async () => {
    const res = await app.inject({ method: "GET", url: "/api/partitions/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for operation without name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/operations",
      payload: { environmentIds: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for partition without name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/partitions",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for environment without name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/environments",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
