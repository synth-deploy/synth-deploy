import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  DecisionDebrief,
  PartitionStore,
  EnvironmentStore,
  ArtifactStore,
  SettingsStore,
  TelemetryStore,
} from "@synth-deploy/core";
import type { Operation, OperationPlan } from "@synth-deploy/core";
import { InMemoryDeploymentStore } from "../src/agent/synth-agent.js";
import { registerOperationRoutes } from "../src/api/operations.js";
import { registerArtifactRoutes } from "../src/api/artifacts.js";
import type { EnvoyRegistry, EnvoyRegistration } from "../src/agent/envoy-registry.js";

// ---------------------------------------------------------------------------
// Mock EnvoyClient — prevents real network calls in all tests in this file
// ---------------------------------------------------------------------------

vi.mock("../src/agent/envoy-client.js", () => ({
  // Must use a regular function (not arrow) so 'new EnvoyClient()' works correctly
  EnvoyClient: vi.fn().mockImplementation(function (this: any) {
    this.requestPlan = vi.fn().mockResolvedValue({
      blocked: false,
      plan: { scriptedPlan: { platform: "bash", reasoning: "test plan", steps: [{ description: "Step 1", script: "echo test", dryRunScript: null, rollbackScript: null, reversible: false }] }, reasoning: "test plan" },
      rollbackPlan: { scriptedPlan: { platform: "bash", reasoning: "no rollback", steps: [] }, reasoning: "no rollback" },
    });
    this.executeApprovedPlan = vi.fn().mockResolvedValue({});
    this.removeMonitoringDirective = vi.fn().mockResolvedValue({});
  }),
}));

// ---------------------------------------------------------------------------
// Shared envoy registry mock
// ---------------------------------------------------------------------------

const MOCK_ENVOY: EnvoyRegistration = {
  id: "envoy-composite-test",
  name: "Composite Test Envoy",
  url: "http://localhost:19999",
  token: "test-token",
  assignedEnvironments: [],
  assignedPartitions: [],
  registeredAt: new Date().toISOString(),
  lastHealthCheck: null,
  lastHealthStatus: null,
  cachedHostname: null,
  cachedOs: null,
  cachedSummary: null,
  cachedReadiness: null,
};

const MOCK_REGISTRY: EnvoyRegistry = {
  list: () => [MOCK_ENVOY],
  get: (id: string) => id === MOCK_ENVOY.id ? MOCK_ENVOY : undefined,
  findForEnvironment: () => undefined,
  register: () => MOCK_ENVOY,
  deregister: () => true,
  update: () => undefined,
  updateHealth: () => undefined,
} as unknown as EnvoyRegistry;

const MOCK_PLAN: OperationPlan = {
  scriptedPlan: { platform: "bash", reasoning: "standard maintenance check", steps: [{ description: "Check services", script: "systemctl status", dryRunScript: null, rollbackScript: null, reversible: false }] },
  reasoning: "standard maintenance check",
};

// ---------------------------------------------------------------------------
// Test server factory
// ---------------------------------------------------------------------------

interface TestContext {
  app: FastifyInstance;
  deployments: InMemoryDeploymentStore;
  diary: DecisionDebrief;
}

async function createTestServer(opts: { withRegistry?: boolean } = {}): Promise<TestContext> {
  const diary = new DecisionDebrief();
  const deployments = new InMemoryDeploymentStore();
  const partitions = new PartitionStore();
  const environments = new EnvironmentStore();
  const artifactStore = new ArtifactStore();
  const settings = new SettingsStore();
  const telemetry = new TelemetryStore();

  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    request.user = {
      id: "test-user-id" as any,
      email: "test@example.com",
      name: "Test User",
      permissions: [
        "deployment.create", "deployment.approve", "deployment.reject",
        "deployment.view", "deployment.rollback", "artifact.create", "artifact.view",
      ],
    };
  });

  registerOperationRoutes(
    app, deployments, diary, partitions, environments, artifactStore, settings, telemetry,
    undefined, undefined,
    opts.withRegistry ? MOCK_REGISTRY : undefined,
  );
  registerArtifactRoutes(app, artifactStore, telemetry);

  await app.ready();
  return { app, deployments, diary };
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function seedComposite(
  deployments: InMemoryDeploymentStore,
  status: Operation["status"] = "awaiting_approval",
): Operation {
  const op: any = {
    id: crypto.randomUUID(),
    input: { type: "composite", steps: [] },
    status,
    variables: {},
    debriefEntryIds: [],
    createdAt: new Date(),
    version: "",
  };
  deployments.save(op);
  return op as Operation;
}

