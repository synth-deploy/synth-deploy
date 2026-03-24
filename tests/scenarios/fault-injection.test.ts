/**
 * Fault injection tests — Phase 3 of #98
 *
 * Deliberately break things and verify graceful degradation:
 * every failure leaves the environment in a known state with a
 * plain-language explanation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  DecisionDebrief,
  PartitionStore,
  ArtifactStore,
  EnvironmentStore,
  TelemetryStore,
  SettingsStore,
} from "@synth-deploy/core";
import {
  SynthAgent,
  InMemoryDeploymentStore,
} from "@synth-deploy/server/agent/synth-agent.js";
import { registerOperationRoutes } from "@synth-deploy/server/api/operations.js";
import { registerPartitionRoutes } from "@synth-deploy/server/api/partitions.js";
import { registerEnvironmentRoutes } from "@synth-deploy/server/api/environments.js";
import { registerSettingsRoutes } from "@synth-deploy/server/api/settings.js";
import { registerEnvoyReportRoutes } from "@synth-deploy/server/api/envoy-reports.js";
import { registerArtifactRoutes } from "@synth-deploy/server/api/artifacts.js";
import { EnvoyAgent } from "@synth-deploy/envoy/agent/envoy-agent.js";
import { LocalStateStore } from "@synth-deploy/envoy/state/local-state.js";
import { createEnvoyServer } from "@synth-deploy/envoy/server.js";
import {
  makeTmpDir,
  removeTmpDir,
  http,
  createPartition,
  createEnvironment,
  createArtifact,
  deploy,
} from "./harness.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPort(app: FastifyInstance): number {
  const addr = app.server.address();
  if (addr && typeof addr === "object") return addr.port;
  throw new Error("Server not listening on a port");
}

/** Mock auth — inject a test user with all permissions on every request. */
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

async function createCommandWithEnvoy(envoyUrl: string, timeoutMs = 2000) {
  const diary = new DecisionDebrief();
  const partitions = new PartitionStore();
  const artifactStore = new ArtifactStore();
  const environments = new EnvironmentStore();
  const deployments = new InMemoryDeploymentStore();
  const telemetry = new TelemetryStore();
  const settings = new SettingsStore();
  settings.update({ envoy: { url: envoyUrl, timeoutMs } });

  const agent = new SynthAgent(diary, deployments, artifactStore, environments, partitions, undefined, {
    healthCheckBackoffMs: 1,
    executionDelayMs: 1,
  }, settings);

  const app = Fastify({ logger: false });
  addMockAuth(app);
  registerOperationRoutes(app, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
  registerPartitionRoutes(app, partitions, deployments, diary, telemetry);
  registerEnvironmentRoutes(app, environments, deployments, telemetry);
  registerSettingsRoutes(app, settings, telemetry);
  registerEnvoyReportRoutes(app, diary, deployments);
  registerArtifactRoutes(app, artifactStore, telemetry);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${getPort(app)}`;

  return { app, baseUrl, diary, partitions, artifactStore, environments, deployments, telemetry, settings, agent };
}

// ===========================================================================
// 1. Deployment creation when Envoy is offline
// ===========================================================================

describe("Envoy offline — deployment creation", { timeout: 30000 }, () => {
  let cmd: Awaited<ReturnType<typeof createCommandWithEnvoy>>;

  beforeAll(async () => {
    cmd = await createCommandWithEnvoy("http://127.0.0.1:19999", 500);
  });

  afterAll(async () => {
    await cmd.app.close();
  });

  it("deployment is created successfully even when Envoy is offline", async () => {
    const artId = await createArtifact(cmd.baseUrl, "offline-svc");
    const envId = await createEnvironment(cmd.baseUrl, "offline-env");
    const partId = await createPartition(cmd.baseUrl, "OfflineCo");

    const res = await deploy(cmd.baseUrl, {
      artifactId: artId,
      partitionId: partId,
      environmentId: envId,
      version: "1.0.0",
    });

    // Deployment creation succeeds (Envoy is not contacted during creation)
    expect(res.status).toBe(201);
    const dep = res.body.deployment as Record<string, unknown>;
    expect(dep.id).toBeDefined();

    // Verify the deployment is retrievable
    const detailRes = await http(cmd.baseUrl, "GET", `/api/operations/${dep.id}`);
    expect(detailRes.status).toBe(200);
  });
});

// ===========================================================================
// 2. Deployment with live Envoy
// ===========================================================================

describe("Deployment with live Envoy", () => {
  let cmd: Awaited<ReturnType<typeof createCommandWithEnvoy>>;
  let envoyApp: FastifyInstance;
  let envoyTmpDir: string;

  beforeAll(async () => {
    envoyTmpDir = makeTmpDir();
    const envoyDiary = new DecisionDebrief();
    const envoyState = new LocalStateStore();
    const envoyAgent = new EnvoyAgent(envoyDiary, envoyState, envoyTmpDir);
    envoyApp = createEnvoyServer(envoyAgent, envoyState);
    await envoyApp.listen({ port: 0, host: "127.0.0.1" });
    const envoyUrl = `http://127.0.0.1:${getPort(envoyApp)}`;

    cmd = await createCommandWithEnvoy(envoyUrl);
  });

  afterAll(async () => {
    await cmd.app.close();
    try { await envoyApp.close(); } catch { /* may already be closed */ }
    removeTmpDir(envoyTmpDir);
  });

  it("deployment with live Envoy creates successfully", async () => {
    const artId = await createArtifact(cmd.baseUrl, "live-envoy-svc");
    const envId = await createEnvironment(cmd.baseUrl, "live-envoy-env");
    const partId = await createPartition(cmd.baseUrl, "LiveCo");

    const res = await deploy(cmd.baseUrl, {
      artifactId: artId,
      partitionId: partId,
      environmentId: envId,
      version: "1.0.0",
    });

    expect(res.status).toBe(201);
    const dep = res.body.deployment as Record<string, unknown>;
    expect(dep.id).toBeDefined();
  });
});

