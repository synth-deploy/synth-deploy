/**
 * Scenario test harness — boots Synth server + Envoy in-process and provides
 * helpers for scripting user actions via HTTP. Foundation for all scenario
 * and fault-injection tests.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
import { registerDeploymentRoutes } from "@synth-deploy/server/api/deployments.js";
import { registerPartitionRoutes } from "@synth-deploy/server/api/partitions.js";
import { registerEnvironmentRoutes } from "@synth-deploy/server/api/environments.js";
import { registerSettingsRoutes } from "@synth-deploy/server/api/settings.js";
import { registerEnvoyReportRoutes } from "@synth-deploy/server/api/envoy-reports.js";
import { registerArtifactRoutes } from "@synth-deploy/server/api/artifacts.js";
import { registerHealthRoutes } from "@synth-deploy/server/api/health.js";

import { EnvoyAgent } from "@synth-deploy/envoy/agent/envoy-agent.js";
import { LocalStateStore } from "@synth-deploy/envoy/state/local-state.js";
import { createEnvoyServer } from "@synth-deploy/envoy/server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandContext {
  app: FastifyInstance;
  baseUrl: string;
  diary: DecisionDebrief;
  partitions: PartitionStore;
  artifactStore: ArtifactStore;
  environments: EnvironmentStore;
  deployments: InMemoryDeploymentStore;
  telemetry: TelemetryStore;
  settings: SettingsStore;
  agent: SynthAgent;
}

export interface EnvoyContext {
  app: FastifyInstance;
  baseUrl: string;
  agent: EnvoyAgent;
  state: LocalStateStore;
  tmpDir: string;
}

export interface ScenarioHarness {
  command: CommandContext;
  envoy: EnvoyContext;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `synth-scenario-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "deployments"), { recursive: true });
  return dir;
}

export function removeTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

function getPort(app: FastifyInstance): number {
  const addr = app.server.address();
  if (addr && typeof addr === "object") return addr.port;
  throw new Error("Server not listening on a port");
}

/** Mock auth — inject a test user with all permissions on every request. */
function addMockAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    (request as any).user = {
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
// HTTP helpers
// ---------------------------------------------------------------------------

export async function http(
  baseUrl: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// Entity creation helpers — returns IDs
// ---------------------------------------------------------------------------

export async function createPartition(
  baseUrl: string,
  name: string,
  variables: Record<string, string> = {},
): Promise<string> {
  const res = await http(baseUrl, "POST", "/api/partitions", { name, variables });
  if (res.status !== 201) throw new Error(`Failed to create partition: ${JSON.stringify(res.body)}`);
  return (res.body.partition as Record<string, unknown>).id as string;
}

export async function createEnvironment(
  baseUrl: string,
  name: string,
  variables: Record<string, string> = {},
): Promise<string> {
  const res = await http(baseUrl, "POST", "/api/environments", { name, variables });
  if (res.status !== 201) throw new Error(`Failed to create environment: ${JSON.stringify(res.body)}`);
  return (res.body.environment as Record<string, unknown>).id as string;
}

export async function createArtifact(
  baseUrl: string,
  name: string,
): Promise<string> {
  const res = await http(baseUrl, "POST", "/api/artifacts", { name, type: "generic" });
  if (res.status !== 201) throw new Error(`Failed to create artifact: ${JSON.stringify(res.body)}`);
  return (res.body.artifact as Record<string, unknown>).id as string;
}

export async function deploy(
  baseUrl: string,
  params: {
    artifactId: string;
    partitionId: string;
    environmentId: string;
    version: string;
    variables?: Record<string, string>;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return http(baseUrl, "POST", "/api/deployments", {
    artifactId: params.artifactId,
    environmentId: params.environmentId,
    partitionId: params.partitionId,
    version: params.version,
    ...(params.variables ? { variables: params.variables } : {}),
  });
}

// ---------------------------------------------------------------------------
// Server factories
// ---------------------------------------------------------------------------

export async function createCommandServer(): Promise<CommandContext> {
  const diary = new DecisionDebrief();
  const partitions = new PartitionStore();
  const artifactStore = new ArtifactStore();
  const environments = new EnvironmentStore();
  const deployments = new InMemoryDeploymentStore();
  const telemetry = new TelemetryStore();
  const settings = new SettingsStore();
  const agent = new SynthAgent(diary, deployments, artifactStore, environments, partitions, undefined, {
    healthCheckBackoffMs: 1,
    executionDelayMs: 1,
  });

  const app = Fastify({ logger: false });
  addMockAuth(app);
  registerDeploymentRoutes(app, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
  registerPartitionRoutes(app, partitions, deployments, diary, telemetry);
  registerEnvironmentRoutes(app, environments, deployments, telemetry);
  registerSettingsRoutes(app, settings, telemetry);
  registerEnvoyReportRoutes(app, diary, deployments);
  registerArtifactRoutes(app, artifactStore, telemetry);
  registerHealthRoutes(app);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${getPort(app)}`;

  return { app, baseUrl, diary, partitions, artifactStore, environments, deployments, telemetry, settings, agent };
}

export async function createEnvoyServer_(): Promise<EnvoyContext> {
  const tmpDir = makeTmpDir();
  const diary = new DecisionDebrief();
  const state = new LocalStateStore();
  const agent = new EnvoyAgent(diary, state, tmpDir);
  const app = createEnvoyServer(agent, state);

  await app.listen({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${getPort(app)}`;

  return { app, baseUrl, agent, state, tmpDir };
}

export async function createHarness(): Promise<ScenarioHarness> {
  const command = await createCommandServer();
  const envoy = await createEnvoyServer_();
  return { command, envoy };
}

export async function teardownHarness(harness: ScenarioHarness): Promise<void> {
  await harness.command.app.close();
  await harness.envoy.app.close();
  removeTmpDir(harness.envoy.tmpDir);
}