function seedChild(
  deployments: InMemoryDeploymentStore,
  parentId: string,
  overrides: Partial<any> = {},
): Operation {
  const child: any = {
    id: crypto.randomUUID(),
    input: { type: "query", intent: "check disk usage" },
    lineage: parentId,
    status: "awaiting_approval",
    variables: {},
    debriefEntryIds: [],
    createdAt: new Date(),
    version: "",
    sequenceIndex: 0,
    ...overrides,
  };
  deployments.save(child);
  return child as Operation;
}

/** Flush pending microtasks and macrotasks (lets fire-and-forget async settle) */
async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  await Promise.resolve();
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Composite Operations — creation via HTTP (no envoy registry)", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  it("creates a composite operation and returns 201", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/operations",
      payload: {
        type: "composite",
        operations: [
          { type: "query", intent: "check disk usage" },
          { type: "investigate", intent: "look for memory leaks" },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.deployment).toBeDefined();
    expect(body.deployment.status).toBe("pending");
    expect(body.deployment.input.type).toBe("composite");
    expect(body.deployment.input.steps).toHaveLength(2);
  });

  it("creates a composite with empty operations array", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/operations",
      payload: { type: "composite", operations: [] },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.deployment.input.type).toBe("composite");
    expect(body.deployment.input.steps).toHaveLength(0);
  });

  it("stores the composite operation in the deployment store", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/operations",
      payload: {
        type: "composite",
        operations: [{ type: "maintain", intent: "rotate certs" }],
      },
    });

    const body = JSON.parse(res.payload);
    const stored = ctx.deployments.get(body.deployment.id);
    expect(stored).toBeDefined();
    expect(stored?.input.type).toBe("composite");
  });
});

describe("Composite Operations — planning via envoy registry", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    ctx = await createTestServer({ withRegistry: true });
  });

  it("planCompositeChildren marks parent as failed when operations array is empty", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/operations",
      payload: { type: "composite", operations: [] },
    });

    // planCompositeChildren is fire-and-forget — let it settle
    await flushAsync();

    // With registry, the route returns before sending {deployment}; find via store
    const ops = ctx.deployments.list().filter((d: any) => d.input.type === "composite");
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe("failed");
    expect((ops[0] as any).failureReason).toContain("no child operations");
  });

  it("planCompositeChildren creates child operations and awaits approval", async () => {
    await ctx.app.inject({
      method: "POST",
      url: "/api/operations",
      payload: {
        type: "composite",
        operations: [
          { type: "query", intent: "check health" },
          { type: "investigate", intent: "diagnose slowness" },
        ],
      },
    });

    await flushAsync();

    const all = ctx.deployments.list();
    const parents = all.filter((d: any) => d.input.type === "composite");
    expect(parents).toHaveLength(1);
    const parentId = parents[0].id;

    expect(parents[0].status).toBe("awaiting_approval");

    const children = all.filter((d: any) => d.lineage === parentId);
    expect(children).toHaveLength(2);
    expect(children.every((c: any) => c.status === "awaiting_approval")).toBe(true);
  });

  it("planCompositeChildren marks parent as failed when planning is blocked", async () => {
    const { EnvoyClient } = await import("../src/agent/envoy-client.js");
    // operations.ts line 125 creates a planningClient BEFORE the composite check (unused for composite)
    (EnvoyClient as any).mockImplementationOnce(function (this: any) {
      this.requestPlan = vi.fn(); // unused — composite route returns before calling this
    });
    // Inside planCompositeChildren, a new EnvoyClient is created per child
    (EnvoyClient as any).mockImplementationOnce(function (this: any) {
      this.requestPlan = vi.fn().mockResolvedValue({
        blocked: true,
        blockReason: "insufficient permissions",
        plan: { scriptedPlan: { platform: "bash", reasoning: "", steps: [] }, reasoning: "" },
        rollbackPlan: { scriptedPlan: { platform: "bash", reasoning: "", steps: [] }, reasoning: "" },
      });
    });

    await ctx.app.inject({
      method: "POST",
      url: "/api/operations",
      payload: {
        type: "composite",
        operations: [{ type: "query", intent: "check something" }],
      },
    });

    await flushAsync();

    const parents = ctx.deployments.list().filter((d: any) => d.input.type === "composite");
    expect(parents[0].status).toBe("failed");
    expect((parents[0] as any).failureReason).toContain("blocked");
  });

  it("planCompositeChildren marks parent as failed when requestPlan throws", async () => {
    const { EnvoyClient } = await import("../src/agent/envoy-client.js");
    // Unused client created at operations.ts line 125 before the composite check
    (EnvoyClient as any).mockImplementationOnce(function (this: any) {
      this.requestPlan = vi.fn();
    });
    // Client inside planCompositeChildren that throws on requestPlan
    (EnvoyClient as any).mockImplementationOnce(function (this: any) {
      this.requestPlan = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    });

    await ctx.app.inject({
      method: "POST",
      url: "/api/operations",
      payload: {
        type: "composite",
        operations: [{ type: "query", intent: "check something" }],
      },
    });

    await flushAsync();

    const parents = ctx.deployments.list().filter((d: any) => d.input.type === "composite");
    expect(parents[0].status).toBe("failed");
    expect((parents[0] as any).failureReason).toContain("ECONNREFUSED");
  });
});

