import { describe, it, expect, beforeEach } from "vitest";
import { DecisionDebrief } from "../src/debrief.js";
import { LlmClient } from "../src/llm-client.js";
import type { LlmCallParams } from "../src/llm-client.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<LlmCallParams> = {}): LlmCallParams {
  return {
    prompt: "Test prompt",
    systemPrompt: "You are a test assistant.",
    promptSummary: "Test operation",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Client initialization
// ---------------------------------------------------------------------------

describe("LlmClient — initialization", () => {
  it("isAvailable returns false when no API key is provided", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", { apiKey: undefined });
    expect(client.isAvailable()).toBe(false);
  });

  it("isAvailable returns false when API key is empty string", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", { apiKey: "" });
    expect(client.isAvailable()).toBe(false);
  });

  it("isAvailable returns true when API key is provided", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", { apiKey: "sk-test-key" });
    expect(client.isAvailable()).toBe(true);
  });

  it("accepts custom model configuration", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", {
      apiKey: "sk-test",
      reasoningModel: "custom-model",
      classificationModel: "custom-classifier",
    });
    expect(client.isAvailable()).toBe(true);
  });

  it("accepts both server and tentacle agent types", () => {
    const debrief = new DecisionDebrief();
    const serverClient = new LlmClient(debrief, "server");
    const tentacleClient = new LlmClient(debrief, "tentacle");
    expect(serverClient).toBeDefined();
    expect(tentacleClient).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fallback behavior (no API key)
// ---------------------------------------------------------------------------

describe("LlmClient — fallback behavior", () => {
  let debrief: DecisionDebrief;
  let client: LlmClient;

  beforeEach(() => {
    debrief = new DecisionDebrief();
    client = new LlmClient(debrief, "server", { apiKey: undefined });
  });

  it("reason() returns fallback result when no API key", async () => {
    const result = await client.reason(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toContain("not configured");
    }
  });

  it("classify() returns fallback result when no API key", async () => {
    const result = await client.classify(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toContain("not configured");
    }
  });

  it("fallback does not throw exceptions", async () => {
    const reasonResult = await client.reason(makeParams());
    const classifyResult = await client.classify(makeParams());
    expect(reasonResult.ok).toBe(false);
    expect(classifyResult.ok).toBe(false);
  });

  it("system is fully functional without API key — returns usable result", async () => {
    const result = await client.reason(
      makeParams({
        promptSummary: "Risk assessment for deployment",
        tenantId: "tenant-1",
        deploymentId: "deploy-1",
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Debrief recording
// ---------------------------------------------------------------------------

describe("LlmClient — debrief recording", () => {
  it("records debrief entry for fallback calls", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", { apiKey: undefined });

    await client.reason(
      makeParams({
        promptSummary: "Postmortem generation",
        tenantId: "tenant-1",
        deploymentId: "deploy-1",
      }),
    );

    const entries = debrief.getByType("llm-call");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.decisionType).toBe("llm-call");
    expect(entry.agent).toBe("server");
    expect(entry.tenantId).toBe("tenant-1");
    expect(entry.deploymentId).toBe("deploy-1");
    expect(entry.decision).toContain("Postmortem generation");
    expect(entry.decision).toContain("falling back");
    expect(entry.context.fallbackUsed).toBe(true);
    expect(entry.context.promptSummary).toBe("Postmortem generation");
  });

  it("records debrief entry with correct agent type", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "tentacle", { apiKey: undefined });

    await client.classify(makeParams({ promptSummary: "Error classification" }));

    const entries = debrief.getByType("llm-call");
    expect(entries[0].agent).toBe("tentacle");
  });

  it("debrief entry contains model information", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", { apiKey: undefined });

    await client.reason(makeParams());

    const entries = debrief.getByType("llm-call");
    expect(entries[0].context.model).toBeDefined();
    expect(typeof entries[0].context.model).toBe("string");
  });

  it("records separate entries for each call", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", { apiKey: undefined });

    await client.reason(makeParams({ promptSummary: "Call 1" }));
    await client.classify(makeParams({ promptSummary: "Call 2" }));

    const entries = debrief.getByType("llm-call");
    expect(entries).toHaveLength(2);
    expect(entries[0].context.promptSummary).toBe("Call 1");
    expect(entries[1].context.promptSummary).toBe("Call 2");
  });

  it("debrief reasoning explains fallback in plain language", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", { apiKey: undefined });

    await client.reason(makeParams());

    const entries = debrief.getByType("llm-call");
    const reasoning = entries[0].reasoning;

    // Reasoning must be specific and explain what happened
    expect(reasoning).toContain("deterministic");
    expect(reasoning.split(/\s+/).length).toBeGreaterThanOrEqual(8);
  });

  it("reason() uses default reasoning model in debrief context", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", { apiKey: undefined });

    await client.reason(makeParams());

    const entries = debrief.getByType("llm-call");
    expect(entries[0].context.model).toBe("claude-sonnet-4-6");
  });

  it("classify() uses default classification model in debrief context", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "server", { apiKey: undefined });

    await client.classify(makeParams());

    const entries = debrief.getByType("llm-call");
    expect(entries[0].context.model).toBe("claude-haiku-4-5-20251001");
  });
});