// ===========================================================================
// 3. Concurrent deployments to same partition
// ===========================================================================

describe("Concurrent deployments to same partition", () => {
  let cmd: Awaited<ReturnType<typeof createCommandWithEnvoy>>;
  let envoyApp: FastifyInstance;
  let envoyTmpDir: string;

  beforeAll(async () => {
    envoyTmpDir = makeTmpDir();
    const envoyDiary = new DecisionDebrief();
    const envoyState = new LocalStateStore();
    const envoyAgent = new EnvoyAgent(envoyDiary, envoyState, envoyTmpDir);
    envoyApp = createEnvoyServer(envoyAgent, envoyState);
    await envoyApp.listen({ port: 0, host: "127.0.0.1" });
    const envoyUrl = `http://127.0.0.1:${getPort(envoyApp)}`;

    cmd = await createCommandWithEnvoy(envoyUrl);
  });

  afterAll(async () => {
    await cmd.app.close();
    await envoyApp.close();
    removeTmpDir(envoyTmpDir);
  });

  it("two simultaneous deployments both resolve successfully", async () => {
    const artId = await createArtifact(cmd.baseUrl, "concurrent-svc");
    const envId = await createEnvironment(cmd.baseUrl, "concurrent-env");
    const partId = await createPartition(cmd.baseUrl, "ConcurrentCo");

    const [res1, res2] = await Promise.all([
      deploy(cmd.baseUrl, {
        artifactId: artId,
        partitionId: partId,
        environmentId: envId,
        version: "1.0.0",
      }),
      deploy(cmd.baseUrl, {
        artifactId: artId,
        partitionId: partId,
        environmentId: envId,
        version: "2.0.0",
      }),
    ]);

    // Both should resolve (201 created)
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    const dep1 = res1.body.deployment as Record<string, unknown>;
    const dep2 = res2.body.deployment as Record<string, unknown>;

    // Both must have unique deployment IDs
    expect(dep1.id).not.toBe(dep2.id);
  });
});

// ===========================================================================
// 4. Invalid configuration — deploy with nonexistent entities
// ===========================================================================