describe("Composite Operations — approval and execution", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  it("approving composite with no children succeeds", async () => {
    const parent = seedComposite(ctx.deployments, "awaiting_approval");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/operations/${parent.id}/approve`,
      payload: { approvedBy: "ops@example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).approved).toBe(true);

    // executeCompositeSequentially([]) runs synchronously → already succeeded
    const final = ctx.deployments.get(parent.id);
    expect(final?.status).toBe("succeeded");
  });

  it("approving composite transitions all children to approved", async () => {
    const parent = seedComposite(ctx.deployments, "awaiting_approval");
    const child1 = seedChild(ctx.deployments, parent.id, { sequenceIndex: 0 });
    const child2 = seedChild(ctx.deployments, parent.id, { sequenceIndex: 1 });

    await ctx.app.inject({
      method: "POST",
      url: `/api/operations/${parent.id}/approve`,
      payload: { approvedBy: "ops@example.com" },
    });

    // Verify approval was applied — children may have progressed past "approved"
    // due to fire-and-forget executeCompositeChildren running asynchronously.
    const c1 = ctx.deployments.get(child1.id);
    const c2 = ctx.deployments.get(child2.id);
    expect((c1 as any)?.approvedBy).toBe("ops@example.com");
    expect((c2 as any)?.approvedBy).toBe("ops@example.com");
    expect((c1 as any)?.approvedAt).toBeDefined();
    expect((c2 as any)?.approvedAt).toBeDefined();
  });

  it("returns 409 when approving composite in non-awaiting_approval status", async () => {
    const parent = seedComposite(ctx.deployments, "pending");

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/operations/${parent.id}/approve`,
      payload: { approvedBy: "ops@example.com" },
    });

    expect(res.statusCode).toBe(409);
  });

  it("executeCompositeSequentially fails when child has no plan", async () => {
    const parent = seedComposite(ctx.deployments, "awaiting_approval");
    seedChild(ctx.deployments, parent.id); // child exists but has no plan

    await ctx.app.inject({
      method: "POST",
      url: `/api/operations/${parent.id}/approve`,
      payload: { approvedBy: "ops@example.com" },
    });

    await flushAsync();

    const final = ctx.deployments.get(parent.id);
    expect(final?.status).toBe("failed");
    expect((final as any)?.failureReason).toContain("no plan");
  });

  it("executeCompositeSequentially fails when no envoy available for child", async () => {
    const parent = seedComposite(ctx.deployments, "awaiting_approval");
    // Child has a plan but no envoyId, and this ctx has no envoy registry
    seedChild(ctx.deployments, parent.id, {
      plan: MOCK_PLAN,
      rollbackPlan: { scriptedPlan: { platform: "bash", reasoning: "", steps: [] }, reasoning: "" },
    });

    await ctx.app.inject({
      method: "POST",
      url: `/api/operations/${parent.id}/approve`,
      payload: { approvedBy: "ops@example.com" },
    });

    await flushAsync();

    const final = ctx.deployments.get(parent.id);
    expect(final?.status).toBe("failed");
    expect((final as any)?.failureReason).toContain("No envoy available");
  });

  it("GET /api/operations lists composite operations", async () => {
    const parent = seedComposite(ctx.deployments, "awaiting_approval");

    const res = await ctx.app.inject({ method: "GET", url: "/api/operations" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    const found = body.deployments.find((d: any) => d.id === parent.id);
    expect(found).toBeDefined();
    expect(found.input.type).toBe("composite");
  });

  it("GET /api/operations/:id returns a composite operation", async () => {
    const parent = seedComposite(ctx.deployments, "pending");

    const res = await ctx.app.inject({ method: "GET", url: `/api/operations/${parent.id}` });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.deployment.id).toBe(parent.id);
    expect(body.deployment.input.type).toBe("composite");
  });

  it("records debrief entries for composite execution", async () => {
    const parent = seedComposite(ctx.deployments, "awaiting_approval");

    await ctx.app.inject({
      method: "POST",
      url: `/api/operations/${parent.id}/approve`,
      payload: { approvedBy: "ops@example.com" },
    });

    const entries = ctx.diary.getByOperation(parent.id);
    expect(entries.length).toBeGreaterThan(0);
    const types = entries.map((e) => e.decisionType);
    expect(types).toContain("composite-started");
    expect(types).toContain("composite-completed");
  });
});

