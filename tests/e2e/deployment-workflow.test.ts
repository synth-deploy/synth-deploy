import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// --- Core imports ---
import {
  DecisionDebrief,
  PartitionStore,
  OperationStore,
  EnvironmentStore,
  OrderStore,
  SettingsStore,
} from "@deploystack/core";

// --- Command imports ---
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

// --- Envoy imports ---
import { EnvoyAgent } from "@deploystack/envoy/agent/envoy-agent.js";
import { LocalStateStore } from "@deploystack/envoy/state/local-state.js";
import { createEnvoyServer } from "@deploystack/envoy/server.js";

// ==========================================================================
// Helpers
// ==========================================================================

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `deploystack-e2e-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "deployments"), { recursive: true });
  return dir;
}

function removeTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/** Extract the port from a listening Fastify instance. */
function getPort(app: FastifyInstance): number {
  const addr = app.server.address();
  if (addr && typeof addr === "object") {
    return addr.port;
  }
  throw new Error("Server not listening on a port");
}

/** HTTP helper using native fetch — returns parsed JSON and status. */
async function httpRequest(
  baseUrl: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, body: json as Record<string, unknown> };
}

/** Creates an Order then triggers a deployment via the Order-based flow. */
async function deployViaHttp(
  baseUrl: string,
  params: { operationId: string; partitionId: string; environmentId: string; version: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const orderRes = await httpRequest(baseUrl, "POST", "/api/orders", {
    operationId: params.operationId,
    partitionId: params.partitionId,
    environmentId: params.environmentId,
    version: params.version,
  });
  if (orderRes.status !== 201) {
    throw new Error(`Failed to create order: ${JSON.stringify(orderRes.body)}`);
  }
  const orderId = (orderRes.body.order as Record<string, unknown>).id as string;

  return httpRequest(baseUrl, "POST", "/api/deployments", {
    orderId,
    partitionId: params.partitionId,
    environmentId: params.environmentId,
    triggeredBy: "user",
  });
}

// ==========================================================================
// Helper: build a Command server with all routes registered
// ==========================================================================

interface CommandServerContext {
  app: FastifyInstance;
  baseUrl: string;
  diary: DecisionDebrief;
  partitions: PartitionStore;
  operations: OperationStore;
  environments: EnvironmentStore;
  deployments: InMemoryDeploymentStore;
  orders: OrderStore;
  settings: SettingsStore;
  agent: CommandAgent;
}

async function createCommandServer(): Promise<CommandServerContext> {
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
  });

  const app = Fastify({ logger: false });
  registerDeploymentRoutes(
    app,
    agent,
    partitions,
    environments,
    deployments,
    diary,
    operations,
    orders,
    settings,
  );
  registerOperationRoutes(app, operations, environments);
  registerPartitionRoutes(app, partitions, deployments, diary);
  registerEnvironmentRoutes(app, environments, operations);
  registerOrderRoutes(
    app,
    orders,
    agent,
    partitions,
    environments,
    operations,
    deployments,
    diary,
    settings,
  );
  registerSettingsRoutes(app, settings);
  registerEnvoyReportRoutes(app, diary);

  // Listen on port 0 — OS assigns a random available port
  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${getPort(app)}`;

  return {
    app,
    baseUrl,
    diary,
    partitions,
    operations,
    environments,
    deployments,
    orders,
    settings,
    agent,
  };
}

// ==========================================================================
// Scenario 1: Full deployment lifecycle via HTTP
// ==========================================================================