describe("Invalid configuration", () => {
  let cmd: Awaited<ReturnType<typeof createCommandWithEnvoy>>;

  beforeAll(async () => {
    cmd = await createCommandWithEnvoy("http://127.0.0.1:19999");
  });

  afterAll(async () => {
    await cmd.app.close();
  });

  it("deployment with nonexistent artifact returns clear error", async () => {
    const envId = await createEnvironment(cmd.baseUrl, "invalid-art-env");

    const res = await http(cmd.baseUrl, "POST", "/api/operations", {
      artifactId: "nonexistent-artifact",
      environmentId: envId,
      version: "1.0.0",
    });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain("not found");
  });

  it("deployment with nonexistent partition returns clear error", async () => {
    const artId = await createArtifact(cmd.baseUrl, "invalid-part-svc");
    const envId = await createEnvironment(cmd.baseUrl, "invalid-part-env");

    const res = await http(cmd.baseUrl, "POST", "/api/operations", {
      artifactId: artId,
      partitionId: "nonexistent-partition",
      environmentId: envId,
      version: "1.0.0",
    });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain("not found");
  });

  it("deployment with nonexistent environment returns clear error", async () => {
    const artId = await createArtifact(cmd.baseUrl, "invalid-env-svc");

    const res = await http(cmd.baseUrl, "POST", "/api/operations", {
      artifactId: artId,
      environmentId: "nonexistent-env",
      version: "1.0.0",
    });

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain("not found");
  });
});

// ===========================================================================
// 5. Envoy lifecycle — drain rejects new deployments
// ===========================================================================

describe("Envoy lifecycle gates", () => {
  let envoyApp: FastifyInstance;
  let envoyBaseUrl: string;
  let envoyTmpDir: string;

  beforeAll(async () => {
    envoyTmpDir = makeTmpDir();
    const envoyDiary = new DecisionDebrief();
    const envoyState = new LocalStateStore();
    const envoyAgent = new EnvoyAgent(envoyDiary, envoyState, envoyTmpDir);
    envoyApp = createEnvoyServer(envoyAgent, envoyState);
    await envoyApp.listen({ port: 0, host: "127.0.0.1" });
    envoyBaseUrl = `http://127.0.0.1:${getPort(envoyApp)}`;
  });

  afterAll(async () => {
    await envoyApp.close();
    removeTmpDir(envoyTmpDir);
  });

  it("draining Envoy rejects new deployments", async () => {
    const drainRes = await http(envoyBaseUrl, "POST", "/lifecycle/drain");
    expect(drainRes.status).toBe(200);

    const lifecycleRes = await http(envoyBaseUrl, "GET", "/lifecycle");
    expect(lifecycleRes.status).toBe(200);
    expect(lifecycleRes.body.state).toBe("draining");

    const deployRes = await http(envoyBaseUrl, "POST", "/deploy", {
      deploymentId: `drain-test-${Date.now()}`,
      partitionId: "part-1",
      environmentId: "env-1",
      operationId: "web-app",
      version: "1.0.0",
      variables: {},
      environmentName: "production",
      partitionName: "DrainCo",
    });

    expect(deployRes.status).toBeGreaterThanOrEqual(400);

    await http(envoyBaseUrl, "POST", "/lifecycle/resume");
  });

  it("paused Envoy rejects new deployments", async () => {
    const pauseRes = await http(envoyBaseUrl, "POST", "/lifecycle/pause");
    expect(pauseRes.status).toBe(200);

    const deployRes = await http(envoyBaseUrl, "POST", "/deploy", {
      deploymentId: `pause-test-${Date.now()}`,
      partitionId: "part-1",
      environmentId: "env-1",
      operationId: "web-app",
      version: "1.0.0",
      variables: {},
      environmentName: "production",
      partitionName: "PauseCo",
    });

    expect(deployRes.status).toBeGreaterThanOrEqual(400);

    await http(envoyBaseUrl, "POST", "/lifecycle/resume");
  });

  it("resumed Envoy accepts deployments again", async () => {
    const deployRes = await http(envoyBaseUrl, "POST", "/deploy", {
      deploymentId: `resume-test-${Date.now()}`,
      partitionId: "part-1",
      environmentId: "env-1",
      operationId: "web-app",
      version: "1.0.0",
      variables: {},
      environmentName: "production",
      partitionName: "ResumeCo",
    });

    expect(deployRes.status).toBe(200);
    expect(deployRes.body.success).toBe(true);
  });
});
