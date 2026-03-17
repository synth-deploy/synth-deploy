import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  DecisionDebrief,
  PartitionStore,
  EnvironmentStore,
  ArtifactStore,
  SettingsStore,
  TelemetryStore,
} from "@synth-deploy/core";
import { SynthAgent, InMemoryDeploymentStore } from "../src/agent/synth-agent.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";
import { registerSettingsRoutes } from "../src/api/settings.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerArtifactRoutes } from "../src/api/artifacts.js";
import { registerHealthRoutes } from "../src/api/health.js";

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
// Shared test server factory
// ---------------------------------------------------------------------------

interface TestContext {
  app: FastifyInstance;
  diary: DecisionDebrief;
  partitions: PartitionStore;
  environments: EnvironmentStore;
  deployments: InMemoryDeploymentStore;
  artifactStore: ArtifactStore;
  settings: SettingsStore;
  telemetry: TelemetryStore;
  agent: SynthAgent;
}

async function createTestServer(): Promise<TestContext> {
  const diary = new DecisionDebrief();
  const partitions = new PartitionStore();
  const environments = new EnvironmentStore();
  const deployments = new InMemoryDeploymentStore();
  const artifactStore = new ArtifactStore();
  const settings = new SettingsStore();
  const telemetry = new TelemetryStore();
  // Do NOT pass settings as settingsReader to SynthAgent — with Envoy-only
  // enforcement (#115), a settingsReader triggers Envoy delegation which needs
  // a real Envoy. Tests use the local execution path (no settingsReader).
  const agent = new SynthAgent(
    diary, deployments, artifactStore, environments, partitions,
    undefined, { healthCheckBackoffMs: 1, executionDelayMs: 1 },
  );

  const app = Fastify();
  addMockAuth(app);
  registerPartitionRoutes(app, partitions, deployments, diary, telemetry);
  registerEnvironmentRoutes(app, environments, deployments, telemetry);
  registerSettingsRoutes(app, settings, telemetry);
  registerDeploymentRoutes(app, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
  registerArtifactRoutes(app, artifactStore, telemetry);
  registerHealthRoutes(app);

  await app.ready();
  return { app, diary, partitions, environments, deployments, artifactStore, settings, telemetry, agent };
}

/**
 * Helper: creates a deployment via the new artifact-based API.
 */
async function deployViaHttp(
  server: FastifyInstance,
  params: { artifactId: string; partitionId?: string; environmentId: string; version?: string },
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
    it("deletes an environment with no deployments", async () => {
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

    it("returns 409 when environment has deployments", async () => {
      const env = ctx.environments.create("production");
      const artifact = ctx.artifactStore.create({
        name: "web-app",
        type: "nodejs",
        analysis: { summary: "test", dependencies: [], configurationExpectations: {}, deploymentIntent: "rolling", confidence: 0.9 },
        annotations: [],
        learningHistory: [],
      });

      // Create a deployment linked to this environment
      await deployViaHttp(ctx.app, {
        artifactId: artifact.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      const res = await ctx.app.inject({
        method: "DELETE",
        url: `/api/environments/${env.id}`,
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain("deployment");
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
            url: "http://envoy:9411",
            timeoutMs: 5000,
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.settings.envoy.url).toBe("http://envoy:9411");
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
// Deployment Routes
// ===========================================================================

describe("Deployment Routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  /** Helper: create artifact in the store and return its ID */
  function seedArtifact(name = "web-app"): string {
    const artifact = ctx.artifactStore.create({
      name,
      type: "nodejs",
      analysis: { summary: "test", dependencies: [], configurationExpectations: {}, deploymentIntent: "rolling", confidence: 0.9 },
      annotations: [],
      learningHistory: [],
    });
    return artifact.id;
  }

  // --- POST /api/deployments ---

  describe("POST /api/deployments", () => {
    it("creates a deployment and returns 201", async () => {
      const env = ctx.environments.create("production", { APP_ENV: "production" });
      const partition = ctx.partitions.create("Acme", { DB_HOST: "acme-db" });
      const artifactId = seedArtifact();

      const res = await deployViaHttp(ctx.app, {
        artifactId,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.deployment).toBeDefined();
      expect(body.deployment.artifactId).toBe(artifactId);
      expect(body.deployment.partitionId).toBe(partition.id);
      expect(body.deployment.version).toBe("1.0.0");
    });

    it("returns 400 for invalid trigger", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/deployments",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 404 when artifact does not exist", async () => {
      const env = ctx.environments.create("production");

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/deployments",
        payload: {
          artifactId: "nonexistent-artifact",
          environmentId: env.id,
          version: "1.0.0",
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 404 when environment does not exist", async () => {
      const artifactId = seedArtifact();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/deployments",
        payload: {
          artifactId,
          environmentId: "nonexistent",
          version: "1.0.0",
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it("returns 404 when partition does not exist", async () => {
      const env = ctx.environments.create("production");
      const artifactId = seedArtifact();

      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/deployments",
        payload: {
          artifactId,
          environmentId: env.id,
          partitionId: "nonexistent",
          version: "1.0.0",
        },
      });

      expect(res.statusCode).toBe(404);
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

    it("returns deployments after creating one", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const artifactId = seedArtifact();

      await deployViaHttp(ctx.app, {
        artifactId,
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
      const artifactId = seedArtifact();

      await deployViaHttp(ctx.app, {
        artifactId,
        partitionId: p1.id,
        environmentId: env.id,
        version: "1.0.0",
      });
      await deployViaHttp(ctx.app, {
        artifactId,
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

    it("filters deployments by artifactId", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const art1 = seedArtifact("web-app");
      const art2 = seedArtifact("api-service");

      await deployViaHttp(ctx.app, {
        artifactId: art1,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });
      await deployViaHttp(ctx.app, {
        artifactId: art2,
        partitionId: partition.id,
        environmentId: env.id,
        version: "1.0.0",
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/deployments?artifactId=${art1}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.deployments).toHaveLength(1);
      expect(body.deployments[0].artifactId).toBe(art1);
    });
  });

  // --- GET /api/deployments/:id ---

  describe("GET /api/deployments/:id", () => {
    it("returns a deployment with debrief entries", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const artifactId = seedArtifact();

      const triggerRes = await deployViaHttp(ctx.app, {
        artifactId,
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
      const artifactId = seedArtifact();

      const triggerRes = await deployViaHttp(ctx.app, {
        artifactId,
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

  // --- GET /api/debrief ---

  describe("GET /api/debrief", () => {
    it("returns recent debrief entries", async () => {
      // Trigger a deployment to generate debrief entries
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const artifactId = seedArtifact();

      await deployViaHttp(ctx.app, {
        artifactId,
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
    });

    it("respects limit parameter", async () => {
      const env = ctx.environments.create("production");
      const partition = ctx.partitions.create("Acme");
      const artifactId = seedArtifact();

      await deployViaHttp(ctx.app, {
        artifactId,
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
      const artifactId = seedArtifact();

      await deployViaHttp(ctx.app, {
        artifactId,
        partitionId: p1.id,
        environmentId: env.id,
        version: "1.0.0",
      });
      await deployViaHttp(ctx.app, {
        artifactId,
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
// Artifact Routes
// ===========================================================================

describe("Artifact Routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  describe("POST /api/artifacts", () => {
    it("creates an artifact and returns 201", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/artifacts",
        payload: { name: "web-app", type: "nodejs" },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.payload);
      expect(body.artifact).toBeDefined();
      expect(body.artifact.name).toBe("web-app");
      expect(body.artifact.type).toBe("nodejs");
      expect(body.artifact.id).toBeDefined();
    });

    it("returns 400 for missing name", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/artifacts",
        payload: { type: "nodejs" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 400 for missing type", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/artifacts",
        payload: { name: "web-app" },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/artifacts", () => {
    it("returns empty list when no artifacts exist", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/artifacts",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.artifacts).toEqual([]);
    });

    it("returns all artifacts", async () => {
      ctx.artifactStore.create({
        name: "web-app", type: "nodejs",
        analysis: { summary: "test", dependencies: [], configurationExpectations: {}, deploymentIntent: "rolling", confidence: 0.9 },
        annotations: [], learningHistory: [],
      });
      ctx.artifactStore.create({
        name: "api-service", type: "docker",
        analysis: { summary: "test", dependencies: [], configurationExpectations: {}, deploymentIntent: "blue-green", confidence: 0.8 },
        annotations: [], learningHistory: [],
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/artifacts",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.artifacts).toHaveLength(2);
    });
  });

  describe("GET /api/artifacts/:id", () => {
    it("returns a specific artifact", async () => {
      const artifact = ctx.artifactStore.create({
        name: "web-app", type: "nodejs",
        analysis: { summary: "test", dependencies: [], configurationExpectations: {}, deploymentIntent: "rolling", confidence: 0.9 },
        annotations: [], learningHistory: [],
      });

      const res = await ctx.app.inject({
        method: "GET",
        url: `/api/artifacts/${artifact.id}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.artifact.id).toBe(artifact.id);
      expect(body.artifact.name).toBe("web-app");
    });

    it("returns 404 for non-existent artifact", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/artifacts/does-not-exist",
      });

      expect(res.statusCode).toBe(404);
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
      expect(body.service).toBe("synth-server");
      expect(body.timestamp).toBeDefined();
      // Validate timestamp is a valid ISO date
      expect(() => new Date(body.timestamp)).not.toThrow();
      expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
    });
  });
});
