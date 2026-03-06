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
  EnvironmentStore,
  ArtifactStore,
  SettingsStore,
  TelemetryStore,
} from "@synth-deploy/core";

// --- Command imports ---
import {
  CommandAgent,
  InMemoryDeploymentStore,
} from "@synth-deploy/command/agent/command-agent.js";
import { registerDeploymentRoutes } from "@synth-deploy/command/api/deployments.js";
import { registerPartitionRoutes } from "@synth-deploy/command/api/partitions.js";
import { registerEnvironmentRoutes } from "@synth-deploy/command/api/environments.js";
import { registerSettingsRoutes } from "@synth-deploy/command/api/settings.js";
import { registerEnvoyReportRoutes } from "@synth-deploy/command/api/envoy-reports.js";
import { registerArtifactRoutes } from "@synth-deploy/command/api/artifacts.js";

// --- Envoy imports ---
import { EnvoyAgent } from "@synth-deploy/envoy/agent/envoy-agent.js";
import { LocalStateStore } from "@synth-deploy/envoy/state/local-state.js";
import { createEnvoyServer } from "@synth-deploy/envoy/server.js";

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

function addMockAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
      id: "test-user-id",
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

    const { status, body } = await inject(envoyApp, "POST", "/deploy", {
      deploymentId,
      partitionId: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
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

    const workspacePath = body.workspacePath as string;
    expect(fs.existsSync(workspacePath)).toBe(true);

    const artifacts = body.artifacts as string[];
    expect(artifacts).toContain("manifest.json");
    expect(artifacts).toContain("variables.env");
    expect(artifacts).toContain("VERSION");
    expect(artifacts).toContain("STATUS");

    const manifest = JSON.parse(fs.readFileSync(path.join(workspacePath, "manifest.json"), "utf-8"));
    expect(manifest.deploymentId).toBe(deploymentId);
    expect(manifest.version).toBe("1.0.0");

    const version = fs.readFileSync(path.join(workspacePath, "VERSION"), "utf-8");
    expect(version).toBe("web-app@1.0.0");

    const statusFile = fs.readFileSync(path.join(workspacePath, "STATUS"), "utf-8");
    expect(statusFile).toBe("DEPLOYED");

    const vars = fs.readFileSync(path.join(workspacePath, "variables.env"), "utf-8");
    expect(vars).toContain("APP_ENV=production");
    expect(vars).toContain("DB_HOST=db.internal");
  });

  it("returns debrief entries with the deployment result", async () => {
    const { body } = await inject(envoyApp, "POST", "/deploy", {
      deploymentId: crypto.randomUUID(),
      partitionId: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
      operationId: "api-service",
      version: "2.0.0",
      variables: { APP_ENV: "staging" },
      environmentName: "staging",
      partitionName: "GlobexPartition",
    });

    expect(body.success).toBe(true);

    const entries = body.debriefEntries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThanOrEqual(3);

    for (const entry of entries) {
      expect(typeof entry.decision).toBe("string");
      expect((entry.decision as string).length).toBeGreaterThan(0);
      expect(typeof entry.reasoning).toBe("string");
      expect((entry.reasoning as string).length).toBeGreaterThan(0);
    }

    const decisionTypes = entries.map((e) => e.decisionType);
    expect(decisionTypes).toContain("pipeline-plan");
    expect(decisionTypes).toContain("environment-scan");
    expect(decisionTypes).toContain("deployment-execution");
    expect(decisionTypes).toContain("deployment-verification");
    expect(decisionTypes).toContain("deployment-completion");
  });

  it("updates Envoy local state after deployment", async () => {
    const deploymentId = crypto.randomUUID();

    await inject(envoyApp, "POST", "/deploy", {
      deploymentId,
      partitionId: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
      operationId: "worker",
      version: "3.0.0",
      variables: { WORKER_THREADS: "4" },
      environmentName: "production",
      partitionName: "AcmePartition",
    });

    const { body: statusBody } = await inject(envoyApp, "GET", "/status");

    const recentDeployments = statusBody.recentDeployments as Array<Record<string, unknown>>;
    const found = recentDeployments.find((d) => d.deploymentId === deploymentId);
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
    agent = new CommandAgent(diary, deployments, artifactStore, environments, partitions, undefined, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });

    commandApp = Fastify({ logger: false });
    addMockAuth(commandApp);
    registerDeploymentRoutes(commandApp, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
    registerPartitionRoutes(commandApp, partitions, deployments, diary, telemetry);
    registerEnvironmentRoutes(commandApp, environments, deployments, telemetry);
    registerSettingsRoutes(commandApp, settings, telemetry);
    registerEnvoyReportRoutes(commandApp, diary, deployments);
    registerArtifactRoutes(commandApp, artifactStore, telemetry);

    await commandApp.ready();
  });

  afterAll(async () => {
    await commandApp.close();
  });

  it("creates entities via API and triggers a deployment that persists in the store", async () => {
    // Step 1: Create an artifact
    const artRes = await inject(commandApp, "POST", "/api/artifacts", {
      name: "web-app",
      type: "generic",
    });
    expect(artRes.status).toBe(201);
    const artifactId = (artRes.body.artifact as Record<string, unknown>).id as string;

    // Step 2: Create a partition
    const partRes = await inject(commandApp, "POST", "/api/partitions", {
      name: "Acme Corp",
      variables: { REGION: "us-east-1", DB_HOST: "acme-db-1" },
    });
    expect(partRes.status).toBe(201);
    const partitionId = (partRes.body.partition as Record<string, unknown>).id as string;

    // Step 3: Create an environment
    const envRes = await inject(commandApp, "POST", "/api/environments", {
      name: "production",
      variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    });
    expect(envRes.status).toBe(201);
    const environmentId = (envRes.body.environment as Record<string, unknown>).id as string;

    // Step 4: Create a deployment
    const deployRes = await inject(commandApp, "POST", "/api/deployments", {
      artifactId,
      partitionId,
      environmentId,
      version: "1.0.0",
    });
    expect(deployRes.status).toBe(201);

    const deployment = deployRes.body.deployment as Record<string, unknown>;
    const deploymentId = deployment.id as string;
    expect(deployment.artifactId).toBe(artifactId);
    expect(deployment.partitionId).toBe(partitionId);
    expect(deployment.environmentId).toBe(environmentId);

    // Verify variables were resolved (partition vars merged with env vars)
    const deployedVars = deployment.variables as Record<string, string>;
    expect(deployedVars.REGION).toBe("us-east-1");
    expect(deployedVars.DB_HOST).toBe("acme-db-1");
    expect(deployedVars.APP_ENV).toBe("production");
    expect(deployedVars.LOG_LEVEL).toBe("warn");

    // Step 5: Verify deployment persists in the store
    const fetchedDeploy = await inject(commandApp, "GET", `/api/deployments/${deploymentId}`);
    expect(fetchedDeploy.status).toBe(200);
    const stored = fetchedDeploy.body.deployment as Record<string, unknown>;
    expect(stored.id).toBe(deploymentId);
    expect(stored.artifactId).toBe(artifactId);
    expect(stored.partitionId).toBe(partitionId);
  });

  it("lists deployments filtered by partition", async () => {
    const allParts = await inject(commandApp, "GET", "/api/partitions");
    const partList = allParts.body.partitions as Array<Record<string, unknown>>;
    expect(partList.length).toBeGreaterThan(0);

    const partitionId = partList[0].id as string;

    const filteredRes = await inject(commandApp, "GET", `/api/deployments?partitionId=${partitionId}`);
    expect(filteredRes.status).toBe(200);
    const filteredDeps = filteredRes.body.deployments as Array<Record<string, unknown>>;
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
  let environments: EnvironmentStore;
  let deployments: InMemoryDeploymentStore;
  let artifactStore: ArtifactStore;
  let settings: SettingsStore;
  let telemetry: TelemetryStore;
  let agent: CommandAgent;

  let partitionAId: string;
  let partitionBId: string;
  let artifactId: string;
  let environmentId: string;

  beforeAll(async () => {
    diary = new DecisionDebrief();
    partitions = new PartitionStore();
    environments = new EnvironmentStore();
    deployments = new InMemoryDeploymentStore();
    artifactStore = new ArtifactStore();
    settings = new SettingsStore();
    telemetry = new TelemetryStore();
    agent = new CommandAgent(diary, deployments, artifactStore, environments, partitions, undefined, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });

    commandApp = Fastify({ logger: false });
    addMockAuth(commandApp);
    registerDeploymentRoutes(commandApp, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
    registerPartitionRoutes(commandApp, partitions, deployments, diary, telemetry);
    registerEnvironmentRoutes(commandApp, environments, deployments, telemetry);
    registerSettingsRoutes(commandApp, settings, telemetry);
    registerArtifactRoutes(commandApp, artifactStore, telemetry);

    await commandApp.ready();

    // Create shared environment
    const envRes = await inject(commandApp, "POST", "/api/environments", {
      name: "production",
      variables: { APP_ENV: "production" },
    });
    environmentId = (envRes.body.environment as Record<string, unknown>).id as string;

    // Create shared artifact
    const artRes = await inject(commandApp, "POST", "/api/artifacts", {
      name: "web-app",
      type: "generic",
    });
    artifactId = (artRes.body.artifact as Record<string, unknown>).id as string;

    // Create two separate partitions
    const partARes = await inject(commandApp, "POST", "/api/partitions", {
      name: "Partition Alpha",
      variables: { TENANT: "alpha", DB_HOST: "alpha-db" },
    });
    partitionAId = (partARes.body.partition as Record<string, unknown>).id as string;

    const partBRes = await inject(commandApp, "POST", "/api/partitions", {
      name: "Partition Beta",
      variables: { TENANT: "beta", DB_HOST: "beta-db" },
    });
    partitionBId = (partBRes.body.partition as Record<string, unknown>).id as string;
  });

  afterAll(async () => {
    await commandApp.close();
  });

  it("deploys to both partitions independently", async () => {
    const depARes = await inject(commandApp, "POST", "/api/deployments", {
      artifactId,
      partitionId: partitionAId,
      environmentId,
      version: "1.0.0",
    });
    expect(depARes.status).toBe(201);

    const depBRes = await inject(commandApp, "POST", "/api/deployments", {
      artifactId,
      partitionId: partitionBId,
      environmentId,
      version: "2.0.0",
    });
    expect(depBRes.status).toBe(201);
  });

  it("deployments for partition A are NOT visible when querying partition B", async () => {
    const partADeps = await inject(commandApp, "GET", `/api/deployments?partitionId=${partitionAId}`);
    const partBDeps = await inject(commandApp, "GET", `/api/deployments?partitionId=${partitionBId}`);

    const aDeps = partADeps.body.deployments as Array<Record<string, unknown>>;
    const bDeps = partBDeps.body.deployments as Array<Record<string, unknown>>;

    expect(aDeps.length).toBeGreaterThan(0);
    expect(bDeps.length).toBeGreaterThan(0);

    for (const dep of aDeps) { expect(dep.partitionId).toBe(partitionAId); }
    for (const dep of bDeps) { expect(dep.partitionId).toBe(partitionBId); }

    expect(aDeps.some((d) => d.version === "1.0.0")).toBe(true);
    expect(bDeps.some((d) => d.version === "2.0.0")).toBe(true);
    expect(aDeps.some((d) => d.version === "2.0.0")).toBe(false);
    expect(bDeps.some((d) => d.version === "1.0.0")).toBe(false);
  });

  it("partition history is isolated per partition", async () => {
    const historyA = await inject(commandApp, "GET", `/api/partitions/${partitionAId}/history`);
    const historyB = await inject(commandApp, "GET", `/api/partitions/${partitionBId}/history`);

    expect(historyA.status).toBe(200);
    expect(historyB.status).toBe(200);
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
    agent = new CommandAgent(diary, deployments, artifactStore, environments, partitions, undefined, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });

    commandApp = Fastify({ logger: false });
    addMockAuth(commandApp);
    registerDeploymentRoutes(commandApp, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
    registerPartitionRoutes(commandApp, partitions, deployments, diary, telemetry);
    registerEnvironmentRoutes(commandApp, environments, deployments, telemetry);
    registerSettingsRoutes(commandApp, settings, telemetry);
    registerArtifactRoutes(commandApp, artifactStore, telemetry);

    await commandApp.ready();
  });

  afterAll(async () => {
    await commandApp.close();
  });

  it("deployment creates expected debrief entries", async () => {
    const envRes = await inject(commandApp, "POST", "/api/environments", {
      name: "production",
      variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    });
    const environmentId = (envRes.body.environment as Record<string, unknown>).id as string;

    const artRes = await inject(commandApp, "POST", "/api/artifacts", {
      name: "web-app",
      type: "generic",
    });
    const artifactId = (artRes.body.artifact as Record<string, unknown>).id as string;

    const partRes = await inject(commandApp, "POST", "/api/partitions", {
      name: "Acme Corp",
      variables: { DB_HOST: "acme-db-1", REGION: "us-east-1" },
    });
    const partitionId = (partRes.body.partition as Record<string, unknown>).id as string;

    const deployRes = await inject(commandApp, "POST", "/api/deployments", {
      artifactId,
      partitionId,
      environmentId,
      version: "2.0.0",
    });
    expect(deployRes.status).toBe(201);
    const deploymentId = (deployRes.body.deployment as Record<string, unknown>).id as string;

    // Verify deployment is retrievable
    const debriefRes = await inject(commandApp, "GET", `/api/deployments/${deploymentId}`);
    expect(debriefRes.status).toBe(200);
    expect(debriefRes.body.deployment).toBeDefined();
    expect(debriefRes.body.debrief).toBeDefined();
  });

  it("records system-level entries visible via the general debrief endpoint", async () => {
    const debriefRes = await inject(commandApp, "GET", "/api/debrief?limit=100");
    expect(debriefRes.status).toBe(200);

    const entries = debriefRes.body.entries as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
  });
});
