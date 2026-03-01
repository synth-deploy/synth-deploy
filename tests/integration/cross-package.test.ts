import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import type { DebriefEntry, Deployment } from "@deploystack/core";

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
  const dir = path.join(os.tmpdir(), `deploystack-integration-${crypto.randomUUID()}`);
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

/** Inject helper that returns the parsed JSON body. */
async function inject(
  app: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload } : {}),
  });
  return {
    status: res.statusCode,
    body: JSON.parse(res.payload) as Record<string, unknown>,
  };
}

// ==========================================================================
// Scenario 1: Command -> Envoy dispatch and report-back cycle
// ==========================================================================

describe("Command -> Envoy dispatch and report-back cycle", () => {
  let envoyTmpDir: string;
  let envoyApp: FastifyInstance;
  let envoyState: LocalStateStore;
  let envoyDebrief: DecisionDebrief;
  let envoyAgent: EnvoyAgent;

  beforeAll(async () => {
    envoyTmpDir = makeTmpDir();
    envoyDebrief = new DecisionDebrief();
    envoyState = new LocalStateStore();
    envoyAgent = new EnvoyAgent(envoyDebrief, envoyState, envoyTmpDir);

    envoyApp = createEnvoyServer(envoyAgent, envoyState);
    await envoyApp.ready();
  });

  afterAll(async () => {
    await envoyApp.close();
    removeTmpDir(envoyTmpDir);
  });

  it("dispatches a deployment to the Envoy and receives workspace artifacts", async () => {
    const deploymentId = crypto.randomUUID();
    const partitionId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();

    // Dispatch deployment instruction to Envoy via HTTP
    const { status, body } = await inject(envoyApp, "POST", "/deploy", {
      deploymentId,
      partitionId,
      environmentId,
      operationId: "web-app",
      version: "1.0.0",
      variables: { APP_ENV: "production", DB_HOST: "db.internal" },
      environmentName: "production",
      partitionName: "TestPartition",
    });

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

  it("returns debrief entries with the deployment result", async () => {
    const deploymentId = crypto.randomUUID();

    const { body } = await inject(envoyApp, "POST", "/deploy", {
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

    // All entries should have non-empty decisions and reasoning
    for (const entry of entries) {
      expect(typeof entry.decision).toBe("string");
      expect((entry.decision as string).length).toBeGreaterThan(0);
      expect(typeof entry.reasoning).toBe("string");
      expect((entry.reasoning as string).length).toBeGreaterThan(0);
    }

    // Pipeline plan, environment scan, execution, verification, and completion
    // should all be present
    const decisionTypes = entries.map((e) => e.decisionType);
    expect(decisionTypes).toContain("pipeline-plan");
    expect(decisionTypes).toContain("environment-scan");
    expect(decisionTypes).toContain("deployment-execution");
    expect(decisionTypes).toContain("deployment-verification");
    expect(decisionTypes).toContain("deployment-completion");
  });

  it("updates Envoy local state after deployment", async () => {
    const deploymentId = crypto.randomUUID();
    const partitionId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();

    await inject(envoyApp, "POST", "/deploy", {
      deploymentId,
      partitionId,
      environmentId,
      operationId: "worker",
      version: "3.0.0",
      variables: { WORKER_THREADS: "4" },
      environmentName: "production",
      partitionName: "AcmePartition",
    });

    // Query Envoy status — should reflect the new deployment
    const { body: statusBody } = await inject(envoyApp, "GET", "/status");

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
});

// ==========================================================================
// Scenario 2: REST API -> CommandAgent -> store persistence roundtrip
// ==========================================================================

describe("REST API -> CommandAgent -> store persistence roundtrip", () => {
  let commandApp: FastifyInstance;
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
    agent = new CommandAgent(diary, deployments, orders, undefined, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });

    commandApp = Fastify({ logger: false });
    registerDeploymentRoutes(
      commandApp,
      agent,
      partitions,
      environments,
      deployments,
      diary,
      operations,
      orders,
      settings,
    );
    registerOperationRoutes(commandApp, operations, environments);
    registerPartitionRoutes(commandApp, partitions, deployments, diary);
    registerEnvironmentRoutes(commandApp, environments, operations);
    registerOrderRoutes(
      commandApp,
      orders,
      agent,
      partitions,
      environments,
      operations,
      deployments,
      diary,
      settings,
    );
    registerSettingsRoutes(commandApp, settings);
    registerEnvoyReportRoutes(commandApp, diary);

    await commandApp.ready();
  });

  afterAll(async () => {
    await commandApp.close();
  });

  it("creates entities via API and triggers a deployment that persists in the store", async () => {
    // Step 1: Create an operation
    const opRes = await inject(commandApp, "POST", "/api/operations", {
      name: "web-app",
    });
    expect(opRes.status).toBe(201);
    const operationId = (opRes.body.operation as Record<string, unknown>)
      .id as string;

    // Step 2: Create a partition
    const partRes = await inject(commandApp, "POST", "/api/partitions", {
      name: "Acme Corp",
      variables: { REGION: "us-east-1", DB_HOST: "acme-db-1" },
    });
    expect(partRes.status).toBe(201);
    const partitionId = (partRes.body.partition as Record<string, unknown>)
      .id as string;

    // Step 3: Create an environment
    const envRes = await inject(commandApp, "POST", "/api/environments", {
      name: "production",
      variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    });
    expect(envRes.status).toBe(201);
    const environmentId = (envRes.body.environment as Record<string, unknown>)
      .id as string;

    // Link environment to operation
    await inject(
      commandApp,
      "POST",
      `/api/operations/${operationId}/environments`,
      { environmentId },
    );

    // Step 4: Create an order
    const orderRes = await inject(commandApp, "POST", "/api/orders", {
      operationId,
      partitionId,
      environmentId,
      version: "1.0.0",
    });
    expect(orderRes.status).toBe(201);
    const orderId = (orderRes.body.order as Record<string, unknown>)
      .id as string;

    // Verify order exists in the store
    const fetchedOrder = await inject(
      commandApp,
      "GET",
      `/api/orders/${orderId}`,
    );
    expect(fetchedOrder.status).toBe(200);
    const order = fetchedOrder.body.order as Record<string, unknown>;
    expect(order.operationId).toBe(operationId);
    expect(order.partitionId).toBe(partitionId);
    expect(order.environmentId).toBe(environmentId);
    expect(order.version).toBe("1.0.0");

    // Step 5: Trigger a deployment via an Order
    const deployOrderRes = await inject(commandApp, "POST", "/api/orders", {
      operationId,
      partitionId,
      environmentId,
      version: "1.0.0",
    });
    expect(deployOrderRes.status).toBe(201);
    const deployOrderId = (deployOrderRes.body.order as Record<string, unknown>)
      .id as string;

    const deployRes = await inject(commandApp, "POST", "/api/deployments", {
      orderId: deployOrderId,
      partitionId,
      environmentId,
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

    // Step 6: Verify deployment persists in the store
    const fetchedDeploy = await inject(
      commandApp,
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
  });

  it("lists deployments filtered by partition", async () => {
    // Use the partition created in the previous test
    const allParts = await inject(commandApp, "GET", "/api/partitions");
    const partList = allParts.body.partitions as Array<
      Record<string, unknown>
    >;
    expect(partList.length).toBeGreaterThan(0);

    const partitionId = partList[0].id as string;

    const filteredRes = await inject(
      commandApp,
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
});

// ==========================================================================
// Scenario 3: Partition isolation end-to-end
// ==========================================================================

describe("Partition isolation end-to-end", () => {
  let commandApp: FastifyInstance;
  let diary: DecisionDebrief;
  let partitions: PartitionStore;
  let operations: OperationStore;
  let environments: EnvironmentStore;
  let deployments: InMemoryDeploymentStore;
  let orders: OrderStore;
  let settings: SettingsStore;
  let agent: CommandAgent;

  // IDs set during setup
  let partitionAId: string;
  let partitionBId: string;
  let operationId: string;
  let environmentId: string;

  beforeAll(async () => {
    diary = new DecisionDebrief();
    partitions = new PartitionStore();
    operations = new OperationStore();
    environments = new EnvironmentStore();
    deployments = new InMemoryDeploymentStore();
    orders = new OrderStore();
    settings = new SettingsStore();
    agent = new CommandAgent(diary, deployments, orders, undefined, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });

    commandApp = Fastify({ logger: false });
    registerDeploymentRoutes(
      commandApp,
      agent,
      partitions,
      environments,
      deployments,
      diary,
      operations,
      orders,
      settings,
    );
    registerOperationRoutes(commandApp, operations, environments);
    registerPartitionRoutes(commandApp, partitions, deployments, diary);
    registerEnvironmentRoutes(commandApp, environments, operations);
    registerOrderRoutes(
      commandApp,
      orders,
      agent,
      partitions,
      environments,
      operations,
      deployments,
      diary,
      settings,
    );
    registerSettingsRoutes(commandApp, settings);

    await commandApp.ready();

    // Create shared environment and operation
    const envRes = await inject(commandApp, "POST", "/api/environments", {
      name: "production",
      variables: { APP_ENV: "production" },
    });
    environmentId = (envRes.body.environment as Record<string, unknown>)
      .id as string;

    const opRes = await inject(commandApp, "POST", "/api/operations", {
      name: "web-app",
      environmentIds: [environmentId],
    });
    operationId = (opRes.body.operation as Record<string, unknown>)
      .id as string;

    // Create two separate partitions
    const partARes = await inject(commandApp, "POST", "/api/partitions", {
      name: "Partition Alpha",
      variables: { TENANT: "alpha", DB_HOST: "alpha-db" },
    });
    partitionAId = (partARes.body.partition as Record<string, unknown>)
      .id as string;

    const partBRes = await inject(commandApp, "POST", "/api/partitions", {
      name: "Partition Beta",
      variables: { TENANT: "beta", DB_HOST: "beta-db" },
    });
    partitionBId = (partBRes.body.partition as Record<string, unknown>)
      .id as string;
  });

  afterAll(async () => {
    await commandApp.close();
  });

  it("deploys to both partitions independently", async () => {
    // Create Order for partition A
    const orderARes = await inject(commandApp, "POST", "/api/orders", {
      operationId,
      partitionId: partitionAId,
      environmentId,
      version: "1.0.0",
    });
    expect(orderARes.status).toBe(201);
    const orderAId = (orderARes.body.order as Record<string, unknown>)
      .id as string;

    // Deploy to partition A
    const depARes = await inject(commandApp, "POST", "/api/deployments", {
      orderId: orderAId,
      partitionId: partitionAId,
      environmentId,
    });
    expect(depARes.status).toBe(201);
    expect(
      (depARes.body.deployment as Record<string, unknown>).status,
    ).toBe("succeeded");

    // Create Order for partition B
    const orderBRes = await inject(commandApp, "POST", "/api/orders", {
      operationId,
      partitionId: partitionBId,
      environmentId,
      version: "2.0.0",
    });
    expect(orderBRes.status).toBe(201);
    const orderBId = (orderBRes.body.order as Record<string, unknown>)
      .id as string;

    // Deploy to partition B
    const depBRes = await inject(commandApp, "POST", "/api/deployments", {
      orderId: orderBId,
      partitionId: partitionBId,
      environmentId,
    });
    expect(depBRes.status).toBe(201);
    expect(
      (depBRes.body.deployment as Record<string, unknown>).status,
    ).toBe("succeeded");
  });

  it("deployments for partition A are NOT visible when querying partition B", async () => {
    const partADeps = await inject(
      commandApp,
      "GET",
      `/api/deployments?partitionId=${partitionAId}`,
    );
    const partBDeps = await inject(
      commandApp,
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

  it("debrief entries are scoped to the correct partition", async () => {
    // Query debrief entries for partition A
    const partADebrief = await inject(
      commandApp,
      "GET",
      `/api/debrief?partitionId=${partitionAId}`,
    );
    const partBDebrief = await inject(
      commandApp,
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

  it("partition history is isolated per partition", async () => {
    const historyA = await inject(
      commandApp,
      "GET",
      `/api/partitions/${partitionAId}/history`,
    );
    const historyB = await inject(
      commandApp,
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

// ==========================================================================
// Scenario 4: Decision Diary completeness for multi-step workflow
// ==========================================================================

describe("Decision Diary completeness for multi-step workflow", () => {
  let commandApp: FastifyInstance;
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
    agent = new CommandAgent(diary, deployments, orders, undefined, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });

    commandApp = Fastify({ logger: false });
    registerDeploymentRoutes(
      commandApp,
      agent,
      partitions,
      environments,
      deployments,
      diary,
      operations,
      orders,
      settings,
    );
    registerOperationRoutes(commandApp, operations, environments);
    registerPartitionRoutes(commandApp, partitions, deployments, diary);
    registerEnvironmentRoutes(commandApp, environments, operations);
    registerOrderRoutes(
      commandApp,
      orders,
      agent,
      partitions,
      environments,
      operations,
      deployments,
      diary,
      settings,
    );
    registerSettingsRoutes(commandApp, settings);

    await commandApp.ready();
  });

  afterAll(async () => {
    await commandApp.close();
  });

  it("records all expected decision types during a full deployment workflow", async () => {
    // Set up: environment, operation, partition
    const envRes = await inject(commandApp, "POST", "/api/environments", {
      name: "production",
      variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    });
    const environmentId = (envRes.body.environment as Record<string, unknown>)
      .id as string;

    const opRes = await inject(commandApp, "POST", "/api/operations", {
      name: "web-app",
      environmentIds: [environmentId],
    });
    const operationId = (opRes.body.operation as Record<string, unknown>)
      .id as string;

    const partRes = await inject(commandApp, "POST", "/api/partitions", {
      name: "Acme Corp",
      variables: { DB_HOST: "acme-db-1", REGION: "us-east-1" },
    });
    const partitionId = (partRes.body.partition as Record<string, unknown>)
      .id as string;

    // Create Order and trigger deployment
    const orderRes2 = await inject(commandApp, "POST", "/api/orders", {
      operationId,
      partitionId,
      environmentId,
      version: "2.0.0",
    });
    expect(orderRes2.status).toBe(201);
    const orderId2 = (orderRes2.body.order as Record<string, unknown>)
      .id as string;

    const deployRes = await inject(commandApp, "POST", "/api/deployments", {
      orderId: orderId2,
      partitionId,
      environmentId,
    });
    expect(deployRes.status).toBe(201);
    const deploymentId = (
      deployRes.body.deployment as Record<string, unknown>
    ).id as string;

    // Read debrief entries for this deployment
    const debriefRes = await inject(
      commandApp,
      "GET",
      `/api/deployments/${deploymentId}`,
    );
    expect(debriefRes.status).toBe(200);

    const entries = debriefRes.body.debrief as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(3);

    // Extract decision types present
    const decisionTypes = new Set(
      entries.map((e) => e.decisionType as string),
    );

    // Core pipeline decisions must be present
    expect(decisionTypes.has("pipeline-plan")).toBe(true);
    expect(decisionTypes.has("configuration-resolved")).toBe(true);

    // Every entry must have actionable reasoning — not empty
    for (const entry of entries) {
      const decision = entry.decision as string;
      const reasoning = entry.reasoning as string;

      expect(decision.length).toBeGreaterThan(0);
      expect(reasoning.length).toBeGreaterThan(0);

      // Reasoning should be specific enough to act on (at least 20 chars)
      expect(reasoning.length).toBeGreaterThanOrEqual(20);
    }

    // Every entry must have proper agent attribution
    for (const entry of entries) {
      expect(["command", "envoy"]).toContain(entry.agent);
    }

    // Every entry must be associated with the correct partition
    for (const entry of entries) {
      expect(entry.partitionId).toBe(partitionId);
    }

    // Every entry for this deployment must reference it
    for (const entry of entries) {
      expect(entry.deploymentId).toBe(deploymentId);
    }
  });

  it("records decision types from a variable-conflict deployment", async () => {
    // Create environment with overlapping variable
    const envRes = await inject(commandApp, "POST", "/api/environments", {
      name: "staging",
      variables: { APP_ENV: "staging", LOG_LEVEL: "debug" },
    });
    const environmentId = (envRes.body.environment as Record<string, unknown>)
      .id as string;

    // Create operation linked to the new environment
    const opRes = await inject(commandApp, "POST", "/api/operations", {
      name: "api-service",
      environmentIds: [environmentId],
    });
    const operationId = (opRes.body.operation as Record<string, unknown>)
      .id as string;

    // Partition with a variable that conflicts with the environment
    const partRes = await inject(commandApp, "POST", "/api/partitions", {
      name: "Globex Industries",
      variables: { APP_ENV: "production", LOG_LEVEL: "error" },
    });
    const partitionId = (partRes.body.partition as Record<string, unknown>)
      .id as string;

    // Create Order and trigger deployment — expect it to succeed but with conflict decisions
    const conflictOrderRes = await inject(commandApp, "POST", "/api/orders", {
      operationId,
      partitionId,
      environmentId,
      version: "3.0.0",
    });
    expect(conflictOrderRes.status).toBe(201);
    const conflictOrderId = (conflictOrderRes.body.order as Record<string, unknown>)
      .id as string;

    const deployRes = await inject(commandApp, "POST", "/api/deployments", {
      orderId: conflictOrderId,
      partitionId,
      environmentId,
    });
    expect(deployRes.status).toBe(201);
    const deploymentId = (
      deployRes.body.deployment as Record<string, unknown>
    ).id as string;

    // Read debrief
    const debriefRes = await inject(
      commandApp,
      "GET",
      `/api/deployments/${deploymentId}`,
    );
    const entries = debriefRes.body.debrief as Array<Record<string, unknown>>;

    // Should include variable-related reasoning
    const decisionTypes = new Set(
      entries.map((e) => e.decisionType as string),
    );
    expect(decisionTypes.has("pipeline-plan")).toBe(true);
    expect(decisionTypes.has("configuration-resolved")).toBe(true);

    // Verify completeness: no entry has empty decision or reasoning
    for (const entry of entries) {
      expect((entry.decision as string).length).toBeGreaterThan(0);
      expect((entry.reasoning as string).length).toBeGreaterThan(0);
    }
  });

  it("records system-level entries visible via the general debrief endpoint", async () => {
    // Query all recent debrief entries (no partition filter)
    const debriefRes = await inject(commandApp, "GET", "/api/debrief?limit=100");
    expect(debriefRes.status).toBe(200);

    const entries = debriefRes.body.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);

    // Verify all entries have non-empty decision and reasoning
    for (const entry of entries) {
      expect((entry.decision as string).length).toBeGreaterThan(0);
      expect((entry.reasoning as string).length).toBeGreaterThan(0);
    }

    // Debrief should contain entries from multiple deployments
    const uniqueDeploymentIds = new Set(
      entries.filter((e) => e.deploymentId !== null).map((e) => e.deploymentId),
    );
    expect(uniqueDeploymentIds.size).toBeGreaterThanOrEqual(2);
  });
});
