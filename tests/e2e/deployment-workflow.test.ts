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

// --- Server imports ---
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
import { registerHealthRoutes } from "@synth-deploy/server/api/health.js";

// --- Envoy imports ---
import { EnvoyAgent } from "@synth-deploy/envoy/agent/envoy-agent.js";
import { LocalStateStore } from "@synth-deploy/envoy/state/local-state.js";
import { createEnvoyServer } from "@synth-deploy/envoy/server.js";

// ==========================================================================
// Helpers
// ==========================================================================

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `synth-e2e-${crypto.randomUUID()}`);
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

function getPort(app: FastifyInstance): number {
  const addr = app.server.address();
  if (addr && typeof addr === "object") {
    return addr.port;
  }
  throw new Error("Server not listening on a port");
}

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

async function deployViaHttp(
  baseUrl: string,
  params: { artifactId: string; partitionId: string; environmentId: string; version: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return httpRequest(baseUrl, "POST", "/api/operations", {
    artifactId: params.artifactId,
    environmentId: params.environmentId,
    partitionId: params.partitionId,
    version: params.version,
  });
}

// ==========================================================================
// Helper: build a Synth server with all routes registered
// ==========================================================================

interface SynthServerContext {
  app: FastifyInstance;
  baseUrl: string;
  diary: DecisionDebrief;
  partitions: PartitionStore;
  environments: EnvironmentStore;
  deployments: InMemoryDeploymentStore;
  artifactStore: ArtifactStore;
  settings: SettingsStore;
  telemetry: TelemetryStore;
  agent: SynthAgent;
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

async function createSynthServer(): Promise<SynthServerContext> {
  const diary = new DecisionDebrief();
  const partitions = new PartitionStore();
  const environments = new EnvironmentStore();
  const deployments = new InMemoryDeploymentStore();
  const artifactStore = new ArtifactStore();
  const settings = new SettingsStore();
  const telemetry = new TelemetryStore();
  const agent = new SynthAgent(diary, deployments, artifactStore, environments, partitions, undefined, {
    healthCheckBackoffMs: 1,
    executionDelayMs: 1,
  });

  const app = Fastify({ logger: false });
  addMockAuth(app);
  registerOperationRoutes(app, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
  registerPartitionRoutes(app, partitions, deployments, diary, telemetry);
  registerEnvironmentRoutes(app, environments, deployments, telemetry);
  registerSettingsRoutes(app, settings, telemetry);
  registerEnvoyReportRoutes(app, diary, deployments);
  registerArtifactRoutes(app, artifactStore, telemetry);
  registerHealthRoutes(app);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${getPort(app)}`;

  return { app, baseUrl, diary, partitions, environments, deployments, artifactStore, settings, telemetry, agent };
}

// ==========================================================================
// Scenario 1: Full deployment lifecycle via HTTP
// ==========================================================================

describe("E2E: Full deployment lifecycle via HTTP", () => {
  let ctx: SynthServerContext;

  beforeAll(async () => {
    ctx = await createSynthServer();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("creates entities via HTTP and triggers a deployment that persists in the store", async () => {
    // Step 1: Create an artifact
    const artifactRes = await httpRequest(ctx.baseUrl, "POST", "/api/artifacts", {
      name: "web-app",
      type: "generic",
    });
    expect(artifactRes.status).toBe(201);
    const artifactId = (artifactRes.body.artifact as Record<string, unknown>).id as string;

    // Step 2: Create a partition
    const partRes = await httpRequest(ctx.baseUrl, "POST", "/api/partitions", {
      name: "Acme Corp",
      variables: { REGION: "us-east-1", DB_HOST: "acme-db-1" },
    });
    expect(partRes.status).toBe(201);
    const partitionId = (partRes.body.partition as Record<string, unknown>).id as string;

    // Step 3: Create an environment
    const envRes = await httpRequest(ctx.baseUrl, "POST", "/api/environments", {
      name: "production",
      variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    });
    expect(envRes.status).toBe(201);
    const environmentId = (envRes.body.environment as Record<string, unknown>).id as string;

    // Step 4: Create a deployment
    const deployRes = await deployViaHttp(ctx.baseUrl, {
      artifactId,
      partitionId,
      environmentId,
      version: "1.0.0",
    });
    expect(deployRes.status).toBe(201);

    const deployment = deployRes.body.deployment as Record<string, unknown>;
    const deploymentId = deployment.id as string;
    expect((deployment.input as Record<string, unknown>).artifactId).toBe(artifactId);
    expect(deployment.partitionId).toBe(partitionId);
    expect(deployment.environmentId).toBe(environmentId);

    // Verify variables were resolved (partition vars merged with env vars)
    const deployedVars = deployment.variables as Record<string, string>;
    expect(deployedVars.REGION).toBe("us-east-1");
    expect(deployedVars.DB_HOST).toBe("acme-db-1");
    expect(deployedVars.APP_ENV).toBe("production");
    expect(deployedVars.LOG_LEVEL).toBe("warn");

    // Step 5: Verify deployment persists via HTTP GET
    const fetchedDeploy = await httpRequest(ctx.baseUrl, "GET", `/api/operations/${deploymentId}`);
    expect(fetchedDeploy.status).toBe(200);
    const stored = fetchedDeploy.body.deployment as Record<string, unknown>;
    expect(stored.id).toBe(deploymentId);
    expect((stored.input as Record<string, unknown>).artifactId).toBe(artifactId);
    expect(stored.partitionId).toBe(partitionId);
  });

  it("lists deployments filtered by partition via HTTP", async () => {
    const allParts = await httpRequest(ctx.baseUrl, "GET", "/api/partitions");
    const partList = allParts.body.partitions as Array<Record<string, unknown>>;
    expect(partList.length).toBeGreaterThan(0);

    const partitionId = partList[0].id as string;

    const filteredRes = await httpRequest(ctx.baseUrl, "GET", `/api/operations?partitionId=${partitionId}`);
    expect(filteredRes.status).toBe(200);
    const filteredDeps = filteredRes.body.deployments as Array<Record<string, unknown>>;
    for (const dep of filteredDeps) {
      expect(dep.partitionId).toBe(partitionId);
    }
  });

  it("returns debrief entries via the general debrief HTTP endpoint", async () => {
    const debriefRes = await httpRequest(ctx.baseUrl, "GET", "/api/debrief?limit=100");
    expect(debriefRes.status).toBe(200);
    const entries = debriefRes.body.entries as Array<Record<string, unknown>>;
    expect(Array.isArray(entries)).toBe(true);
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
    await envoyApp.listen({ port: 0, host: "127.0.0.1" });
    envoyBaseUrl = `http://127.0.0.1:${getPort(envoyApp)}`;
  });

  afterAll(async () => {
    await envoyApp.close();
    removeTmpDir(envoyTmpDir);
  });

  it("dispatches a deployment to the Envoy via HTTP and verifies workspace artifacts", async () => {
    const deploymentId = crypto.randomUUID();

    const { status, body } = await httpRequest(envoyBaseUrl, "POST", "/deploy", {
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

  it("returns debrief entries with the deployment result via HTTP", async () => {
    const { body } = await httpRequest(envoyBaseUrl, "POST", "/deploy", {
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

  it("updates Envoy local state after deployment, visible via HTTP status endpoint", async () => {
    const deploymentId = crypto.randomUUID();

    await httpRequest(envoyBaseUrl, "POST", "/deploy", {
      deploymentId,
      partitionId: crypto.randomUUID(),
      environmentId: crypto.randomUUID(),
      operationId: "worker",
      version: "3.0.0",
      variables: { WORKER_THREADS: "4" },
      environmentName: "production",
      partitionName: "AcmePartition",
    });

    const { body: statusBody } = await httpRequest(envoyBaseUrl, "GET", "/status");

    const recentDeployments = statusBody.recentDeployments as Array<Record<string, unknown>>;
    const found = recentDeployments.find((d) => d.deploymentId === deploymentId);
    expect(found).toBeDefined();
    expect(found!.status).toBe("succeeded");
    expect(found!.version).toBe("3.0.0");
  });

  it("serves a healthy health check via HTTP", async () => {
    const { status, body } = await httpRequest(envoyBaseUrl, "GET", "/health");
    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.service).toBe("synth-envoy");
  });
});

// ==========================================================================
// Scenario 3: Partition isolation via HTTP
// ==========================================================================

describe("E2E: Partition isolation via HTTP", () => {
  let ctx: SynthServerContext;
  let partitionAId: string;
  let partitionBId: string;
  let artifactId: string;
  let environmentId: string;

  beforeAll(async () => {
    ctx = await createSynthServer();

    const envRes = await httpRequest(ctx.baseUrl, "POST", "/api/environments", {
      name: "production",
      variables: { APP_ENV: "production" },
    });
    environmentId = (envRes.body.environment as Record<string, unknown>).id as string;

    const artifactRes = await httpRequest(ctx.baseUrl, "POST", "/api/artifacts", {
      name: "web-app",
      type: "generic",
    });
    artifactId = (artifactRes.body.artifact as Record<string, unknown>).id as string;

    const partARes = await httpRequest(ctx.baseUrl, "POST", "/api/partitions", {
      name: "Partition Alpha",
      variables: { TENANT: "alpha", DB_HOST: "alpha-db" },
    });
    partitionAId = (partARes.body.partition as Record<string, unknown>).id as string;

    const partBRes = await httpRequest(ctx.baseUrl, "POST", "/api/partitions", {
      name: "Partition Beta",
      variables: { TENANT: "beta", DB_HOST: "beta-db" },
    });
    partitionBId = (partBRes.body.partition as Record<string, unknown>).id as string;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it("deploys to both partitions independently via HTTP", async () => {
    const depARes = await deployViaHttp(ctx.baseUrl, { artifactId, partitionId: partitionAId, environmentId, version: "1.0.0" });
    expect(depARes.status).toBe(201);

    const depBRes = await deployViaHttp(ctx.baseUrl, { artifactId, partitionId: partitionBId, environmentId, version: "2.0.0" });
    expect(depBRes.status).toBe(201);
  });

  it("deployments for partition A are NOT visible when querying partition B via HTTP", async () => {
    const partADeps = await httpRequest(ctx.baseUrl, "GET", `/api/operations?partitionId=${partitionAId}`);
    const partBDeps = await httpRequest(ctx.baseUrl, "GET", `/api/operations?partitionId=${partitionBId}`);

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

  it("partition history is isolated per partition via HTTP", async () => {
    const historyA = await httpRequest(ctx.baseUrl, "GET", `/api/partitions/${partitionAId}/history`);
    const historyB = await httpRequest(ctx.baseUrl, "GET", `/api/partitions/${partitionBId}/history`);

    expect(historyA.status).toBe(200);
    expect(historyB.status).toBe(200);
    expect(historyA.body.history).toBeDefined();
    expect(historyB.body.history).toBeDefined();
  });
});
