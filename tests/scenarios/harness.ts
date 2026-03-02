/**
 * Scenario test harness — boots Command + Envoy in-process and provides
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandContext {
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
  const dir = path.join(os.tmpdir(), `deploystack-scenario-${crypto.randomUUID()}`);
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

export async function createOperation(
  baseUrl: string,
  name: string,
): Promise<string> {
  const res = await http(baseUrl, "POST", "/api/operations", { name });
  if (res.status !== 201) throw new Error(`Failed to create operation: ${JSON.stringify(res.body)}`);
  return (res.body.operation as Record<string, unknown>).id as string;
}

export async function linkEnvironment(
  baseUrl: string,
  operationId: string,
  environmentId: string,
): Promise<void> {
  const res = await http(baseUrl, "POST", `/api/operations/${operationId}/environments`, { environmentId });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Failed to link environment: ${JSON.stringify(res.body)}`);
  }
}

export async function deploy(
  baseUrl: string,
  params: {
    operationId: string;
    partitionId: string;
    environmentId: string;
    version: string;
    variables?: Record<string, string>;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Create an order first
  const orderRes = await http(baseUrl, "POST", "/api/orders", {
    operationId: params.operationId,
    partitionId: params.partitionId,
    environmentId: params.environmentId,
    version: params.version,
  });
  if (orderRes.status !== 201) {
    throw new Error(`Failed to create order: ${JSON.stringify(orderRes.body)}`);
  }
  const orderId = (orderRes.body.order as Record<string, unknown>).id as string;

  return http(baseUrl, "POST", "/api/deployments", {
    orderId,
    partitionId: params.partitionId,
    environmentId: params.environmentId,
    triggeredBy: "user",
    ...(params.variables ? { variables: params.variables } : {}),
  });
}

// ---------------------------------------------------------------------------
// Server factories
// ---------------------------------------------------------------------------

export async function createCommandServer(): Promise<CommandContext> {
  const diary = new DecisionDebrief();
  const partitions = new PartitionStore();
  const operations = new OperationStore();
  const environments = new EnvironmentStore();
  const deployments = new InMemoryDeploymentStore();
  const orders = new OrderStore();
  const settings = new SettingsStore();
  // No settingsReader on CommandAgent — uses local execution path for tests
  const agent = new CommandAgent(diary, deployments, orders, undefined, {
    healthCheckBackoffMs: 1,
    executionDelayMs: 1,
  });

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
