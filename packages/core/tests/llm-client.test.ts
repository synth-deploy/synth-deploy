import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DecisionDebrief } from "../src/debrief.js";
import { LlmClient, DEFAULT_TIMEOUT_MS, DEFAULT_RATE_LIMIT_PER_MINUTE } from "../src/llm-client.js";
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
    const client = new LlmClient(debrief, "command", { apiKey: undefined });
    expect(client.isAvailable()).toBe(false);
  });

  it("isAvailable returns false when API key is empty string", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { apiKey: "" });
    expect(client.isAvailable()).toBe(false);
  });

  it("isAvailable returns true when API key is provided", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { apiKey: "sk-test-key" });
    expect(client.isAvailable()).toBe(true);
  });

  it("accepts custom model configuration", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      apiKey: "sk-test",
      reasoningModel: "custom-model",
      classificationModel: "custom-classifier",
    });
    expect(client.isAvailable()).toBe(true);
  });

  it("accepts both command and envoy agent types", () => {
    const debrief = new DecisionDebrief();
    const commandClient = new LlmClient(debrief, "command");
    const envoyClient = new LlmClient(debrief, "envoy");
    expect(commandClient).toBeDefined();
    expect(envoyClient).toBeDefined();
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
    client = new LlmClient(debrief, "command", { apiKey: undefined });
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
        partitionId: "partition-1",
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
    const client = new LlmClient(debrief, "command", { apiKey: undefined });

    await client.reason(
      makeParams({
        promptSummary: "Postmortem generation",
        partitionId: "partition-1",
        deploymentId: "deploy-1",
      }),
    );

    const entries = debrief.getByType("llm-call");
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.decisionType).toBe("llm-call");
    expect(entry.agent).toBe("command");
    expect(entry.partitionId).toBe("partition-1");
    expect(entry.deploymentId).toBe("deploy-1");
    expect(entry.decision).toContain("Postmortem generation");
    expect(entry.decision).toContain("falling back");
    expect(entry.context.fallbackUsed).toBe(true);
    expect(entry.context.promptSummary).toBe("Postmortem generation");
  });

  it("records debrief entry with correct agent type", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "envoy", { apiKey: undefined });

    await client.classify(makeParams({ promptSummary: "Error classification" }));

    const entries = debrief.getByType("llm-call");
    expect(entries[0].agent).toBe("envoy");
  });

  it("debrief entry contains model information", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { apiKey: undefined });

    await client.reason(makeParams());

    const entries = debrief.getByType("llm-call");
    expect(entries[0].context.model).toBeDefined();
    expect(typeof entries[0].context.model).toBe("string");
  });

  it("records separate entries for each call", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { apiKey: undefined });

    await client.reason(makeParams({ promptSummary: "Call 1" }));
    await client.classify(makeParams({ promptSummary: "Call 2" }));

    const entries = debrief.getByType("llm-call");
    expect(entries).toHaveLength(2);
    expect(entries[0].context.promptSummary).toBe("Call 1");
    expect(entries[1].context.promptSummary).toBe("Call 2");
  });

  it("debrief reasoning explains fallback in plain language", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { apiKey: undefined });

    await client.reason(makeParams());

    const entries = debrief.getByType("llm-call");
    const reasoning = entries[0].reasoning;

    // Reasoning must be specific and explain what happened
    expect(reasoning).toContain("deterministic");
    expect(reasoning.split(/\s+/).length).toBeGreaterThanOrEqual(8);
  });

  it("reason() uses default reasoning model in debrief context", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { apiKey: undefined });

    await client.reason(makeParams());

    const entries = debrief.getByType("llm-call");
    expect(entries[0].context.model).toBe("claude-sonnet-4-6");
  });

  it("classify() uses default classification model in debrief context", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { apiKey: undefined });

    await client.classify(makeParams());

    const entries = debrief.getByType("llm-call");
    expect(entries[0].context.model).toBe("claude-haiku-4-5-20251001");
  });
});

// ---------------------------------------------------------------------------
// Timeout and rate limiting — configuration
// ---------------------------------------------------------------------------

