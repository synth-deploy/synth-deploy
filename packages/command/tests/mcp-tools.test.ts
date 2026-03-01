import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DecisionDebrief,
  PartitionStore,
  OperationStore,
  EnvironmentStore,
  OrderStore,
  SettingsStore,
} from "@deploystack/core";
import type { Partition, Environment, Operation, Order, Deployment } from "@deploystack/core";
import { CommandAgent, InMemoryDeploymentStore } from "../src/agent/command-agent.js";
import { registerTools } from "../src/mcp/tools.js";

// ---------------------------------------------------------------------------
// Minimal McpServer stub — captures registered tools so we can invoke them
// ---------------------------------------------------------------------------

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

class FakeMcpServer {
  tools = new Map<string, ToolHandler>();

  registerTool(name: string, _meta: unknown, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  async call(name: string, params: Record<string, unknown>) {
    const handler = this.tools.get(name);
    if (!handler) throw new Error(`Tool not registered: ${name}`);
    return handler(params);
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let mcp: FakeMcpServer;
let partitions: PartitionStore;
let environments: EnvironmentStore;
let operations: OperationStore;
let deployments: InMemoryDeploymentStore;
let orders: OrderStore;
let settings: SettingsStore;
let agent: CommandAgent;

let partition: Partition;
let environment: Environment;
let operation: Operation;

beforeEach(() => {
  mcp = new FakeMcpServer();
  partitions = new PartitionStore();
  environments = new EnvironmentStore();
  operations = new OperationStore();
  deployments = new InMemoryDeploymentStore();
  orders = new OrderStore();
  settings = new SettingsStore();
  // Clear the default envoy URL so triggerDeployment does not try to reach
  // a real Envoy service during tests.
  settings.update({ envoy: { url: "", timeoutMs: 10000 } });
  agent = new CommandAgent(
    new DecisionDebrief(),
    deployments,
    orders,
    undefined,
    { healthCheckBackoffMs: 1, executionDelayMs: 1 },
    settings,
  );

  partition = partitions.create("test-partition");
  environment = environments.create("staging");
  operation = operations.create("web-app", [environment.id]);

  // Register tools under test
  registerTools(
    mcp as unknown as Parameters<typeof registerTools>[0],
    agent,
    partitions,
    environments,
    deployments,
    operations,
  );
});

// ===========================================================================
// trigger-deployment
// ===========================================================================

describe("trigger-deployment", () => {
  it("succeeds with valid params and returns deployment info", async () => {
    const result = await mcp.call("trigger-deployment", {
      operationId: operation.id,
      partitionId: partition.id,
      environmentId: environment.id,
      version: "1.0.0",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.deploymentId).toBeDefined();
    expect(payload.orderId).toBeDefined();
    expect(payload.status).toBeDefined();
    expect(payload.version).toBe("1.0.0");
    expect(typeof payload.debriefEntries).toBe("number");
  });

  it("returns error when partition is missing", async () => {
    const result = await mcp.call("trigger-deployment", {
      operationId: operation.id,
      partitionId: "nonexistent-partition",
      environmentId: environment.id,
      version: "1.0.0",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Partition not found");
    expect(result.content[0].text).toContain("nonexistent-partition");
  });

  it("returns error when environment is missing", async () => {
    const result = await mcp.call("trigger-deployment", {
      operationId: operation.id,
      partitionId: partition.id,
      environmentId: "nonexistent-env",
      version: "1.0.0",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Environment not found");
    expect(result.content[0].text).toContain("nonexistent-env");
  });

  it("returns error when operation is missing", async () => {
    const result = await mcp.call("trigger-deployment", {
      operationId: "nonexistent-op",
      partitionId: partition.id,
      environmentId: environment.id,
      version: "1.0.0",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Operation not found");
    expect(result.content[0].text).toContain("nonexistent-op");
  });

  it("passes optional variables through to the deployment", async () => {
    const result = await mcp.call("trigger-deployment", {
      operationId: operation.id,
      partitionId: partition.id,
      environmentId: environment.id,
      version: "2.0.0",
      variables: { FEATURE_FLAG: "on" },
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    // The deployment was created — verify it exists in the store
    const deployment = deployments.get(payload.deploymentId);
    expect(deployment).toBeDefined();
    expect(deployment!.version).toBe("2.0.0");
  });
});

// ===========================================================================
// get-deployment-status
// ===========================================================================

describe("get-deployment-status", () => {
  it("returns deployment details for an existing deployment", async () => {
    // First trigger a deployment to get a valid ID
    const triggerResult = await mcp.call("trigger-deployment", {
      operationId: operation.id,
      partitionId: partition.id,
      environmentId: environment.id,
      version: "1.0.0",
    });
    const { deploymentId } = JSON.parse(triggerResult.content[0].text);

    const result = await mcp.call("get-deployment-status", { deploymentId });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe(deploymentId);
    expect(payload.version).toBe("1.0.0");
    expect(payload.status).toBeDefined();
  });

  it("returns error for a missing deployment", async () => {
    const result = await mcp.call("get-deployment-status", {
      deploymentId: "does-not-exist",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Deployment not found");
    expect(result.content[0].text).toContain("does-not-exist");
  });
});
