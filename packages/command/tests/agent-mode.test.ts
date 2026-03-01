import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief, PartitionStore, OperationStore, EnvironmentStore, OrderStore, SettingsStore, LlmClient } from "@deploystack/core";
import type { Deployment, DebriefEntry, LlmResult } from "@deploystack/core";
import { CommandAgent, InMemoryDeploymentStore } from "../src/agent/command-agent.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerOperationRoutes } from "../src/api/operations.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";
import { registerAgentRoutes, conversations, sanitizeUserInput, validateExtractedVersion, validateExtractedVariables, cleanupStaleConversations } from "../src/api/agent.js";

// ---------------------------------------------------------------------------
// Test server setup
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let diary: DecisionDebrief;
let partitions: PartitionStore;
let operations: OperationStore;
let environments: EnvironmentStore;
let deployments: InMemoryDeploymentStore;
let orders: OrderStore;
let settings: SettingsStore;
let agent: CommandAgent;

let operationId: string;
let partitionId: string;
let productionEnvId: string;
let stagingEnvId: string;

beforeAll(async () => {
  diary = new DecisionDebrief();
  partitions = new PartitionStore();
  operations = new OperationStore();
  environments = new EnvironmentStore();
  deployments = new InMemoryDeploymentStore();
  orders = new OrderStore();
  settings = new SettingsStore();
  agent = new CommandAgent(diary, deployments, orders);

  app = Fastify();
  registerDeploymentRoutes(app, agent, partitions, environments, deployments, diary, operations, orders, settings);
  registerOperationRoutes(app, operations, environments);
  registerPartitionRoutes(app, partitions, deployments, diary);
  registerEnvironmentRoutes(app, environments, operations);
  registerAgentRoutes(app, agent, partitions, environments, operations, deployments, diary, settings);

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

  const projRes = await app.inject({
    method: "POST",
    url: "/api/operations",
    payload: { name: "web-app", environmentIds: [productionEnvId, stagingEnvId] },
  });
  operationId = JSON.parse(projRes.payload).operation.id;

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

// ---------------------------------------------------------------------------
// Intent interpretation tests
// ---------------------------------------------------------------------------

describe("Agent mode — intent interpretation", () => {
  it("resolves a fully-specified intent to exact matches", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "Deploy web-app v2.0.0 to production for Acme Corp",
      },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);

    expect(result.ready).toBe(true);
    expect(result.missingFields).toHaveLength(0);
    expect(result.resolved.operationId.value).toBe(operationId);
    expect(result.resolved.operationId.confidence).toBe("exact");
    expect(result.resolved.partitionId.value).toBe(partitionId);
    expect(result.resolved.partitionId.confidence).toBe("exact");
    expect(result.resolved.environmentId.value).toBe(productionEnvId);
    expect(result.resolved.environmentId.confidence).toBe("exact");
    expect(result.resolved.version.value).toBe("2.0.0");
    expect(result.resolved.version.confidence).toBe("exact");
  });

  it("identifies missing fields in a partial intent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "Deploy to production",
      },
    });

    const result = JSON.parse(res.payload);
    expect(result.ready).toBe(false);
    expect(result.missingFields).toContain("version");
    // Operation may be inferred if only one exists
    expect(result.resolved.environmentId.confidence).toBe("exact");
  });

  it("uses partial config to fill gaps", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "Deploy version 3.0.0",
        partialConfig: {
          operationId,
          partitionId,
          environmentId: productionEnvId,
        },
      },
    });

    const result = JSON.parse(res.payload);
    expect(result.ready).toBe(true);
    expect(result.resolved.operationId.value).toBe(operationId);
    expect(result.resolved.version.value).toBe("3.0.0");
  });

  it("extracts variables from intent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: 'Deploy web-app v1.0.0 to production for Acme Corp with FEATURE_FLAG="new-ui"',
      },
    });

    const result = JSON.parse(res.payload);
    expect(result.resolved.variables.FEATURE_FLAG).toBe("new-ui");
  });

  it("returns 400 for empty intent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("matches environment aliases (prod, stg)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v1.0.0 to prod for Acme Corp" },
    });

    const result = JSON.parse(res.payload);
    expect(result.resolved.environmentId.value).toBe(productionEnvId);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v1.0.0 to staging for Acme Corp" },
    });

    const result2 = JSON.parse(res2.payload);
    expect(result2.resolved.environmentId.value).toBe(stagingEnvId);
  });

  it("records intent interpretation to Decision Diary", async () => {
    const beforeCount = diary.getRecent(100).length;

    await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v1.0.0 to production for Acme Corp" },
    });

    const afterCount = diary.getRecent(100).length;
    expect(afterCount).toBeGreaterThan(beforeCount);

    const entries = diary.getRecent(1);
    expect(entries[0].decision).toContain("Intent");
  });
});

