import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief, TenantStore, ProjectStore, EnvironmentStore, OrderStore } from "@deploystack/core";
import type { Deployment, DebriefEntry, PostmortemReport, ProjectHistory } from "@deploystack/core";
import { ServerAgent, InMemoryDeploymentStore } from "../src/agent/server-agent.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerProjectRoutes } from "../src/api/projects.js";
import { registerTenantRoutes } from "../src/api/tenants.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";

// ---------------------------------------------------------------------------
// Test server setup — mirrors index.ts but without MCP or static serving
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let diary: DecisionDebrief;
let tenants: TenantStore;
let projects: ProjectStore;
let environments: EnvironmentStore;
let deployments: InMemoryDeploymentStore;
let orders: OrderStore;
let agent: ServerAgent;

beforeAll(async () => {
  diary = new DecisionDebrief();
  tenants = new TenantStore();
  projects = new ProjectStore();
  environments = new EnvironmentStore();
  deployments = new InMemoryDeploymentStore();
  orders = new OrderStore();
  agent = new ServerAgent(diary, deployments, orders);

  app = Fastify();
  registerDeploymentRoutes(app, agent, tenants, environments, deployments, diary, projects, orders);
  registerProjectRoutes(app, projects, environments);
  registerTenantRoutes(app, tenants, deployments, diary);
  registerEnvironmentRoutes(app, environments, projects);

  await app.ready();
});

// ---------------------------------------------------------------------------
// Complete user journey — exercising every API the UI depends on
// ---------------------------------------------------------------------------

describe("Complete UI user journey", () => {
  let projectId: string;
  let tenantId: string;
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

  // ---- Step 2: Create a project ----

  it("creates a project linked to both environments", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "web-app", environmentIds: [productionEnvId, stagingEnvId] },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.project.name).toBe("web-app");
    expect(body.project.environmentIds).toHaveLength(2);
    projectId = body.project.id;
  });

  it("lists the project", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects" });
    const body = JSON.parse(res.payload);
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0].name).toBe("web-app");
  });

  it("gets project detail with environment info", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}` });
    const body = JSON.parse(res.payload);
    expect(body.project.name).toBe("web-app");
    expect(body.environments).toHaveLength(2);
    expect(body.environments.map((e: any) => e.name).sort()).toEqual(["production", "staging"]);
  });

  // ---- Step 3: Create a tenant ----

  it("creates a tenant", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tenants",
      payload: { name: "Acme Corp" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.tenant.name).toBe("Acme Corp");
    tenantId = body.tenant.id;
  });

  // ---- Step 4: Configure tenant variables ----

  it("updates tenant variables", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/tenants/${tenantId}/variables`,
      payload: { variables: { DB_HOST: "acme-db-1", APP_ENV: "production" } },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.tenant.variables.DB_HOST).toBe("acme-db-1");
    expect(body.tenant.variables.APP_ENV).toBe("production");
  });

  it("gets tenant by ID with variables", async () => {
    const res = await app.inject({ method: "GET", url: `/api/tenants/${tenantId}` });
    const body = JSON.parse(res.payload);
    expect(body.tenant.name).toBe("Acme Corp");
    expect(body.tenant.variables.DB_HOST).toBe("acme-db-1");
  });

  // ---- Step 5: Trigger first deployment ----

  it("triggers a deployment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        projectId,
        tenantId,
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

  it("lists deployments filtered by tenant", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/deployments?tenantId=${tenantId}`,
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
    expect(entry.agent).toBe("server");

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
        projectId,
        tenantId,
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

  // ---- Step 10: Read tenant history with both deployments ----

  it("generates tenant deployment history", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/tenants/${tenantId}/history`,
    });

    const body = JSON.parse(res.payload);
    const history: ProjectHistory = body.history;

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

  it("lists all deployments for tenant showing both", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/deployments?tenantId=${tenantId}`,
    });

    const body = JSON.parse(res.payload);
    expect(body.deployments).toHaveLength(2);

    const versions = body.deployments.map((d: Deployment) => d.version).sort();
    expect(versions).toEqual(["1.0.0", "1.1.0"]);
  });

  // ---- Step 12: List project deployments ----

  it("lists deployments filtered by project", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/deployments`,
    });

    const body = JSON.parse(res.payload);
    expect(body.deployments).toHaveLength(2);
  });

  // ---- Step 13: List all entities (Dashboard queries) ----

  it("lists all tenants", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tenants" });
    const body = JSON.parse(res.payload);
    expect(body.tenants.length).toBeGreaterThanOrEqual(1);
    expect(body.tenants.some((t: any) => t.name === "Acme Corp")).toBe(true);
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

  it("returns 404 for nonexistent project", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for nonexistent tenant", async () => {
    const res = await app.inject({ method: "GET", url: "/api/tenants/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for project without name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { environmentIds: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for tenant without name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tenants",
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
