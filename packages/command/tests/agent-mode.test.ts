import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief, PartitionStore, EnvironmentStore, ArtifactStore, SettingsStore, TelemetryStore, LlmClient } from "@synth-deploy/core";
import type { LlmResult } from "@synth-deploy/core";
import { CommandAgent, InMemoryDeploymentStore } from "../src/agent/command-agent.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";
import { registerArtifactRoutes } from "../src/api/artifacts.js";
import { registerAgentRoutes, sanitizeUserInput, validateExtractedVersion, validateExtractedVariables } from "../src/api/agent.js";
import { registerSettingsRoutes } from "../src/api/settings.js";

// ---------------------------------------------------------------------------
// Mock auth — inject a test user with all permissions on every request
// ---------------------------------------------------------------------------

function addMockAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (request) => {
    request.user = {
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
// Test server setup
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let diary: DecisionDebrief;
let partitions: PartitionStore;
let environments: EnvironmentStore;
let deployments: InMemoryDeploymentStore;
let artifactStore: ArtifactStore;
let settings: SettingsStore;
let telemetry: TelemetryStore;
let agent: CommandAgent;

let artifactId: string;
let partitionId: string;
let productionEnvId: string;
let stagingEnvId: string;

beforeAll(async () => {
  diary = new DecisionDebrief();
  partitions = new PartitionStore();
  environments = new EnvironmentStore();
  deployments = new InMemoryDeploymentStore();
  artifactStore = new ArtifactStore();
  settings = new SettingsStore();
  telemetry = new TelemetryStore();
  agent = new CommandAgent(
    diary, deployments, artifactStore, environments, partitions,
    undefined, { healthCheckBackoffMs: 1, executionDelayMs: 1 },
  );

  app = Fastify();
  addMockAuth(app);
  registerDeploymentRoutes(app, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
  registerPartitionRoutes(app, partitions, deployments, diary, telemetry);
  registerEnvironmentRoutes(app, environments, deployments, telemetry);
  registerArtifactRoutes(app, artifactStore, telemetry);
  registerSettingsRoutes(app, settings, telemetry);
  registerAgentRoutes(app, agent, partitions, environments, artifactStore, deployments, diary, settings);

  await app.ready();

  // Seed test data
  const envRes = await app.inject({
    method: "POST",
    url: "/api/environments",
    payload: { name: "production", variables: { APP_ENV: "production", LOG_LEVEL: "warn" } },
  });
  productionEnvId = JSON.parse(envRes.payload).environment.id;

  const stagingRes = await app.inject({
    method: "POST",
    url: "/api/environments",
    payload: { name: "staging", variables: { APP_ENV: "staging", LOG_LEVEL: "debug" } },
  });
  stagingEnvId = JSON.parse(stagingRes.payload).environment.id;

  const artifactRes = await app.inject({
    method: "POST",
    url: "/api/artifacts",
    payload: { name: "web-app", type: "nodejs" },
  });
  artifactId = JSON.parse(artifactRes.payload).artifact.id;

  const partitionRes = await app.inject({
    method: "POST",
    url: "/api/partitions",
    payload: { name: "Acme Corp" },
  });
  partitionId = JSON.parse(partitionRes.payload).partition.id;

  await app.inject({
    method: "PUT",
    url: `/api/partitions/${partitionId}/variables`,
    payload: { variables: { DB_HOST: "acme-db-1", APP_ENV: "production" } },
  });
});

/**
 * Helper: creates a deployment via the new artifact-based API.
 */
async function deployViaHttp(
  server: FastifyInstance,
  params: { artifactId: string; partitionId?: string; environmentId: string; version?: string; variables?: Record<string, string> },
) {
  return server.inject({
    method: "POST",
    url: "/api/deployments",
    payload: {
      artifactId: params.artifactId,
      environmentId: params.environmentId,
      partitionId: params.partitionId,
      version: params.version,
    },
  });
}

// ---------------------------------------------------------------------------
// Deployment context tests
// ---------------------------------------------------------------------------

describe("Agent mode — deployment context", () => {
  it("returns context with signals and environment summary", async () => {
    // Trigger a deployment first to have some data
    await deployViaHttp(app, { artifactId, partitionId, environmentId: productionEnvId, version: "1.0.0" });

    const res = await app.inject({ method: "GET", url: "/api/agent/context" });

    expect(res.statusCode).toBe(200);
    const context = JSON.parse(res.payload);

    expect(context.recentActivity).toBeDefined();
    expect(context.recentActivity.deploymentsLast24h).toBeGreaterThanOrEqual(1);
    expect(context.recentActivity.successRate).toBeDefined();
    expect(context.environmentSummary).toBeDefined();
    expect(context.environmentSummary.length).toBeGreaterThanOrEqual(2);
    expect(context.signals).toBeDefined();
  });

  it("environment summary reflects deployment status", async () => {
    const res = await app.inject({ method: "GET", url: "/api/agent/context" });
    const context = JSON.parse(res.payload);

    const prodSummary = context.environmentSummary.find((e: any) => e.name === "production");
    expect(prodSummary).toBeDefined();
    expect(prodSummary.deployCount).toBeGreaterThanOrEqual(1);
  });
});


// ---------------------------------------------------------------------------
// Input sanitization tests
// ---------------------------------------------------------------------------

describe("Agent mode — input sanitization", () => {
  it("strips control characters from intent", () => {
    const input = "Deploy\x01\x02\x03\x07 web-app\x0B\x0C\x0E v1.0.0";
    const result = sanitizeUserInput(input);
    // Control characters should be removed
    expect(result).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    // Printable content should remain
    expect(result).toContain("Deploy");
    expect(result).toContain("web-app");
    expect(result).toContain("v1.0.0");
  });

  it("truncates long inputs to 1000 characters", () => {
    const longInput = "a".repeat(2000);
    const result = sanitizeUserInput(longInput);
    expect(result.length).toBe(1000);
  });

  it("escapes XML tags in user input", () => {
    const input = "<script>alert('xss')</script>";
    const result = sanitizeUserInput(input);
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("</script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&lt;/script&gt;");
  });

  it("validates semver version format", () => {
    // Valid formats
    expect(validateExtractedVersion("1.2.3")).toBe(true);
    expect(validateExtractedVersion("1.2.3-beta.1")).toBe(true);
    expect(validateExtractedVersion("0.0.1")).toBe(true);
    expect(validateExtractedVersion("10.20.30-alpha")).toBe(true);

    // Invalid formats
    expect(validateExtractedVersion("not-a-version")).toBe(false);
    expect(validateExtractedVersion("1.2")).toBe(false);
    expect(validateExtractedVersion("../../../etc/passwd")).toBe(false);
    expect(validateExtractedVersion("v1.2.3")).toBe(false);
    expect(validateExtractedVersion("")).toBe(false);
  });

  it("validates variable key format", () => {
    // Valid keys
    const valid = validateExtractedVariables({ APP_ENV: "production", DB_HOST: "localhost" });
    expect(valid).toHaveProperty("APP_ENV", "production");
    expect(valid).toHaveProperty("DB_HOST", "localhost");

    // Invalid keys should be excluded
    const invalid = validateExtractedVariables({
      "../../path": "value",
      "key with spaces": "value",
      "": "value",
      "123invalid": "value",
    });
    expect(Object.keys(invalid)).toHaveLength(0);
  });

  it("rejects variables with values exceeding 500 chars", () => {
    const longValue = "x".repeat(600);
    const result = validateExtractedVariables({ VALID_KEY: longValue, SHORT_KEY: "ok" });
    expect(result).not.toHaveProperty("VALID_KEY");
    expect(result).toHaveProperty("SHORT_KEY", "ok");
  });
});


// ---------------------------------------------------------------------------
// LLM-powered query classification tests
// ---------------------------------------------------------------------------

describe("Agent mode — LLM query classification", () => {
  let qApp: FastifyInstance;
  let qDiary: DecisionDebrief;
  let qPartitions: PartitionStore;
  let qEnvironments: EnvironmentStore;
  let qDeployments: InMemoryDeploymentStore;
  let qArtifactStore: ArtifactStore;
  let qSettings: SettingsStore;
  let qTelemetry: TelemetryStore;
  let qAgent: CommandAgent;
  let qMockLlm: LlmClient;

  let qArtifactId: string;
  let qPartitionId: string;
  let qProdEnvId: string;
  let qStagingEnvId: string;

  // Track what classify() should return for query classification
  let qClassifyResponse: LlmResult;

  beforeAll(async () => {
    qDiary = new DecisionDebrief();
    qPartitions = new PartitionStore();
    qEnvironments = new EnvironmentStore();
    qDeployments = new InMemoryDeploymentStore();
    qArtifactStore = new ArtifactStore();
    qSettings = new SettingsStore();
    qTelemetry = new TelemetryStore();
    qAgent = new CommandAgent(
      qDiary, qDeployments, qArtifactStore, qEnvironments, qPartitions,
      undefined, { healthCheckBackoffMs: 1, executionDelayMs: 1 },
    );

    qMockLlm = new LlmClient(qDiary, "command", { apiKey: "test-key" });
    qMockLlm.classify = async () => qClassifyResponse;
    qMockLlm.isAvailable = () => true;

    qApp = Fastify();
    addMockAuth(qApp);
    registerDeploymentRoutes(qApp, qDeployments, qDiary, qPartitions, qEnvironments, qArtifactStore, qSettings, qTelemetry);
    registerPartitionRoutes(qApp, qPartitions, qDeployments, qDiary, qTelemetry);
    registerEnvironmentRoutes(qApp, qEnvironments, qDeployments, qTelemetry);
    registerArtifactRoutes(qApp, qArtifactStore, qTelemetry);
    registerSettingsRoutes(qApp, qSettings, qTelemetry);
    registerAgentRoutes(qApp, qAgent, qPartitions, qEnvironments, qArtifactStore, qDeployments, qDiary, qSettings, qMockLlm);

    await qApp.ready();

    // Seed test data
    const envRes = await qApp.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "production", variables: { APP_ENV: "production" } },
    });
    qProdEnvId = JSON.parse(envRes.payload).environment.id;

    const stagingRes = await qApp.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "staging", variables: { APP_ENV: "staging" } },
    });
    qStagingEnvId = JSON.parse(stagingRes.payload).environment.id;

    const artifactRes = await qApp.inject({
      method: "POST",
      url: "/api/artifacts",
      payload: { name: "web-app", type: "nodejs" },
    });
    qArtifactId = JSON.parse(artifactRes.payload).artifact.id;

    const partRes = await qApp.inject({
      method: "POST",
      url: "/api/partitions",
      payload: { name: "Acme Corp" },
    });
    qPartitionId = JSON.parse(partRes.payload).partition.id;

    // Create a deployment so data queries have something to find
    await deployViaHttp(qApp, { artifactId: qArtifactId, partitionId: qPartitionId, environmentId: qProdEnvId, version: "1.0.0" });
  });

  it("navigate action: resolves 'show partition Acme Corp' to partition-detail", async () => {
    qClassifyResponse = {
      ok: true,
      text: JSON.stringify({
        action: "navigate",
        view: "partition-detail",
        params: { id: "Acme Corp" },
        title: "Acme Corp",
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 80,
    };

    const res = await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "show partition Acme Corp" },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    expect(result.action).toBe("navigate");
    expect(result.view).toBe("partition-detail");
    expect(result.params.id).toBe(qPartitionId);
  });

  it("data action: resolves 'recent deployments' to deployment-list", async () => {
    qClassifyResponse = {
      ok: true,
      text: JSON.stringify({
        action: "data",
        view: "deployment-list",
        params: {},
        title: "Recent Deployments",
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 60,
    };

    const res = await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "recent deployments" },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    expect(result.action).toBe("data");
    expect(result.view).toBe("deployment-list");
  });

  it("create action: returns create intent for UI confirmation", async () => {
    qClassifyResponse = {
      ok: true,
      text: JSON.stringify({
        action: "create",
        view: "partition-list",
        params: { name: "New Corp" },
        title: "Create Partition",
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 90,
    };

    const res = await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "create partition New Corp" },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    // After #63, create actions are returned as-is for UI confirmation
    expect(result.action).toBe("create");
    expect(result.view).toBe("partition-list");
    expect(result.params.name).toBe("New Corp");
  });

  it("falls back to regex when LLM returns invalid JSON", async () => {
    qClassifyResponse = {
      ok: true,
      text: "This is not valid JSON, just random text",
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 100,
    };

    const res = await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "show partition Acme Corp" },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    // Regex fallback should still classify the query — it matches partition name + "show"
    expect(result.action).toBe("navigate");
    expect(result.view).toBe("partition-detail");
    expect(result.params.id).toBe(qPartitionId);
  });

  it("falls back to regex when LLM returns hallucinated entity names", async () => {
    qClassifyResponse = {
      ok: true,
      text: JSON.stringify({
        action: "navigate",
        view: "partition-detail",
        params: { id: "Nonexistent Partition" },
        title: "Nonexistent Partition",
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 90,
    };

    const res = await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "show partition Acme Corp" },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    // classifyQueryWithLlm validates the partition name and returns null for unknown names,
    // causing fallback to regex which finds "Acme Corp" in the query
    expect(result.action).toBe("navigate");
    expect(result.view).toBe("partition-detail");
    expect(result.params.id).toBe(qPartitionId);
  });

  it("falls back to regex when LLM call fails", async () => {
    qClassifyResponse = {
      ok: false,
      fallback: true,
      reason: "LLM rate limit exceeded (20 calls/min)",
    };

    const res = await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "show all deployments" },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    // Regex fallback detects "deployments" keyword
    expect(result.action).toBe("navigate");
    expect(result.view).toBe("deployment-list");
  });

  it("records debrief entry for LLM-classified queries", async () => {
    const existingIds = new Set(qDiary.getRecent(200).map((e) => e.id));

    qClassifyResponse = {
      ok: true,
      text: JSON.stringify({
        action: "data",
        view: "deployment-list",
        params: {},
        title: "Deployments",
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 50,
    };

    await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "show all deployments" },
    });

    const allEntries = qDiary.getRecent(200);
    const newEntries = allEntries.filter((e) => !existingIds.has(e.id));
    const queryEntry = newEntries.find(
      (e) => e.decisionType === "system" && e.decision.includes("Canvas query"),
    );
    expect(queryEntry).toBeDefined();
    expect(queryEntry!.decision).toContain("data");
    expect(queryEntry!.decision).toContain("deployment-list");
  });

  it("returns 400 for empty query", async () => {
    const res = await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("handles LLM response missing action field by falling back to regex", async () => {
    qClassifyResponse = {
      ok: true,
      text: JSON.stringify({
        view: "deployment-list",
        params: {},
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 100,
    };

    const res = await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "recent deployments" },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    // Missing action field → classifyQueryWithLlm returns null → regex fallback
    // "deployments" matches the deployment list pattern
    expect(result.view).toBe("deployment-list");
  });
});