// ---------------------------------------------------------------------------
// Deployment context tests
// ---------------------------------------------------------------------------

describe("Agent mode — deployment context", () => {
  it("returns context with signals and environment summary", async () => {
    // Trigger a deployment first to have some data
    await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: { operationId, partitionId, environmentId: productionEnvId, version: "1.0.0" },
    });

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
    expect(prodSummary.lastDeployStatus).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: Identical artifacts test
// ---------------------------------------------------------------------------

describe("Identical artifacts — traditional vs agent mode", () => {
  it("produces the same deployment output regardless of mode", async () => {
    // --- Traditional mode: explicit trigger with all fields ---
    const traditionalRes = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        operationId,
        partitionId,
        environmentId: productionEnvId,
        version: "5.0.0",
        variables: { CACHE_TTL: "3600" },
      },
    });

    expect(traditionalRes.statusCode).toBe(201);
    const traditional = JSON.parse(traditionalRes.payload);
    const traditionalDeploy: Deployment = traditional.deployment;

    // --- Agent mode: interpret intent, then trigger with resolved config ---
    const intentRes = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: 'Deploy web-app v5.0.0 to production for Acme Corp with CACHE_TTL="3600"',
      },
    });

    const intent = JSON.parse(intentRes.payload);
    expect(intent.ready).toBe(true);

    // Use the resolved config to trigger — same endpoint as traditional mode
    const agentRes = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        operationId: intent.resolved.operationId.value,
        partitionId: intent.resolved.partitionId.value,
        environmentId: intent.resolved.environmentId.value,
        version: intent.resolved.version.value,
        variables: intent.resolved.variables,
      },
    });

    expect(agentRes.statusCode).toBe(201);
    const agentDeploy: Deployment = JSON.parse(agentRes.payload).deployment;

    // --- Compare: identical artifacts ---

    // Same trigger inputs
    expect(agentDeploy.operationId).toBe(traditionalDeploy.operationId);
    expect(agentDeploy.partitionId).toBe(traditionalDeploy.partitionId);
    expect(agentDeploy.environmentId).toBe(traditionalDeploy.environmentId);
    expect(agentDeploy.version).toBe(traditionalDeploy.version);

    // Same resolved variables (after merge with partition/environment)
    expect(agentDeploy.variables).toEqual(traditionalDeploy.variables);

    // Same status
    expect(agentDeploy.status).toBe(traditionalDeploy.status);

    // Same diary structure (same number of decision types)
    const traditionalDiary: DebriefEntry[] = traditional.debrief;
    const agentDiary: DebriefEntry[] = JSON.parse(agentRes.payload).debrief;

    const traditionalTypes = traditionalDiary.map((d) => d.decisionType).sort();
    const agentTypes = agentDiary.map((d) => d.decisionType).sort();
    expect(agentTypes).toEqual(traditionalTypes);
  });

  it("mid-configuration switch preserves fields", async () => {
    // Simulate: user starts in agent mode, interprets an intent
    const intentRes = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "Deploy web-app v6.0.0 to staging for Acme Corp",
      },
    });

    const intent = JSON.parse(intentRes.payload);
    expect(intent.ready).toBe(true);

    // User switches to traditional mode — fields should already be populated.
    // They complete the deployment using the traditional endpoint with the same values.
    const traditionalRes = await app.inject({
      method: "POST",
      url: "/api/deployments",
      payload: {
        operationId: intent.resolved.operationId.value,
        partitionId: intent.resolved.partitionId.value,
        environmentId: intent.resolved.environmentId.value,
        version: intent.resolved.version.value,
      },
    });

    expect(traditionalRes.statusCode).toBe(201);
    const deploy = JSON.parse(traditionalRes.payload).deployment;
    expect(deploy.version).toBe("6.0.0");
    expect(deploy.environmentId).toBe(stagingEnvId);
    expect(deploy.status).toBe("succeeded");
  });

  it("traditional config can be refined via agent intent", async () => {
    // Simulate: user partially fills form in traditional mode, then switches to agent
    // The agent receives partial config and intent to fill remaining fields
    const intentRes = await app.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "deploy version 7.0.0 to production",
        partialConfig: {
          operationId,
          partitionId,
        },
      },
    });

    const intent = JSON.parse(intentRes.payload);
    expect(intent.ready).toBe(true);
    expect(intent.resolved.operationId.value).toBe(operationId);
    expect(intent.resolved.partitionId.value).toBe(partitionId);
    expect(intent.resolved.version.value).toBe("7.0.0");
    expect(intent.resolved.environmentId.value).toBe(productionEnvId);
  });
});

