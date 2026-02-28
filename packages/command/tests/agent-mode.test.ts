import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief, PartitionStore, ProjectStore, EnvironmentStore, OrderStore } from "@deploystack/core";
import type { Deployment, DebriefEntry } from "@deploystack/core";
import { CommandAgent, InMemoryDeploymentStore } from "../src/agent/command-agent.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerProjectRoutes } from "../src/api/projects.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";
import { registerAgentRoutes } from "../src/api/agent.js";

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let diary: DecisionDebrief;
let partitions: PartitionStore;
let projects: ProjectStore;
let environments: EnvironmentStore;
let deployments: InMemoryDeploymentStore;
let orders: OrderStore;
let agent: CommandAgent;

let projectId: string;
let partitionId: string;
let productionEnvId: string;
let stagingEnvId: string;

beforeAll(async () => {
  diary = new DecisionDebrief();
  partitions = new PartitionStore();
  projects = new ProjectStore();
  environments = new EnvironmentStore();
  deployments = new InMemoryDeploymentStore();
  orders = new OrderStore();
  agent = new CommandAgent(diary, deployments, orders);

  app = Fastify();
  registerDeploymentRoutes(app, agent, partitions, environments, deployments, diary, projects, orders);
  registerProjectRoutes(app, projects, environments);
  registerPartitionRoutes(app, partitions, deployments, diary);
  registerEnvironmentRoutes(app, environments, projects);
  registerAgentRoutes(app, agent, partitions, environments, projects, deployments, diary);

  await app.ready();

  // Seed test data
  const envRes = await app.inject({
    method: "POST",
    url: "/api/environments",
    payload: { name: "production", variables: { APP_ENV: "production", LOG_LEVEL: "warn" } },
  });
  productionEnvId = JSON.parse(envRes.payload).environment.id;

  const stagingRes = await app.inject({
    method: "POST",
    url: "/api/environments",
    payload: { name: "staging", variables: { APP_ENV: "staging", LOG_LEVEL: "debug" } },
  });
  stagingEnvId = JSON.parse(stagingRes.payload).environment.id;

  const projRes = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { name: "web-app", environmentIds: [productionEnvId, stagingEnvId] },
  });
  projectId = JSON.parse(projRes.payload).project.id;

  const partitionRes = await app.inject({
    method: "POST",
    url: "/api/partitions",
    payload: { name: "Acme Corp" },
  });
  partitionId = JSON.parse(partitionRes.payload).partition.id;

  await app.inject({
    method: "PUT",
    url: `/api/partitions/${partitionId}/variables`,
    payload: { variables: { DB_HOST: "acme-db-1", APP_ENV: "production" } },
  });
});

// ---------------------------------------------------------------------------
// Intent interpretation tests
// ---------------------------------------------------------------------------

describe("Agent mode — intent interpretation", () => {
  it("resolves a fully-specified intent to exact matches", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "Deploy web-app v2.0.0 to production for Acme Corp",
      },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);

    expect(result.ready).toBe(true);
    expect(result.missingFields).toHaveLength(0);
    expect(result.resolved.projectId.value).toBe(projectId);
    expect(result.resolved.projectId.confidence).toBe("exact");
    expect(result.resolved.partitionId.value).toBe(partitionId);
    expect(result.resolved.partitionId.confidence).toBe("exact");
    expect(result.resolved.environmentId.value).toBe(productionEnvId);
    expect(result.resolved.environmentId.confidence).toBe("exact");
    expect(result.resolved.version.value).toBe("2.0.0");
    expect(result.resolved.version.confidence).toBe("exact");
  });

  it("identifies missing fields in a partial intent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "Deploy to production",
      },
    });

    const result = JSON.parse(res.payload);
    expect(result.ready).toBe(false);
    expect(result.missingFields).toContain("version");
    // Project may be inferred if only one exists
    expect(result.resolved.environmentId.confidence).toBe("exact");
  });

  it("uses partial config to fill gaps", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "Deploy version 3.0.0",
        partialConfig: {
          projectId,
          partitionId,
          environmentId: productionEnvId,
        },
      },
    });

    const result = JSON.parse(res.payload);
    expect(result.ready).toBe(true);
    expect(result.resolved.projectId.value).toBe(projectId);
    expect(result.resolved.version.value).toBe("3.0.0");
  });

  it("extracts variables from intent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: 'Deploy web-app v1.0.0 to production for Acme Corp with FEATURE_FLAG="new-ui"',
      },
    });

    const result = JSON.parse(res.payload);
    expect(result.resolved.variables.FEATURE_FLAG).toBe("new-ui");
  });

  it("returns 400 for empty intent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("matches environment aliases (prod, stg)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v1.0.0 to prod for Acme Corp" },
    });

    const result = JSON.parse(res.payload);
    expect(result.resolved.environmentId.value).toBe(productionEnvId);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v1.0.0 to staging for Acme Corp" },
    });

    const result2 = JSON.parse(res2.payload);
    expect(result2.resolved.environmentId.value).toBe(stagingEnvId);
  });

  it("records intent interpretation to Decision Diary", async () => {
    const beforeCount = diary.getRecent(100).length;

    await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v1.0.0 to production for Acme Corp" },
    });

    const afterCount = diary.getRecent(100).length;
    expect(afterCount).toBeGreaterThan(beforeCount);

    const entries = diary.getRecent(1);
    expect(entries[0].decision).toContain("Intent");
  });
});

