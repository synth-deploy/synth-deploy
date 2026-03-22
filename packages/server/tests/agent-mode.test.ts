import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief, PartitionStore, EnvironmentStore, ArtifactStore, SettingsStore, TelemetryStore } from "@synth-deploy/core";
import { SynthAgent, InMemoryDeploymentStore } from "../src/agent/synth-agent.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";
import { registerArtifactRoutes } from "../src/api/artifacts.js";
import { registerAgentRoutes } from "../src/api/agent.js";
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
// Test server setup
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let diary: DecisionDebrief;
let partitions: PartitionStore;
let environments: EnvironmentStore;
let deployments: InMemoryDeploymentStore;
let artifactStore: ArtifactStore;
let settings: SettingsStore;
let telemetry: TelemetryStore;
let agent: SynthAgent;

let artifactId: string;
let partitionId: string;
let productionEnvId: string;
let stagingEnvId: string;

beforeAll(async () => {
  diary = new DecisionDebrief();
  partitions = new PartitionStore();
  environments = new EnvironmentStore();
  deployments = new InMemoryDeploymentStore();
  artifactStore = new ArtifactStore();
  settings = new SettingsStore();
  telemetry = new TelemetryStore();
  agent = new SynthAgent(
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
  registerAgentRoutes(app, agent, partitions, environments, artifactStore, deployments, diary, settings);

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

  const artifactRes = await app.inject({
    method: "POST",
    url: "/api/artifacts",
    payload: { name: "web-app", type: "nodejs" },
  });
  artifactId = JSON.parse(artifactRes.payload).artifact.id;

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

/**
 * Helper: creates a deployment via the new artifact-based API.
 */
async function deployViaHttp(
  server: FastifyInstance,
  params: { artifactId: string; partitionId?: string; environmentId: string; version?: string; variables?: Record<string, string> },
) {
  return server.inject({
    method: "POST",
    url: "/api/deployments",
    payload: {
      artifactId: params.artifactId,
      environmentId: params.environmentId,
      partitionId: params.partitionId,
      version: params.version,
    },
  });
}

// ---------------------------------------------------------------------------
// Deployment context tests
// ---------------------------------------------------------------------------

describe("Agent mode — deployment context", () => {
  it("returns context with signals and environment summary", async () => {
    // Trigger a deployment first to have some data
    await deployViaHttp(app, { artifactId, partitionId, environmentId: productionEnvId, version: "1.0.0" });

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
  });
});