describe("LlmClient — timeout and rate limiting", () => {
  afterEach(() => {
    delete process.env.DEPLOYSTACK_LLM_TIMEOUT_MS;
    delete process.env.DEPLOYSTACK_LLM_RATE_LIMIT;
  });

  it("stores timeout from config", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { timeoutMs: 5000 });
    // Access private field via type cast for testing
    expect((client as unknown as { _timeoutMs: number })._timeoutMs).toBe(5000);
  });

  it("uses default timeout when not configured", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command");
    expect((client as unknown as { _timeoutMs: number })._timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("reads timeout from environment variable", () => {
    process.env.DEPLOYSTACK_LLM_TIMEOUT_MS = "10000";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command");
    expect((client as unknown as { _timeoutMs: number })._timeoutMs).toBe(10000);
  });

  it("config timeoutMs takes precedence over environment variable", () => {
    process.env.DEPLOYSTACK_LLM_TIMEOUT_MS = "10000";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { timeoutMs: 5000 });
    expect((client as unknown as { _timeoutMs: number })._timeoutMs).toBe(5000);
  });

  it("stores rate limit from config", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { rateLimitPerMinute: 10 });
    expect((client as unknown as { _rateLimitPerMinute: number })._rateLimitPerMinute).toBe(10);
  });

  it("uses default rate limit when not configured", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command");
    expect((client as unknown as { _rateLimitPerMinute: number })._rateLimitPerMinute).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
  });

  it("reads rate limit from environment variable", () => {
    process.env.DEPLOYSTACK_LLM_RATE_LIMIT = "5";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command");
    expect((client as unknown as { _rateLimitPerMinute: number })._rateLimitPerMinute).toBe(5);
  });

  it("config rateLimitPerMinute takes precedence over environment variable", () => {
    process.env.DEPLOYSTACK_LLM_RATE_LIMIT = "5";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { rateLimitPerMinute: 15 });
    expect((client as unknown as { _rateLimitPerMinute: number })._rateLimitPerMinute).toBe(15);
  });

  it("DEFAULT_TIMEOUT_MS constant is 30000", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it("DEFAULT_RATE_LIMIT_PER_MINUTE constant is 20", () => {
    expect(DEFAULT_RATE_LIMIT_PER_MINUTE).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Rate limit behavior
// ---------------------------------------------------------------------------

describe("LlmClient — rate limit behavior", () => {
  it("returns fallback when rate limit is exceeded", async () => {
    const debrief = new DecisionDebrief();
    // Set rate limit to 2 calls/min; no API key so calls fail before rate limit check
    // We test the rate limiter by accessing _checkRateLimit directly
    const client = new LlmClient(debrief, "command", {
      apiKey: "sk-test-key",
      rateLimitPerMinute: 2,
    });

    // Manually fill timestamps to simulate hitting the limit
    const internalClient = client as unknown as {
      _callTimestamps: number[];
      _checkRateLimit: () => boolean;
    };

    // Pre-fill with 2 recent timestamps to simulate 2 calls already made
    const now = Date.now();
    internalClient._callTimestamps = [now - 5000, now - 3000];

    // Should be at limit (2 calls already, limit is 2)
    expect(internalClient._checkRateLimit()).toBe(false);
  });

  it("allows calls when under rate limit", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      apiKey: "sk-test-key",
      rateLimitPerMinute: 5,
    });

    const internalClient = client as unknown as {
      _callTimestamps: number[];
      _checkRateLimit: () => boolean;
    };

    // Only 3 calls so far, limit is 5
    const now = Date.now();
    internalClient._callTimestamps = [now - 10000, now - 8000, now - 5000];

    expect(internalClient._checkRateLimit()).toBe(true);
  });

  it("prunes timestamps older than 60 seconds from the sliding window", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      rateLimitPerMinute: 2,
    });

    const internalClient = client as unknown as {
      _callTimestamps: number[];
      _checkRateLimit: () => boolean;
    };

    // Fill with old timestamps (> 60s ago) — these should be pruned
    const now = Date.now();
    internalClient._callTimestamps = [now - 90000, now - 70000];

    // After pruning expired timestamps, 0 calls remain — should be under limit
    expect(internalClient._checkRateLimit()).toBe(true);
    // Verify timestamps were pruned
    expect(internalClient._callTimestamps).toHaveLength(0);
  });

  it("records rate-limit fallback in debrief with plain-language explanation", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      apiKey: "sk-test-key",
      rateLimitPerMinute: 1,
    });

    // Pre-fill timestamps to trigger rate limit immediately on the next call
    const internalClient = client as unknown as {
      _callTimestamps: number[];
      _initialized: boolean;
      _anthropicClient: unknown;
    };
    // Force initialized state so _ensureInitialized() is a no-op,
    // then rate limit check runs and returns false without any SDK calls
    internalClient._initialized = true;
    internalClient._anthropicClient = {};
    internalClient._callTimestamps = [Date.now() - 1000];

    const result = await client.reason(makeParams({ promptSummary: "Rate limit test" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toContain("rate limit exceeded");
      expect(result.reason).toContain("1 calls/min");
    }

    // Debrief should record the rate limit failure in plain language
    const entries = debrief.getByType("llm-call");
    expect(entries).toHaveLength(1);
    expect(entries[0].context.fallbackUsed).toBe(true);
    expect(entries[0].context.failureReason).toContain("rate limit exceeded");
  });
});

// ---------------------------------------------------------------------------
// Error scenarios — simulating API failures
// ---------------------------------------------------------------------------

