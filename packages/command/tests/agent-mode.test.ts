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
import { registerAgentRoutes, conversations } from "../src/api/agent.js";

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
        operationId: { id: llmOperationId, confidence: "exact", matchedFrom: "web-app mentioned in intent" },
        partitionId: { id: llmPartitionId, confidence: "exact", matchedFrom: "Acme Corp mentioned in intent" },
        environmentId: { id: llmProdEnvId, confidence: "exact", matchedFrom: "production mentioned in intent" },
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

  it("falls back to regex when LLM returns hallucinated IDs", async () => {
    classifyResponse = {
      ok: true,
      text: JSON.stringify({
        operationId: { id: "fake-operation-id", confidence: "exact", matchedFrom: "hallucinated" },
        partitionId: { id: llmPartitionId, confidence: "exact", matchedFrom: "Acme Corp" },
        environmentId: { id: llmProdEnvId, confidence: "exact", matchedFrom: "production" },
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
        operationId: { id: llmOperationId, confidence: "exact", matchedFrom: "web-app" },
        partitionId: { id: llmPartitionId, confidence: "exact", matchedFrom: "Acme Corp" },
        environmentId: { id: llmProdEnvId, confidence: "inferred", matchedFrom: "inferred from context" },
        version: { value: "1.0.0", confidence: "exact", matchedFrom: "v1.0.0" },
        variables: {},
        disambiguation: [
          {
            field: "environmentId",
            candidates: [
              { id: llmProdEnvId, name: "production", reason: "most likely target" },
              { id: llmStagingEnvId, name: "staging", reason: "also possible" },
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
        operationId: { id: llmOperationId, confidence: "exact", matchedFrom: "web-app" },
        partitionId: { id: llmPartitionId, confidence: "exact", matchedFrom: "Acme Corp" },
        environmentId: { id: llmProdEnvId, confidence: "exact", matchedFrom: "production" },
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
        operationId: { id: llmOperationId, confidence: "inferred", matchedFrom: "carried from previous intent" },
        partitionId: { id: llmPartitionId, confidence: "inferred", matchedFrom: "carried from previous intent" },
        environmentId: { id: llmStagingEnvId, confidence: "exact", matchedFrom: "staging mentioned in follow-up" },
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
        operationId: { id: llmOperationId, confidence: "exact", matchedFrom: "web-app" },
        partitionId: { id: llmPartitionId, confidence: "exact", matchedFrom: "Acme" },
        environmentId: { id: llmProdEnvId, confidence: "exact", matchedFrom: "prod" },
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
        operationId: { id: llmOperationId, confidence: "exact", matchedFrom: "web-app" },
        partitionId: { id: llmPartitionId, confidence: "exact", matchedFrom: "Acme" },
        environmentId: { id: llmProdEnvId, confidence: "exact", matchedFrom: "prod" },
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
        operationId: { id: proj2Id, confidence: "exact", matchedFrom: "api-service" },
        partitionId: { id: llmPartitionId, confidence: "exact", matchedFrom: "Acme" },
        environmentId: { id: llmProdEnvId, confidence: "exact", matchedFrom: "production" },
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
