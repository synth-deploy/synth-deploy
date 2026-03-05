import { describe, it, expect, beforeEach } from "vitest";
import {
  DecisionDebrief,
  PartitionStore,
  EnvironmentStore,
  ArtifactStore,
  SettingsStore,
} from "@deploystack/core";
import type { Partition, Environment, Artifact } from "@deploystack/core";
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
let artifactStore: ArtifactStore;
let deployments: InMemoryDeploymentStore;
let settings: SettingsStore;
let agent: CommandAgent;

let partition: Partition;
let environment: Environment;
let artifact: Artifact;

beforeEach(() => {
  mcp = new FakeMcpServer();
  partitions = new PartitionStore();
  environments = new EnvironmentStore();
  artifactStore = new ArtifactStore();
  deployments = new InMemoryDeploymentStore();
  settings = new SettingsStore();
  // Clear the default envoy URL so triggerDeployment does not try to reach
  // a real Envoy service during tests.
  settings.update({ envoy: { url: "", timeoutMs: 10000 } });
  agent = new CommandAgent(
    new DecisionDebrief(),
    deployments,
    artifactStore,
    environments,
    partitions,
    undefined,
    { healthCheckBackoffMs: 1, executionDelayMs: 1 },
    settings,
  );

  partition = partitions.create("test-partition");
  environment = environments.create("staging");
  artifact = artifactStore.create({
    name: "web-app",
    type: "nodejs",
    analysis: {
      summary: "test artifact",
      dependencies: [],
      configurationExpectations: {},
      deploymentIntent: "rolling",
      confidence: 0.9,
    },
    annotations: [],
    learningHistory: [],
  });

  // Register tools under test
  registerTools(
    mcp as unknown as Parameters<typeof registerTools>[0],
    agent,
    partitions,
    environments,
    deployments,
    artifactStore,
  );
});

// ===========================================================================
// trigger-deployment
// ===========================================================================

describe("trigger-deployment", () => {
  it("succeeds with valid params and returns deployment info", async () => {
    const result = await mcp.call("trigger-deployment", {
      artifactId: artifact.id,
      partitionId: partition.id,
      environmentId: environment.id,
      version: "1.0.0",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.deploymentId).toBeDefined();
    expect(payload.status).toBeDefined();
    expect(payload.version).toBe("1.0.0");
    expect(typeof payload.debriefEntries).toBe("number");
  });

  it("returns error when partition is missing", async () => {
    const result = await mcp.call("trigger-deployment", {
      artifactId: artifact.id,
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
      artifactId: artifact.id,
      partitionId: partition.id,
      environmentId: "nonexistent-env",
      version: "1.0.0",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Environment not found");
    expect(result.content[0].text).toContain("nonexistent-env");
  });

  it("returns error when artifact is missing", async () => {
    const result = await mcp.call("trigger-deployment", {
      artifactId: "nonexistent-artifact",
      partitionId: partition.id,
      environmentId: environment.id,
      version: "1.0.0",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Artifact not found");
    expect(result.content[0].text).toContain("nonexistent-artifact");
  });

  it("passes optional variables through to the deployment", async () => {
    const result = await mcp.call("trigger-deployment", {
      artifactId: artifact.id,
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
      artifactId: artifact.id,
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