// ---------------------------------------------------------------------------
// LLM-powered intent interpretation tests
// ---------------------------------------------------------------------------

describe("Agent mode — LLM intent interpretation", () => {
  let llmApp: FastifyInstance;
  let llmDiary: DecisionDebrief;
  let llmPartitions: PartitionStore;
  let llmOperations: OperationStore;
  let llmEnvironments: EnvironmentStore;
  let llmDeployments: InMemoryDeploymentStore;
  let llmOrders: OrderStore;
  let llmSettings: SettingsStore;
  let llmAgent: CommandAgent;
  let mockLlm: LlmClient;

  let llmOperationId: string;
  let llmPartitionId: string;
  let llmProdEnvId: string;
  let llmStagingEnvId: string;

  // Track what classify() should return
  let classifyResponse: LlmResult;

  beforeAll(async () => {
    llmDiary = new DecisionDebrief();
    llmPartitions = new PartitionStore();
    llmOperations = new OperationStore();
    llmEnvironments = new EnvironmentStore();
    llmDeployments = new InMemoryDeploymentStore();
    llmOrders = new OrderStore();
    llmSettings = new SettingsStore();
    llmAgent = new CommandAgent(llmDiary, llmDeployments, llmOrders);

    // Create a mock LlmClient that returns controlled responses
    mockLlm = new LlmClient(llmDiary, "command", { apiKey: "test-key" });

    // Override classify to return our controlled response
    mockLlm.classify = async () => classifyResponse;
    // Override isAvailable to always return true for LLM tests
    mockLlm.isAvailable = () => true;

    llmApp = Fastify();
    registerDeploymentRoutes(llmApp, llmAgent, llmPartitions, llmEnvironments, llmDeployments, llmDiary, llmOperations, llmOrders, llmSettings);
    registerOperationRoutes(llmApp, llmOperations, llmEnvironments);
    registerPartitionRoutes(llmApp, llmPartitions, llmDeployments, llmDiary);
    registerEnvironmentRoutes(llmApp, llmEnvironments, llmOperations);
    registerAgentRoutes(llmApp, llmAgent, llmPartitions, llmEnvironments, llmOperations, llmDeployments, llmDiary, llmSettings, mockLlm);

    await llmApp.ready();

    // Seed test data
    const envRes = await llmApp.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "production", variables: { APP_ENV: "production" } },
    });
    llmProdEnvId = JSON.parse(envRes.payload).environment.id;

    const stagingRes = await llmApp.inject({
      method: "POST",
      url: "/api/environments",
      payload: { name: "staging", variables: { APP_ENV: "staging" } },
    });
    llmStagingEnvId = JSON.parse(stagingRes.payload).environment.id;

    const projRes = await llmApp.inject({
      method: "POST",
      url: "/api/operations",
      payload: { name: "web-app", environmentIds: [llmProdEnvId, llmStagingEnvId] },
    });
    llmOperationId = JSON.parse(projRes.payload).operation.id;

    const partRes = await llmApp.inject({
      method: "POST",
      url: "/api/partitions",
      payload: { name: "Acme Corp" },
    });
    llmPartitionId = JSON.parse(partRes.payload).partition.id;
  });

  beforeEach(() => {
    conversations.clear();
  });

  it("uses LLM response when available and valid", async () => {
    classifyResponse = {
      ok: true,
      text: JSON.stringify({
        operationId: { name: "web-app", confidence: "exact", matchedFrom: "web-app mentioned in intent" },
        partitionId: { name: "Acme Corp", confidence: "exact", matchedFrom: "Acme Corp mentioned in intent" },
        environmentId: { name: "production", confidence: "exact", matchedFrom: "production mentioned in intent" },
        version: { value: "2.0.0", confidence: "exact", matchedFrom: "v2.0.0 in intent" },
        variables: { FEATURE: "enabled" },
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 150,
    };

    const res = await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v2.0.0 to production for Acme Corp" },
    });

    const result = JSON.parse(res.payload);
    expect(result.ready).toBe(true);
    expect(result.resolved.operationId.value).toBe(llmOperationId);
    expect(result.resolved.operationId.confidence).toBe("exact");
    expect(result.resolved.version.value).toBe("2.0.0");
    expect(result.resolved.variables.FEATURE).toBe("enabled");
  });

  it("falls back to regex when LLM returns invalid JSON", async () => {
    classifyResponse = {
      ok: true,
      text: "This is not valid JSON at all",
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 100,
    };

    const res = await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v3.0.0 to production for Acme Corp" },
    });

    const result = JSON.parse(res.payload);
    // Should still work via regex fallback
    expect(result.ready).toBe(true);
    expect(result.resolved.operationId.value).toBe(llmOperationId);
    expect(result.resolved.version.value).toBe("3.0.0");
  });

  it("falls back to regex when LLM returns hallucinated names", async () => {
    classifyResponse = {
      ok: true,
      text: JSON.stringify({
        operationId: { name: "fake-nonexistent-operation", confidence: "exact", matchedFrom: "hallucinated" },
        partitionId: { name: "Acme Corp", confidence: "exact", matchedFrom: "Acme Corp" },
        environmentId: { name: "production", confidence: "exact", matchedFrom: "production" },
        version: { value: "1.0.0", confidence: "exact", matchedFrom: "v1.0.0" },
        variables: {},
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 100,
    };

    const res = await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v1.0.0 to production for Acme Corp" },
    });

    const result = JSON.parse(res.payload);
    // Should fall back to regex — regex can still resolve this intent
    expect(result.ready).toBe(true);
    expect(result.resolved.operationId.value).toBe(llmOperationId);
  });

  it("falls back to regex when LLM call fails", async () => {
    classifyResponse = {
      ok: false,
      fallback: true,
      reason: "LLM not configured — DEPLOYSTACK_LLM_API_KEY not set",
    };

    const res = await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v4.0.0 to production for Acme Corp" },
    });

    const result = JSON.parse(res.payload);
    expect(result.ready).toBe(true);
    expect(result.resolved.version.value).toBe("4.0.0");
  });

  it("surfaces disambiguation warnings in uiUpdates", async () => {
    classifyResponse = {
      ok: true,
      text: JSON.stringify({
        operationId: { name: "web-app", confidence: "exact", matchedFrom: "web-app" },
        partitionId: { name: "Acme Corp", confidence: "exact", matchedFrom: "Acme Corp" },
        environmentId: { name: "production", confidence: "inferred", matchedFrom: "inferred from context" },
        version: { value: "1.0.0", confidence: "exact", matchedFrom: "v1.0.0" },
        variables: {},
        disambiguation: [
          {
            field: "environmentId",
            candidates: [
              { name: "production", reason: "most likely target" },
              { name: "staging", reason: "also possible" },
            ],
          },
        ],
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 200,
    };

    const res = await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v1.0.0 for Acme Corp" },
    });

    const result = JSON.parse(res.payload);
    const warnUpdate = result.uiUpdates.find(
      (u: any) => u.field === "environmentId" && u.action === "warn",
    );
    expect(warnUpdate).toBeDefined();
    expect(warnUpdate.message).toContain("Multiple matches");
    expect(warnUpdate.message).toContain("production");
    expect(warnUpdate.message).toContain("staging");
  });

  it("supports conversational follow-up intents", async () => {
    const conversationId = "test-conv-1";

    // First intent — fully resolved
    classifyResponse = {
      ok: true,
      text: JSON.stringify({
        operationId: { name: "web-app", confidence: "exact", matchedFrom: "web-app" },
        partitionId: { name: "Acme Corp", confidence: "exact", matchedFrom: "Acme Corp" },
        environmentId: { name: "production", confidence: "exact", matchedFrom: "production" },
        version: { value: "1.0.0", confidence: "exact", matchedFrom: "v1.0.0" },
        variables: {},
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 100,
    };

    await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "Deploy web-app v1.0.0 to production for Acme Corp",
        conversationId,
      },
    });

    // Second intent — follow-up, switching environment
    classifyResponse = {
      ok: true,
      text: JSON.stringify({
        operationId: { name: "web-app", confidence: "inferred", matchedFrom: "carried from previous intent" },
        partitionId: { name: "Acme Corp", confidence: "inferred", matchedFrom: "carried from previous intent" },
        environmentId: { name: "staging", confidence: "exact", matchedFrom: "staging mentioned in follow-up" },
        version: { value: "1.0.0", confidence: "inferred", matchedFrom: "carried from previous intent" },
        variables: {},
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 80,
    };

    const res = await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: {
        intent: "same thing but for staging",
        conversationId,
      },
    });

    const result = JSON.parse(res.payload);
    expect(result.ready).toBe(true);
    expect(result.resolved.operationId.value).toBe(llmOperationId);
    expect(result.resolved.environmentId.value).toBe(llmStagingEnvId);
    expect(result.resolved.version.value).toBe("1.0.0");
  });

  it("records method in debrief context", async () => {
    classifyResponse = {
      ok: true,
      text: JSON.stringify({
        operationId: { name: "web-app", confidence: "exact", matchedFrom: "web-app" },
        partitionId: { name: "Acme Corp", confidence: "exact", matchedFrom: "Acme" },
        environmentId: { name: "production", confidence: "exact", matchedFrom: "prod" },
        version: { value: "9.0.0", confidence: "exact", matchedFrom: "v9.0.0" },
        variables: {},
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 50,
    };

    // Snapshot existing entry IDs before the request so we can identify
    // exactly which new entry was created — avoids timestamp-collision
    // ambiguity when multiple entries share the same millisecond.
    const existingIds = new Set(llmDiary.getRecent(200).map((e) => e.id));

    await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v9.0.0 to prod for Acme Corp" },
    });

    const allEntries = llmDiary.getRecent(200);
    const newEntries = allEntries.filter((e) => !existingIds.has(e.id));
    const systemEntry = newEntries.find(
      (e) => e.decisionType === "system" && e.decision.includes("Intent"),
    );
    expect(systemEntry).toBeDefined();
    expect(systemEntry!.context.method).toBe("llm");
  });

  it("handles LLM response wrapped in markdown code fences", async () => {
    classifyResponse = {
      ok: true,
      text: '```json\n' + JSON.stringify({
        operationId: { name: "web-app", confidence: "exact", matchedFrom: "web-app" },
        partitionId: { name: "Acme Corp", confidence: "exact", matchedFrom: "Acme" },
        environmentId: { name: "production", confidence: "exact", matchedFrom: "prod" },
        version: { value: "5.0.0", confidence: "exact", matchedFrom: "v5.0.0" },
        variables: {},
      }) + '\n```',
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 100,
    };

    const res = await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy web-app v5.0.0 to prod for Acme Corp" },
    });

    const result = JSON.parse(res.payload);
    expect(result.ready).toBe(true);
    expect(result.resolved.version.value).toBe("5.0.0");
  });

  it("validates environment-operation linking after LLM extraction", async () => {
    // Create a second operation with only staging linked
    const proj2Res = await llmApp.inject({
      method: "POST",
      url: "/api/operations",
      payload: { name: "api-service", environmentIds: [llmStagingEnvId] },
    });
    const proj2Id = JSON.parse(proj2Res.payload).operation.id;

    // LLM resolves to api-service + production (which is NOT linked)
    classifyResponse = {
      ok: true,
      text: JSON.stringify({
        operationId: { name: "api-service", confidence: "exact", matchedFrom: "api-service" },
        partitionId: { name: "Acme Corp", confidence: "exact", matchedFrom: "Acme" },
        environmentId: { name: "production", confidence: "exact", matchedFrom: "production" },
        version: { value: "1.0.0", confidence: "exact", matchedFrom: "v1.0.0" },
        variables: {},
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 100,
    };

    const res = await llmApp.inject({
      method: "POST",
      url: "/api/agent/interpret-intent",
      payload: { intent: "Deploy api-service v1.0.0 to production for Acme Corp" },
    });

    const result = JSON.parse(res.payload);
    expect(result.ready).toBe(false);
    expect(result.missingFields).toContain("environmentId");
    const warnUpdate = result.uiUpdates.find(
      (u: any) => u.field === "environmentId" && u.action === "warn",
    );
    expect(warnUpdate).toBeDefined();
    expect(warnUpdate.message).toContain("not linked to operation");
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

describe("Agent mode — conversation cleanup", () => {
  it("removes conversations where all entries are expired", () => {
    conversations.clear();

    const staleId = "stale-convo-1";
    conversations.set(staleId, [
      { intent: "old intent", resolved: { operationId: { value: "", confidence: "missing" }, partitionId: { value: "", confidence: "missing" }, environmentId: { value: "", confidence: "missing" }, version: { value: "", confidence: "missing" }, variables: {} }, timestamp: Date.now() - 31 * 60 * 1000 },
    ]);

    const freshId = "fresh-convo-1";
    conversations.set(freshId, [
      { intent: "recent intent", resolved: { operationId: { value: "", confidence: "missing" }, partitionId: { value: "", confidence: "missing" }, environmentId: { value: "", confidence: "missing" }, version: { value: "", confidence: "missing" }, variables: {} }, timestamp: Date.now() },
    ]);

    const removed = cleanupStaleConversations();

    expect(removed).toBe(1);
    expect(conversations.has(staleId)).toBe(false);
    expect(conversations.has(freshId)).toBe(true);

    conversations.clear();
  });

  it("keeps conversations with at least one non-expired entry", () => {
    conversations.clear();

    const mixedId = "mixed-convo";
    conversations.set(mixedId, [
      { intent: "old", resolved: { operationId: { value: "", confidence: "missing" }, partitionId: { value: "", confidence: "missing" }, environmentId: { value: "", confidence: "missing" }, version: { value: "", confidence: "missing" }, variables: {} }, timestamp: Date.now() - 31 * 60 * 1000 },
      { intent: "recent", resolved: { operationId: { value: "", confidence: "missing" }, partitionId: { value: "", confidence: "missing" }, environmentId: { value: "", confidence: "missing" }, version: { value: "", confidence: "missing" }, variables: {} }, timestamp: Date.now() },
    ]);

    const removed = cleanupStaleConversations();

    expect(removed).toBe(0);
    expect(conversations.has(mixedId)).toBe(true);

    conversations.clear();
  });
});

// ---------------------------------------------------------------------------
// LLM-powered query classification tests
// ---------------------------------------------------------------------------

describe("Agent mode — LLM query classification", () => {
  let qApp: FastifyInstance;
  let qDiary: DecisionDebrief;
  let qPartitions: PartitionStore;
  let qOperations: OperationStore;
  let qEnvironments: EnvironmentStore;
  let qDeployments: InMemoryDeploymentStore;
  let qOrders: OrderStore;
  let qSettings: SettingsStore;
  let qAgent: CommandAgent;
  let qMockLlm: LlmClient;

  let qOperationId: string;
  let qPartitionId: string;
  let qProdEnvId: string;
  let qStagingEnvId: string;

  // Track what classify() should return for query classification
  let qClassifyResponse: LlmResult;

  beforeAll(async () => {
    qDiary = new DecisionDebrief();
    qPartitions = new PartitionStore();
    qOperations = new OperationStore();
    qEnvironments = new EnvironmentStore();
    qDeployments = new InMemoryDeploymentStore();
    qOrders = new OrderStore();
    qSettings = new SettingsStore();
    qAgent = new CommandAgent(qDiary, qDeployments, qOrders);

    qMockLlm = new LlmClient(qDiary, "command", { apiKey: "test-key" });
    qMockLlm.classify = async () => qClassifyResponse;
    qMockLlm.isAvailable = () => true;

    qApp = Fastify();
    registerDeploymentRoutes(qApp, qAgent, qPartitions, qEnvironments, qDeployments, qDiary, qOperations, qOrders, qSettings);
    registerOperationRoutes(qApp, qOperations, qEnvironments);
    registerPartitionRoutes(qApp, qPartitions, qDeployments, qDiary);
    registerEnvironmentRoutes(qApp, qEnvironments, qOperations);
    registerAgentRoutes(qApp, qAgent, qPartitions, qEnvironments, qOperations, qDeployments, qDiary, qSettings, qMockLlm);

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

    const projRes = await qApp.inject({
      method: "POST",
      url: "/api/operations",
      payload: { name: "web-app", environmentIds: [qProdEnvId, qStagingEnvId] },
    });
    qOperationId = JSON.parse(projRes.payload).operation.id;

    const partRes = await qApp.inject({
      method: "POST",
      url: "/api/partitions",
      payload: { name: "Acme Corp" },
    });
    qPartitionId = JSON.parse(partRes.payload).partition.id;

    // Create a deployment so data queries have something to find
    await qApp.inject({
      method: "POST",
      url: "/api/deployments",
      payload: { operationId: qOperationId, partitionId: qPartitionId, environmentId: qProdEnvId, version: "1.0.0" },
    });
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

  it("deploy action: resolves 'deploy web-app' to deployment-authoring", async () => {
    qClassifyResponse = {
      ok: true,
      text: JSON.stringify({
        action: "deploy",
        view: "deployment-authoring",
        params: { intent: "deploy web-app" },
        title: "Deploy web-app",
      }),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 70,
    };

    const res = await qApp.inject({
      method: "POST",
      url: "/api/agent/query",
      payload: { query: "deploy web-app" },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    expect(result.action).toBe("deploy");
    expect(result.view).toBe("deployment-authoring");
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
      payload: { query: "deploy web-app" },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    // Regex fallback detects "deploy" keyword
    expect(result.action).toBe("deploy");
    expect(result.view).toBe("deployment-authoring");
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
