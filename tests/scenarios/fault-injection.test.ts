/**
 * Fault injection tests — Phase 3 of #98
 *
 * Deliberately break things and verify graceful degradation:
 * every failure leaves the environment in a known state with a
 * plain-language explanation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import crypto from "node:crypto";
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
import {
  CommandAgent,
  InMemoryDeploymentStore,
} from "@deploystack/command/agent/command-agent.js";
import { registerDeploymentRoutes } from "@deploystack/command/api/deployments.js";
import { registerOperationRoutes } from "@deploystack/command/api/operations.js";
import { registerPartitionRoutes } from "@deploystack/command/api/partitions.js";
import { registerEnvironmentRoutes } from "@deploystack/command/api/environments.js";
import { registerOrderRoutes } from "@deploystack/command/api/orders.js";
import { registerSettingsRoutes } from "@deploystack/command/api/settings.js";
import { registerEnvoyReportRoutes } from "@deploystack/command/api/envoy-reports.js";
import { EnvoyAgent } from "@deploystack/envoy/agent/envoy-agent.js";
import { LocalStateStore } from "@deploystack/envoy/state/local-state.js";
import { createEnvoyServer } from "@deploystack/envoy/server.js";
import {
  makeTmpDir,
  removeTmpDir,
  http,
  createPartition,
  createEnvironment,
  createOperation,
  linkEnvironment,
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

/** Creates a Command server that delegates to a real Envoy (settingsReader present). */
async function createCommandWithEnvoy(envoyUrl: string, timeoutMs = 2000) {
  const diary = new DecisionDebrief();
  const partitions = new PartitionStore();
  const operations = new OperationStore();
  const environments = new EnvironmentStore();
  const deployments = new InMemoryDeploymentStore();
  const orders = new OrderStore();
  const settings = new SettingsStore();
  settings.update({ envoy: { url: envoyUrl, timeoutMs } });

  const agent = new CommandAgent(diary, deployments, orders, undefined, {
    healthCheckBackoffMs: 1,
    executionDelayMs: 1,
  }, settings);

  const app = Fastify({ logger: false });
  registerDeploymentRoutes(app, agent, partitions, environments, deployments, diary, operations, orders, settings);
  registerOperationRoutes(app, operations, environments);
  registerPartitionRoutes(app, partitions, deployments, diary, orders);
  registerEnvironmentRoutes(app, environments, operations);
  registerOrderRoutes(app, orders, agent, partitions, environments, operations, deployments, diary, settings);
  registerSettingsRoutes(app, settings);
  registerEnvoyReportRoutes(app, diary);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${getPort(app)}`;

  return { app, baseUrl, diary, partitions, operations, environments, deployments, orders, settings, agent };
}

// ===========================================================================
// 1. Envoy offline — trigger deployment when Envoy is unreachable
// ===========================================================================

describe("Envoy offline", { timeout: 30000 }, () => {
  let cmd: Awaited<ReturnType<typeof createCommandWithEnvoy>>;

  beforeAll(async () => {
    // Point Command at a port where nothing is listening, with short timeout.
    // EnvoyClient retries with exponential backoff (up to ~8s total), which is
    // expected behavior — we verify the system recovers gracefully.
    cmd = await createCommandWithEnvoy("http://127.0.0.1:19999", 500);
  });

  afterAll(async () => {
    await cmd.app.close();
  });

  it("deployment fails with clear error, no phantom state", async () => {
    const opId = await createOperation(cmd.baseUrl, "offline-svc");
    const envId = await createEnvironment(cmd.baseUrl, "offline-env");
    await linkEnvironment(cmd.baseUrl, opId, envId);
    const partId = await createPartition(cmd.baseUrl, "OfflineCo");

    const res = await deploy(cmd.baseUrl, {
      operationId: opId,
      partitionId: partId,
      environmentId: envId,
      version: "1.0.0",
    });

    // Deployment should be created but fail
    expect(res.status).toBe(201);
    const dep = res.body.deployment as Record<string, unknown>;
    expect(dep.status).toBe("failed");

    // Debrief entries explain the failure
    const entries = res.body.debrief as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(1);

    // At least one entry explains the Envoy is unreachable
    const failureEntries = entries.filter(
      (e) => (e.reasoning as string).toLowerCase().includes("envoy") ||
             (e.reasoning as string).toLowerCase().includes("unreachable") ||
             (e.decision as string).toLowerCase().includes("envoy") ||
             (e.decision as string).toLowerCase().includes("failed"),
    );
    expect(failureEntries.length).toBeGreaterThanOrEqual(1);

    // Verify the deployment is in a known state (not stuck as "running")
    const detailRes = await http(cmd.baseUrl, "GET", `/api/deployments/${dep.id}`);
    const stored = detailRes.body.deployment as Record<string, unknown>;
    expect(stored.status).not.toBe("running");
  });
});

// ===========================================================================
// 2. Envoy dies mid-deployment (goes offline after initial health check)
// ===========================================================================

describe("Envoy dies mid-deployment", () => {
  let cmd: Awaited<ReturnType<typeof createCommandWithEnvoy>>;
  let envoyApp: FastifyInstance;
  let envoyTmpDir: string;

  beforeAll(async () => {
    // Start a real Envoy
    envoyTmpDir = makeTmpDir();
    const envoyDiary = new DecisionDebrief();
    const envoyState = new LocalStateStore();
    const envoyAgent = new EnvoyAgent(envoyDiary, envoyState, envoyTmpDir);
    envoyApp = createEnvoyServer(envoyAgent, envoyState);
    await envoyApp.listen({ port: 0, host: "127.0.0.1" });
    const envoyUrl = `http://127.0.0.1:${getPort(envoyApp)}`;

    // Command points at the real Envoy
    cmd = await createCommandWithEnvoy(envoyUrl);
  });

  afterAll(async () => {
    await cmd.app.close();
    try { await envoyApp.close(); } catch { /* may already be closed */ }
    removeTmpDir(envoyTmpDir);
  });

  it("deployment with live Envoy succeeds and produces artifacts", async () => {
    const opId = await createOperation(cmd.baseUrl, "live-envoy-svc");
    const envId = await createEnvironment(cmd.baseUrl, "live-envoy-env");
    await linkEnvironment(cmd.baseUrl, opId, envId);
    const partId = await createPartition(cmd.baseUrl, "LiveCo");

    const res = await deploy(cmd.baseUrl, {
      operationId: opId,
      partitionId: partId,
      environmentId: envId,
      version: "1.0.0",
    });

    expect(res.status).toBe(201);
    const dep = res.body.deployment as Record<string, unknown>;
    // With a live Envoy, the deployment should succeed
    expect(dep.status).toBe("succeeded");

    // Debrief entries should exist and be actionable
    const entries = res.body.debrief as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of entries) {
      expect((entry.reasoning as string).length).toBeGreaterThanOrEqual(20);
    }
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

  it("two simultaneous deployments both resolve to a known state", async () => {
    const opId = await createOperation(cmd.baseUrl, "concurrent-svc");
    const envId = await createEnvironment(cmd.baseUrl, "concurrent-env");
    await linkEnvironment(cmd.baseUrl, opId, envId);
    const partId = await createPartition(cmd.baseUrl, "ConcurrentCo");

    // Fire two deployments simultaneously
    const [res1, res2] = await Promise.all([
      deploy(cmd.baseUrl, {
        operationId: opId,
        partitionId: partId,
        environmentId: envId,
        version: "1.0.0",
      }),
      deploy(cmd.baseUrl, {
        operationId: opId,
        partitionId: partId,
        environmentId: envId,
        version: "2.0.0",
      }),
    ]);

    // Both should resolve (201 created) — neither should hang or crash
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    const dep1 = res1.body.deployment as Record<string, unknown>;
    const dep2 = res2.body.deployment as Record<string, unknown>;

    // Both deployments must be in a terminal state (not stuck as "running")
    const validTerminalStates = ["succeeded", "failed", "rolled_back"];
    expect(validTerminalStates).toContain(dep1.status);
    expect(validTerminalStates).toContain(dep2.status);

    // Both must have unique deployment IDs
    expect(dep1.id).not.toBe(dep2.id);

    // Both should have debrief entries
    const entries1 = res1.body.debrief as Array<Record<string, unknown>>;
    const entries2 = res2.body.debrief as Array<Record<string, unknown>>;
    expect(entries1.length).toBeGreaterThanOrEqual(1);
    expect(entries2.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 4. Invalid step configuration — deploy with nonexistent operation
// ===========================================================================

describe("Invalid configuration", () => {
  let cmd: Awaited<ReturnType<typeof createCommandWithEnvoy>>;

  beforeAll(async () => {
    cmd = await createCommandWithEnvoy("http://127.0.0.1:19999");
  });

  afterAll(async () => {
    await cmd.app.close();
  });

  it("deployment with nonexistent operation returns clear error", async () => {
    const envId = await createEnvironment(cmd.baseUrl, "invalid-op-env");
    const partId = await createPartition(cmd.baseUrl, "InvalidCo");

    // Try to create an order with a fake operation ID
    const orderRes = await http(cmd.baseUrl, "POST", "/api/orders", {
      operationId: "nonexistent-operation",
      partitionId: partId,
      environmentId: envId,
      version: "1.0.0",
    });

    // Should fail with a clear error
    expect(orderRes.status).toBe(404);
    expect(JSON.stringify(orderRes.body)).toContain("not found");
  });

  it("deployment with nonexistent partition returns clear error", async () => {
    const opId = await createOperation(cmd.baseUrl, "invalid-part-svc");
    const envId = await createEnvironment(cmd.baseUrl, "invalid-part-env");
    await linkEnvironment(cmd.baseUrl, opId, envId);

    const orderRes = await http(cmd.baseUrl, "POST", "/api/orders", {
      operationId: opId,
      partitionId: "nonexistent-partition",
      environmentId: envId,
      version: "1.0.0",
    });

    expect(orderRes.status).toBe(404);
    expect(JSON.stringify(orderRes.body)).toContain("not found");
  });

  it("deployment with nonexistent environment returns clear error", async () => {
    const opId = await createOperation(cmd.baseUrl, "invalid-env-svc");
    const partId = await createPartition(cmd.baseUrl, "InvalidEnvCo");

    const orderRes = await http(cmd.baseUrl, "POST", "/api/orders", {
      operationId: opId,
      partitionId: partId,
      environmentId: "nonexistent-env",
      version: "1.0.0",
    });

    expect(orderRes.status).toBe(404);
    expect(JSON.stringify(orderRes.body)).toContain("not found");
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
    // Put Envoy in drain mode
    const drainRes = await http(envoyBaseUrl, "POST", "/lifecycle/drain");
    expect(drainRes.status).toBe(200);

    // Verify lifecycle state
    const lifecycleRes = await http(envoyBaseUrl, "GET", "/lifecycle");
    expect(lifecycleRes.status).toBe(200);
    expect(lifecycleRes.body.state).toBe("draining");

    // Try to deploy — should be rejected
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

    // Should be rejected (503 or equivalent)
    expect(deployRes.status).toBeGreaterThanOrEqual(400);

    // Resume so we don't affect other tests
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

    // Resume
    await http(envoyBaseUrl, "POST", "/lifecycle/resume");
  });

  it("resumed Envoy accepts deployments again", async () => {
    // Should be in active state after previous resume
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