describe("E2E: Full deployment lifecycle via HTTP", () => {
  let ctx: CommandServerContext;

  beforeAll(async () => {
    ctx = await createCommandServer();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("creates entities via HTTP and triggers a deployment that persists in the store", async () => {
    // Step 1: Create an operation
    const opRes = await httpRequest(ctx.baseUrl, "POST", "/api/operations", {
      name: "web-app",
    });
    expect(opRes.status).toBe(201);
    const operationId = (opRes.body.operation as Record<string, unknown>)
      .id as string;

    // Step 2: Create a partition
    const partRes = await httpRequest(ctx.baseUrl, "POST", "/api/partitions", {
      name: "Acme Corp",
      variables: { REGION: "us-east-1", DB_HOST: "acme-db-1" },
    });
    expect(partRes.status).toBe(201);
    const partitionId = (partRes.body.partition as Record<string, unknown>)
      .id as string;

    // Step 3: Create an environment
    const envRes = await httpRequest(
      ctx.baseUrl,
      "POST",
      "/api/environments",
      {
        name: "production",
        variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
      },
    );
    expect(envRes.status).toBe(201);
    const environmentId = (envRes.body.environment as Record<string, unknown>)
      .id as string;

    // Link environment to operation
    const linkRes = await httpRequest(
      ctx.baseUrl,
      "POST",
      `/api/operations/${operationId}/environments`,
      { environmentId },
    );
    expect(linkRes.status).toBe(200);

    // Step 4: Create an order
    const orderRes = await httpRequest(ctx.baseUrl, "POST", "/api/orders", {
      operationId,
      partitionId,
      environmentId,
      version: "1.0.0",
    });
    expect(orderRes.status).toBe(201);
    const orderId = (orderRes.body.order as Record<string, unknown>)
      .id as string;

    // Verify order exists via HTTP GET
    const fetchedOrder = await httpRequest(
      ctx.baseUrl,
      "GET",
      `/api/orders/${orderId}`,
    );
    expect(fetchedOrder.status).toBe(200);
    const order = fetchedOrder.body.order as Record<string, unknown>;
    expect(order.operationId).toBe(operationId);
    expect(order.partitionId).toBe(partitionId);
    expect(order.environmentId).toBe(environmentId);
    expect(order.version).toBe("1.0.0");

    // Step 5: Trigger a deployment via HTTP (Order-based flow)
    const deployRes = await deployViaHttp(ctx.baseUrl, {
      operationId,
      partitionId,
      environmentId,
      version: "1.0.0",
    });
    expect(deployRes.status).toBe(201);

    const deployment = deployRes.body.deployment as Record<string, unknown>;
    const deploymentId = deployment.id as string;
    expect(deployment.status).toBe("succeeded");
    expect(deployment.operationId).toBe(operationId);
    expect(deployment.partitionId).toBe(partitionId);
    expect(deployment.environmentId).toBe(environmentId);

    // Verify variables were resolved (partition vars merged with env vars)
    const deployedVars = deployment.variables as Record<string, string>;
    expect(deployedVars.REGION).toBe("us-east-1");
    expect(deployedVars.DB_HOST).toBe("acme-db-1");
    expect(deployedVars.APP_ENV).toBe("production");
    expect(deployedVars.LOG_LEVEL).toBe("warn");

    // Step 6: Verify deployment persists via HTTP GET
    const fetchedDeploy = await httpRequest(
      ctx.baseUrl,
      "GET",
      `/api/deployments/${deploymentId}`,
    );
    expect(fetchedDeploy.status).toBe(200);
    const stored = fetchedDeploy.body.deployment as Record<string, unknown>;
    expect(stored.id).toBe(deploymentId);
    expect(stored.status).toBe("succeeded");
    expect(stored.operationId).toBe(operationId);
    expect(stored.partitionId).toBe(partitionId);

    // Verify debrief entries were created for the deployment
    const debrief = fetchedDeploy.body.debrief as Array<
      Record<string, unknown>
    >;
    expect(debrief.length).toBeGreaterThanOrEqual(3);

    // Every debrief entry must have non-empty decision and reasoning
    for (const entry of debrief) {
      expect(typeof entry.decision).toBe("string");
      expect((entry.decision as string).length).toBeGreaterThan(0);
      expect(typeof entry.reasoning).toBe("string");
      expect((entry.reasoning as string).length).toBeGreaterThan(0);
    }
  });

  it("lists deployments filtered by partition via HTTP", async () => {
    // Get partitions via HTTP
    const allParts = await httpRequest(ctx.baseUrl, "GET", "/api/partitions");
    const partList = allParts.body.partitions as Array<
      Record<string, unknown>
    >;
    expect(partList.length).toBeGreaterThan(0);

    const partitionId = partList[0].id as string;

    const filteredRes = await httpRequest(
      ctx.baseUrl,
      "GET",
      `/api/deployments?partitionId=${partitionId}`,
    );
    expect(filteredRes.status).toBe(200);
    const filteredDeps = filteredRes.body.deployments as Array<
      Record<string, unknown>
    >;
    for (const dep of filteredDeps) {
      expect(dep.partitionId).toBe(partitionId);
    }
  });

  it("returns debrief entries via the general debrief HTTP endpoint", async () => {
    const debriefRes = await httpRequest(
      ctx.baseUrl,
      "GET",
      "/api/debrief?limit=100",
    );
    expect(debriefRes.status).toBe(200);

    const entries = debriefRes.body.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);

    // All entries have non-empty decision and reasoning
    for (const entry of entries) {
      expect((entry.decision as string).length).toBeGreaterThan(0);
      expect((entry.reasoning as string).length).toBeGreaterThan(0);
    }
  });
});

// ==========================================================================
// Scenario 2: Envoy deployment via HTTP
// ==========================================================================

describe("E2E: Envoy deployment via HTTP", () => {
  let envoyTmpDir: string;
  let envoyApp: FastifyInstance;
  let envoyBaseUrl: string;

  beforeAll(async () => {
    envoyTmpDir = makeTmpDir();
    const envoyDebrief = new DecisionDebrief();
    const envoyState = new LocalStateStore();
    const envoyAgent = new EnvoyAgent(envoyDebrief, envoyState, envoyTmpDir);

    envoyApp = createEnvoyServer(envoyAgent, envoyState);

    // Listen on random port — real HTTP
    await envoyApp.listen({ port: 0, host: "127.0.0.1" });
    envoyBaseUrl = `http://127.0.0.1:${getPort(envoyApp)}`;
  });

  afterAll(async () => {
    await envoyApp.close();
    removeTmpDir(envoyTmpDir);
  });

  it("dispatches a deployment to the Envoy via HTTP and verifies workspace artifacts", async () => {
    const deploymentId = crypto.randomUUID();
    const partitionId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();

    const { status, body } = await httpRequest(
      envoyBaseUrl,
      "POST",
      "/deploy",
      {
        deploymentId,
        partitionId,
        environmentId,
        operationId: "web-app",
        version: "1.0.0",
        variables: { APP_ENV: "production", DB_HOST: "db.internal" },
        environmentName: "production",
        partitionName: "TestPartition",
      },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.deploymentId).toBe(deploymentId);
    expect(body.verificationPassed).toBe(true);

    // Verify workspace artifacts were created on disk
    const workspacePath = body.workspacePath as string;
    expect(fs.existsSync(workspacePath)).toBe(true);

    const artifacts = body.artifacts as string[];
    expect(artifacts).toContain("manifest.json");
    expect(artifacts).toContain("variables.env");
    expect(artifacts).toContain("VERSION");
    expect(artifacts).toContain("STATUS");

    // Verify file contents
    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspacePath, "manifest.json"), "utf-8"),
    );
    expect(manifest.deploymentId).toBe(deploymentId);
    expect(manifest.version).toBe("1.0.0");

    const version = fs.readFileSync(
      path.join(workspacePath, "VERSION"),
      "utf-8",
    );
    expect(version).toBe("web-app@1.0.0");

    const statusFile = fs.readFileSync(
      path.join(workspacePath, "STATUS"),
      "utf-8",
    );
    expect(statusFile).toBe("DEPLOYED");

    // Verify variables.env
    const vars = fs.readFileSync(
      path.join(workspacePath, "variables.env"),
      "utf-8",
    );
    expect(vars).toContain("APP_ENV=production");
    expect(vars).toContain("DB_HOST=db.internal");
  });

  it("returns debrief entries with the deployment result via HTTP", async () => {
    const deploymentId = crypto.randomUUID();

    const { body } = await httpRequest(envoyBaseUrl, "POST", "/deploy", {
      deploymentId,
      partitionId: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
      operationId: "api-service",
      version: "2.0.0",
      variables: { APP_ENV: "staging" },
      environmentName: "staging",
      partitionName: "GlobexPartition",
    });

    expect(body.success).toBe(true);

    // Envoy returns its reasoning as debrief entries
    const entries = body.debriefEntries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(3);

    for (const entry of entries) {
      expect(typeof entry.decision).toBe("string");
      expect((entry.decision as string).length).toBeGreaterThan(0);
      expect(typeof entry.reasoning).toBe("string");
      expect((entry.reasoning as string).length).toBeGreaterThan(0);
    }

    // Core pipeline decisions must be present
    const decisionTypes = entries.map((e) => e.decisionType);
    expect(decisionTypes).toContain("pipeline-plan");
    expect(decisionTypes).toContain("environment-scan");
    expect(decisionTypes).toContain("deployment-execution");
    expect(decisionTypes).toContain("deployment-verification");
    expect(decisionTypes).toContain("deployment-completion");
  });

  it("updates Envoy local state after deployment, visible via HTTP status endpoint", async () => {
    const deploymentId = crypto.randomUUID();
    const partitionId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();

    await httpRequest(envoyBaseUrl, "POST", "/deploy", {
      deploymentId,
      partitionId,
      environmentId,
      operationId: "worker",
      version: "3.0.0",
      variables: { WORKER_THREADS: "4" },
      environmentName: "production",
      partitionName: "AcmePartition",
    });

    // Query Envoy status via HTTP — should reflect the new deployment
    const { body: statusBody } = await httpRequest(
      envoyBaseUrl,
      "GET",
      "/status",
    );

    const recentDeployments = statusBody.recentDeployments as Array<
      Record<string, unknown>
    >;
    const found = recentDeployments.find(
      (d) => d.deploymentId === deploymentId,
    );
    expect(found).toBeDefined();
    expect(found!.status).toBe("succeeded");
    expect(found!.version).toBe("3.0.0");
  });

  it("serves a healthy health check via HTTP", async () => {
    const { status, body } = await httpRequest(
      envoyBaseUrl,
      "GET",
      "/health",
    );
    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.service).toBe("deploystack-envoy");
  });
});