// ===========================================================================
// Artifact version routes (coverage for artifacts.ts lines 153-171, 179-192)
// ===========================================================================

describe("Artifact version routes", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  it("POST /api/artifacts/:id/versions adds a version and returns 201", async () => {
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/api/artifacts",
      payload: { name: "my-app", type: "docker-image" },
    });
    expect(createRes.statusCode).toBe(201);
    const artifactId = JSON.parse(createRes.payload).artifact.id;

    const res = await ctx.app.inject({
      method: "POST",
      url: `/api/artifacts/${artifactId}/versions`,
      payload: { version: "1.0.1", source: "docker.io/my-app:1.0.1" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.version).toBeDefined();
    expect(body.version.version).toBe("1.0.1");
  });

  it("POST /api/artifacts/:id/versions returns 404 for unknown artifact", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/artifacts/nonexistent-id/versions",
      payload: { version: "1.0.0", source: "docker.io/my-app:1.0.0" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/artifacts/:id/versions/:versionId returns a specific version", async () => {
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/api/artifacts",
      payload: { name: "my-app", type: "docker-image" },
    });
    const artifactId = JSON.parse(createRes.payload).artifact.id;

    const versionRes = await ctx.app.inject({
      method: "POST",
      url: `/api/artifacts/${artifactId}/versions`,
      payload: { version: "2.0.0", source: "docker.io/my-app:2.0.0" },
    });
    const versionId = JSON.parse(versionRes.payload).version.id;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/artifacts/${artifactId}/versions/${versionId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.version.id).toBe(versionId);
    expect(body.version.version).toBe("2.0.0");
  });

  it("GET /api/artifacts/:id/versions/:versionId returns 404 for unknown artifact", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/artifacts/nonexistent-id/versions/some-version-id",
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/artifacts/:id/versions/:versionId returns 404 for unknown version", async () => {
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/api/artifacts",
      payload: { name: "my-app", type: "docker-image" },
    });
    const artifactId = JSON.parse(createRes.payload).artifact.id;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/api/artifacts/${artifactId}/versions/nonexistent-version-id`,
    });
    expect(res.statusCode).toBe(404);
  });
});