// ---------------------------------------------------------------------------
// Deployment context tests
// ---------------------------------------------------------------------------

describe("Agent mode — deployment context", () => {
  it("returns context with signals and environment summary", async () => {
    // Trigger a deployment first to have some data
    await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: { projectId, partitionId, environmentId: productionEnvId, version: "1.0.0" },
    });

    const res = await app.inject({ method: "GET", url: "/api/agent/context" });

    expect(res.statusCode).toBe(200);
    const context = JSON.parse(res.payload);

    expect(context.recentActivity).toBeDefined();
    expect(context.recentActivity.deploymentsLast24h).toBeGreaterThanOrEqual(1);
    expect(context.recentActivity.successRate).toBeDefined();
    expect(context.environmentSummary).toBeDefined();
    expect(context.environmentSummary.length).toBeGreaterThanOrEqual(2);
    expect(context.signals).toBeDefined();
  });

  it("environment summary reflects deployment status", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agent/context" });
    const context = JSON.parse(res.payload);

    const prodSummary = context.environmentSummary.find((e: any) => e.name === "production");
    expect(prodSummary).toBeDefined();
    expect(prodSummary.deployCount).toBeGreaterThanOrEqual(1);
    expect(prodSummary.lastDeployStatus).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: Identical artifacts test
// ---------------------------------------------------------------------------

describe("Identical artifacts — traditional vs agent mode", () => {
  it("produces the same deployment output regardless of mode", async () => {
    // --- Traditional mode: explicit trigger with all fields ---
    const traditionalRes = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        projectId,
        partitionId,
        environmentId: productionEnvId,
        version: "5.0.0",
        variables: { CACHE_TTL: "3600" },
      },
    });

    expect(traditionalRes.statusCode).toBe(201);
    const traditional = JSON.parse(traditionalRes.payload);
    const traditionalDeploy: Deployment = traditional.deployment;

    // --- Agent mode: interpret intent, then trigger with resolved config ---
    const intentRes = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: 'Deploy web-app v5.0.0 to production for Acme Corp with CACHE_TTL="3600"',
      },
    });

    const intent = JSON.parse(intentRes.payload);
    expect(intent.ready).toBe(true);

    // Use the resolved config to trigger — same endpoint as traditional mode
    const agentRes = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        projectId: intent.resolved.projectId.value,
        partitionId: intent.resolved.partitionId.value,
        environmentId: intent.resolved.environmentId.value,
        version: intent.resolved.version.value,
        variables: intent.resolved.variables,
      },
    });

    expect(agentRes.statusCode).toBe(201);
    const agentDeploy: Deployment = JSON.parse(agentRes.payload).deployment;

    // --- Compare: identical artifacts ---

    // Same trigger inputs
    expect(agentDeploy.projectId).toBe(traditionalDeploy.projectId);
    expect(agentDeploy.partitionId).toBe(traditionalDeploy.partitionId);
    expect(agentDeploy.environmentId).toBe(traditionalDeploy.environmentId);
    expect(agentDeploy.version).toBe(traditionalDeploy.version);

    // Same resolved variables (after merge with partition/environment)
    expect(agentDeploy.variables).toEqual(traditionalDeploy.variables);

    // Same status
    expect(agentDeploy.status).toBe(traditionalDeploy.status);

    // Same diary structure (same number of decision types)
    const traditionalDiary: DebriefEntry[] = traditional.debrief;
    const agentDiary: DebriefEntry[] = JSON.parse(agentRes.payload).debrief;

    const traditionalTypes = traditionalDiary.map((d) => d.decisionType).sort();
    const agentTypes = agentDiary.map((d) => d.decisionType).sort();
    expect(agentTypes).toEqual(traditionalTypes);
  });

  it("mid-configuration switch preserves fields", async () => {
    // Simulate: user starts in agent mode, interprets an intent
    const intentRes = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "Deploy web-app v6.0.0 to staging for Acme Corp",
      },
    });

    const intent = JSON.parse(intentRes.payload);
    expect(intent.ready).toBe(true);

    // User switches to traditional mode — fields should already be populated.
    // They complete the deployment using the traditional endpoint with the same values.
    const traditionalRes = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        projectId: intent.resolved.projectId.value,
        partitionId: intent.resolved.partitionId.value,
        environmentId: intent.resolved.environmentId.value,
        version: intent.resolved.version.value,
      },
    });

    expect(traditionalRes.statusCode).toBe(201);
    const deploy = JSON.parse(traditionalRes.payload).deployment;
    expect(deploy.version).toBe("6.0.0");
    expect(deploy.environmentId).toBe(stagingEnvId);
    expect(deploy.status).toBe("succeeded");
  });

  it("traditional config can be refined via agent intent", async () => {
    // Simulate: user partially fills form in traditional mode, then switches to agent
    // The agent receives partial config and intent to fill remaining fields
    const intentRes = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "deploy version 7.0.0 to production",
        partialConfig: {
          projectId,
          partitionId,
        },
      },
    });

    const intent = JSON.parse(intentRes.payload);
    expect(intent.ready).toBe(true);
    expect(intent.resolved.projectId.value).toBe(projectId);
    expect(intent.resolved.partitionId.value).toBe(partitionId);
    expect(intent.resolved.version.value).toBe("7.0.0");
    expect(intent.resolved.environmentId.value).toBe(productionEnvId);
  });
});