// ==========================================================================
// Scenario 3: Partition isolation via HTTP
// ==========================================================================

describe("E2E: Partition isolation via HTTP", () => {
  let ctx: CommandServerContext;

  let partitionAId: string;
  let partitionBId: string;
  let operationId: string;
  let environmentId: string;

  beforeAll(async () => {
    ctx = await createCommandServer();

    // Create shared environment and operation
    const envRes = await httpRequest(
      ctx.baseUrl,
      "POST",
      "/api/environments",
      {
        name: "production",
        variables: { APP_ENV: "production" },
      },
    );
    environmentId = (envRes.body.environment as Record<string, unknown>)
      .id as string;

    const opRes = await httpRequest(ctx.baseUrl, "POST", "/api/operations", {
      name: "web-app",
      environmentIds: [environmentId],
    });
    operationId = (opRes.body.operation as Record<string, unknown>)
      .id as string;

    // Create two separate partitions
    const partARes = await httpRequest(
      ctx.baseUrl,
      "POST",
      "/api/partitions",
      {
        name: "Partition Alpha",
        variables: { TENANT: "alpha", DB_HOST: "alpha-db" },
      },
    );
    partitionAId = (partARes.body.partition as Record<string, unknown>)
      .id as string;

    const partBRes = await httpRequest(
      ctx.baseUrl,
      "POST",
      "/api/partitions",
      {
        name: "Partition Beta",
        variables: { TENANT: "beta", DB_HOST: "beta-db" },
      },
    );
    partitionBId = (partBRes.body.partition as Record<string, unknown>)
      .id as string;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("deploys to both partitions independently via HTTP", async () => {
    // Deploy to partition A
    const depARes = await deployViaHttp(ctx.baseUrl, {
      operationId,
      partitionId: partitionAId,
      environmentId,
      version: "1.0.0",
    });
    expect(depARes.status).toBe(201);
    expect(
      (depARes.body.deployment as Record<string, unknown>).status,
    ).toBe("succeeded");

    // Deploy to partition B
    const depBRes = await deployViaHttp(ctx.baseUrl, {
      operationId,
      partitionId: partitionBId,
      environmentId,
      version: "2.0.0",
    });
    expect(depBRes.status).toBe(201);
    expect(
      (depBRes.body.deployment as Record<string, unknown>).status,
    ).toBe("succeeded");
  });

  it("deployments for partition A are NOT visible when querying partition B via HTTP", async () => {
    const partADeps = await httpRequest(
      ctx.baseUrl,
      "GET",
      `/api/deployments?partitionId=${partitionAId}`,
    );
    const partBDeps = await httpRequest(
      ctx.baseUrl,
      "GET",
      `/api/deployments?partitionId=${partitionBId}`,
    );

    const aDeps = partADeps.body.deployments as Array<
      Record<string, unknown>
    >;
    const bDeps = partBDeps.body.deployments as Array<
      Record<string, unknown>
    >;

    // Each partition should have its own deployments
    expect(aDeps.length).toBeGreaterThan(0);
    expect(bDeps.length).toBeGreaterThan(0);

    // No partition A deployments should appear in B's list
    for (const dep of aDeps) {
      expect(dep.partitionId).toBe(partitionAId);
      expect(dep.partitionId).not.toBe(partitionBId);
    }

    // No partition B deployments should appear in A's list
    for (const dep of bDeps) {
      expect(dep.partitionId).toBe(partitionBId);
      expect(dep.partitionId).not.toBe(partitionAId);
    }

    // Verify the versions are partition-specific
    expect(aDeps.some((d) => d.version === "1.0.0")).toBe(true);
    expect(bDeps.some((d) => d.version === "2.0.0")).toBe(true);
    expect(aDeps.some((d) => d.version === "2.0.0")).toBe(false);
    expect(bDeps.some((d) => d.version === "1.0.0")).toBe(false);
  });

  it("debrief entries are scoped to the correct partition via HTTP", async () => {
    const partADebrief = await httpRequest(
      ctx.baseUrl,
      "GET",
      `/api/debrief?partitionId=${partitionAId}`,
    );
    const partBDebrief = await httpRequest(
      ctx.baseUrl,
      "GET",
      `/api/debrief?partitionId=${partitionBId}`,
    );

    const aEntries = partADebrief.body.entries as Array<
      Record<string, unknown>
    >;
    const bEntries = partBDebrief.body.entries as Array<
      Record<string, unknown>
    >;

    expect(aEntries.length).toBeGreaterThan(0);
    expect(bEntries.length).toBeGreaterThan(0);

    // All entries for partition A have partitionId = partitionAId
    for (const entry of aEntries) {
      expect(entry.partitionId).toBe(partitionAId);
    }

    // All entries for partition B have partitionId = partitionBId
    for (const entry of bEntries) {
      expect(entry.partitionId).toBe(partitionBId);
    }

    // No cross-partition leakage
    const aIds = new Set(aEntries.map((e) => e.id));
    const bIds = new Set(bEntries.map((e) => e.id));
    for (const id of aIds) {
      expect(bIds.has(id)).toBe(false);
    }
  });

  it("partition history is isolated per partition via HTTP", async () => {
    const historyA = await httpRequest(
      ctx.baseUrl,
      "GET",
      `/api/partitions/${partitionAId}/history`,
    );
    const historyB = await httpRequest(
      ctx.baseUrl,
      "GET",
      `/api/partitions/${partitionBId}/history`,
    );

    expect(historyA.status).toBe(200);
    expect(historyB.status).toBe(200);

    // Both should have history data
    expect(historyA.body.history).toBeDefined();
    expect(historyB.body.history).toBeDefined();
  });
});