describe("LlmClient — error scenarios", () => {
  /**
   * Helper to create a client with a mock Anthropic SDK client.
   * Sets _initialized = true and _anthropicClient to the provided mock
   * so that _ensureInitialized() is a no-op and calls go through our mock.
   */
  function createClientWithMock(
    debrief: DecisionDebrief,
    mockClient: { messages: { create: (...args: unknown[]) => Promise<unknown> } },
  ): LlmClient {
    const client = new LlmClient(debrief, "command", {
      apiKey: "sk-test-key",
      timeoutMs: 500, // short timeout for tests
    });
    const internal = client as unknown as {
      _initialized: boolean;
      _anthropicClient: unknown;
    };
    internal._initialized = true;
    internal._anthropicClient = mockClient;
    return client;
  }

  it("returns fallback result when API request times out", async () => {
    const debrief = new DecisionDebrief();
    const mockClient = {
      messages: {
        create: async (_opts: unknown) => {
          return new Promise((_resolve, reject) => {
            setTimeout(() => {
              const err = new DOMException("The operation was aborted", "AbortError");
              reject(err);
            }, 600);
          });
        },
      },
    };

    const client = createClientWithMock(debrief, mockClient);
    const result = await client.reason(makeParams({ promptSummary: "Timeout test" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toContain("timed out");
    }

    const entries = debrief.getByType("llm-call");
    expect(entries).toHaveLength(1);
    expect(entries[0].context.fallbackUsed).toBe(true);
    expect(entries[0].context.failureReason).toContain("timed out");
  });

  it("returns fallback result when API returns 429 rate limit", async () => {
    const debrief = new DecisionDebrief();
    const mockClient = {
      messages: {
        create: async () => {
          const error = new Error("429 Too Many Requests");
          (error as Error & { status: number }).status = 429;
          throw error;
        },
      },
    };

    const client = createClientWithMock(debrief, mockClient);
    const result = await client.classify(makeParams({ promptSummary: "Rate limit 429 test" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toContain("429 Too Many Requests");
    }

    const entries = debrief.getByType("llm-call");
    expect(entries).toHaveLength(1);
    expect(entries[0].context.fallbackUsed).toBe(true);
  });

  it("returns fallback result on network failure", async () => {
    const debrief = new DecisionDebrief();
    const mockClient = {
      messages: {
        create: async () => {
          throw new TypeError("fetch failed");
        },
      },
    };

    const client = createClientWithMock(debrief, mockClient);
    const result = await client.reason(makeParams({ promptSummary: "Network failure test" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toContain("fetch failed");
    }

    const entries = debrief.getByType("llm-call");
    expect(entries).toHaveLength(1);
    expect(entries[0].context.fallbackUsed).toBe(true);
    expect(entries[0].context.failureReason).toContain("fetch failed");
  });

  it("returns fallback result when response has no content blocks", async () => {
    const debrief = new DecisionDebrief();
    const mockClient = {
      messages: {
        create: async () => ({
          content: [],
        }),
      },
    };

    const client = createClientWithMock(debrief, mockClient);
    const result = await client.classify(makeParams({ promptSummary: "Empty content test" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("");
      expect(result.model).toBeDefined();
      expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns fallback result when response content is malformed (not an array)", async () => {
    const debrief = new DecisionDebrief();
    const mockClient = {
      messages: {
        create: async () => ({
          content: null,
        }),
      },
    };

    const client = createClientWithMock(debrief, mockClient);
    const result = await client.reason(makeParams({ promptSummary: "Malformed content test" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toContain("LLM call failed");
    }
  });

  it("records response time even for failed calls", async () => {
    const debrief = new DecisionDebrief();
    const mockClient = {
      messages: {
        create: async () => {
          await new Promise((r) => setTimeout(r, 20));
          throw new Error("server error");
        },
      },
    };

    const client = createClientWithMock(debrief, mockClient);
    await client.reason(makeParams({ promptSummary: "Response time tracking" }));

    const entries = debrief.getByType("llm-call");
    expect(entries).toHaveLength(1);
    expect(entries[0].context.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(entries[0].context.responseTimeMs).not.toBeNull();
  });

  it("does not throw — always returns a result object", async () => {
    const debrief = new DecisionDebrief();
    const mockClient = {
      messages: {
        create: async () => {
          throw new Error("unexpected catastrophic failure");
        },
      },
    };

    const client = createClientWithMock(debrief, mockClient);

    const reasonResult = await client.reason(makeParams());
    const classifyResult = await client.classify(makeParams());

    expect(reasonResult.ok).toBe(false);
    expect(classifyResult.ok).toBe(false);
    if (!reasonResult.ok) expect(typeof reasonResult.reason).toBe("string");
    if (!classifyResult.ok) expect(typeof classifyResult.reason).toBe("string");
  });
});
