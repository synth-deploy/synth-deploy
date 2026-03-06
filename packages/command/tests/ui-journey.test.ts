import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief, PartitionStore, EnvironmentStore, ArtifactStore, SettingsStore, TelemetryStore } from "@synth-deploy/core";
import type { Deployment, DebriefEntry, PostmortemReport, OperationHistory } from "@synth-deploy/core";
import { CommandAgent, InMemoryDeploymentStore } from "../src/agent/command-agent.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";
import { registerArtifactRoutes } from "../src/api/artifacts.js";
import { registerSettingsRoutes } from "../src/api/settings.js";

// ---------------------------------------------------------------------------
// Mock auth — inject a test user with all permissions on every request
// ---------------------------------------------------------------------------

function addMockAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    request.user = {
      id: "test-user-id" as any,
      email: "test@example.com",
      name: "Test User",
      permissions: [
        "deployment.create", "deployment.approve", "deployment.reject", "deployment.view", "deployment.rollback",
        "artifact.create", "artifact.update", "artifact.annotate", "artifact.delete", "artifact.view",
        "environment.create", "environment.update", "environment.delete", "environment.view",
        "partition.create", "partition.update", "partition.delete", "partition.view",
        "envoy.register", "envoy.configure", "envoy.view",
        "settings.manage", "users.manage", "roles.manage",
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Test server setup — mirrors index.ts but without MCP or static serving
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let diary: DecisionDebrief;
let partitions: PartitionStore;
let environments: EnvironmentStore;
let deployments: InMemoryDeploymentStore;
let artifactStore: ArtifactStore;
let settings: SettingsStore;
let telemetry: TelemetryStore;
let agent: CommandAgent;

beforeAll(async () => {
  diary = new DecisionDebrief();
  partitions = new PartitionStore();
  environments = new EnvironmentStore();
  deployments = new InMemoryDeploymentStore();
  artifactStore = new ArtifactStore();
  settings = new SettingsStore();
  telemetry = new TelemetryStore();
  agent = new CommandAgent(
    diary, deployments, artifactStore, environments, partitions,
    undefined, { healthCheckBackoffMs: 1, executionDelayMs: 1 },
  );

  app = Fastify();
  addMockAuth(app);
  registerDeploymentRoutes(app, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
  registerPartitionRoutes(app, partitions, deployments, diary, telemetry);
  registerEnvironmentRoutes(app, environments, deployments, telemetry);
  registerArtifactRoutes(app, artifactStore, telemetry);
  registerSettingsRoutes(app, settings, telemetry);

  await app.ready();
});

// ---------------------------------------------------------------------------
// Complete user journey — exercising every API the UI depends on
// ---------------------------------------------------------------------------

describe("Complete UI user journey", () => {
  let artifactId: string;
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

  // ---- Step 2: Create an artifact ----

  it("creates an artifact", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      payload: { name: "web-app", type: "nodejs" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.artifact.name).toBe("web-app");
    expect(body.artifact.type).toBe("nodejs");
    artifactId = body.artifact.id;
  });

  it("lists the artifact", async () => {
    const res = await app.inject({ method: "GET", url: "/api/artifacts" });
    const body = JSON.parse(res.payload);
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0].name).toBe("web-app");
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
        artifactId,
        partitionId,
        environmentId: productionEnvId,
        version: "1.0.0",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.deployment.version).toBe("1.0.0");
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

  // ---- Step 7: Read deployment detail ----

  it("gets deployment detail", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/deployments/${firstDeploymentId}`,
    });

    const body = JSON.parse(res.payload);
    expect(body.deployment.id).toBe(firstDeploymentId);
  });

  // ---- Step 8: Trigger a second deployment ----

  it("triggers a second deployment (version upgrade)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        artifactId,
        partitionId,
        environmentId: productionEnvId,
        version: "1.1.0",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.deployment.version).toBe("1.1.0");
    secondDeploymentId = body.deployment.id;
  });

  // ---- Step 9: Verify full deployment list ----

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

  // ---- Step 10: List deployments filtered by artifact ----

  it("lists deployments filtered by artifact", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/deployments?artifactId=${artifactId}`,
    });

    const body = JSON.parse(res.payload);
    expect(body.deployments).toHaveLength(2);
  });

  // ---- Step 11: List all entities (Dashboard queries) ----

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

  it("lists all artifacts", async () => {
    const res = await app.inject({ method: "GET", url: "/api/artifacts" });
    const body = JSON.parse(res.payload);
    expect(body.artifacts.length).toBeGreaterThanOrEqual(1);
    expect(body.artifacts[0].name).toBe("web-app");
  });

  // ---- Step 12: Error handling ----

  it("returns 404 for nonexistent artifact", async () => {
    const res = await app.inject({ method: "GET", url: "/api/artifacts/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for nonexistent partition", async () => {
    const res = await app.inject({ method: "GET", url: "/api/partitions/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  it("returns 400 for artifact without name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      payload: { type: "nodejs" },
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
