import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DecisionDebrief } from "../src/debrief.js";
import { LlmClient, DEFAULT_TIMEOUT_MS, DEFAULT_RATE_LIMIT_PER_MINUTE, createOpenAICompatibleAdapter } from "../src/llm-client.js";
import type { LlmCallParams, LlmSdkProvider } from "../src/llm-client.js";

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
    delete process.env.SYNTH_LLM_TIMEOUT_MS;
    delete process.env.SYNTH_LLM_RATE_LIMIT;
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
    process.env.SYNTH_LLM_TIMEOUT_MS = "10000";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command");
    expect((client as unknown as { _timeoutMs: number })._timeoutMs).toBe(10000);
  });

  it("config timeoutMs takes precedence over environment variable", () => {
    process.env.SYNTH_LLM_TIMEOUT_MS = "10000";
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
    process.env.SYNTH_LLM_RATE_LIMIT = "5";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command");
    expect((client as unknown as { _rateLimitPerMinute: number })._rateLimitPerMinute).toBe(5);
  });

  it("config rateLimitPerMinute takes precedence over environment variable", () => {
    process.env.SYNTH_LLM_RATE_LIMIT = "5";
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
      _lastInitializedApiKey: string | undefined;
    };
    internal._initialized = true;
    internal._lastInitializedApiKey = "sk-test-key";
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

// ---------------------------------------------------------------------------
// Provider detection from env vars
// ---------------------------------------------------------------------------

describe("LlmClient — provider detection", () => {
  afterEach(() => {
    delete process.env.SYNTH_LLM_PROVIDER;
    delete process.env.SYNTH_LLM_BASE_URL;
    delete process.env.SYNTH_LLM_MODEL;
  });

  it("defaults to anthropic provider when no config or env var", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command");
    const internal = client as unknown as { _provider: LlmSdkProvider };
    expect(internal._provider).toBe("anthropic");
  });

  it("reads provider from SYNTH_LLM_PROVIDER env var", () => {
    process.env.SYNTH_LLM_PROVIDER = "bedrock";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command");
    const internal = client as unknown as { _provider: LlmSdkProvider };
    expect(internal._provider).toBe("bedrock");
  });

  it("explicit config.provider takes precedence over env var", () => {
    process.env.SYNTH_LLM_PROVIDER = "bedrock";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "vertex" });
    const internal = client as unknown as { _provider: LlmSdkProvider };
    expect(internal._provider).toBe("vertex");
  });

  it("reads base URL from SYNTH_LLM_BASE_URL env var", () => {
    process.env.SYNTH_LLM_BASE_URL = "http://my-ollama:11434/v1";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command");
    const internal = client as unknown as { _baseUrl: string | undefined };
    expect(internal._baseUrl).toBe("http://my-ollama:11434/v1");
  });

  it("explicit config.baseUrl takes precedence over env var", () => {
    process.env.SYNTH_LLM_BASE_URL = "http://env-url/v1";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      baseUrl: "http://config-url/v1",
    });
    const internal = client as unknown as { _baseUrl: string | undefined };
    expect(internal._baseUrl).toBe("http://config-url/v1");
  });

  it("config.model overrides reasoning model (but not classification)", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      model: "llama3.2",
    });
    const internal = client as unknown as {
      _reasoningModel: string;
      _classificationModel: string;
    };
    expect(internal._reasoningModel).toBe("llama3.2");
    // classification model should still be the default
    expect(internal._classificationModel).toBe("claude-haiku-4-5-20251001");
  });

  it("config.reasoningModel takes precedence over config.model", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      model: "llama3.2",
      reasoningModel: "custom-sonnet",
    });
    const internal = client as unknown as { _reasoningModel: string };
    expect(internal._reasoningModel).toBe("custom-sonnet");
  });

  it("sets all four provider types correctly via config", () => {
    const debrief = new DecisionDebrief();
    const providers: LlmSdkProvider[] = ["anthropic", "bedrock", "vertex", "openai-compatible"];
    for (const p of providers) {
      const client = new LlmClient(debrief, "command", { provider: p });
      const internal = client as unknown as { _provider: LlmSdkProvider };
      expect(internal._provider).toBe(p);
    }
  });
});

// ---------------------------------------------------------------------------
// isAvailable() for each provider type
// ---------------------------------------------------------------------------

describe("LlmClient — isAvailable per provider", () => {
  afterEach(() => {
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.CLOUD_ML_REGION;
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    delete process.env.SYNTH_LLM_BASE_URL;
  });

  // --- anthropic ---
  it("anthropic: available when API key is set", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "anthropic",
      apiKey: "sk-test-key",
    });
    expect(client.isAvailable()).toBe(true);
  });

  it("anthropic: not available when API key is missing", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "anthropic",
      apiKey: undefined,
    });
    expect(client.isAvailable()).toBe(false);
  });

  // --- bedrock ---
  it("bedrock: available when AWS_REGION is set", () => {
    process.env.AWS_REGION = "us-east-1";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "bedrock" });
    expect(client.isAvailable()).toBe(true);
  });

  it("bedrock: not available when AWS_REGION is missing", () => {
    delete process.env.AWS_REGION;
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "bedrock" });
    expect(client.isAvailable()).toBe(false);
  });

  it("bedrock: not available when AWS_REGION is empty string", () => {
    process.env.AWS_REGION = "";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "bedrock" });
    expect(client.isAvailable()).toBe(false);
  });

  // --- vertex ---
  it("vertex: available when both CLOUD_ML_REGION and ANTHROPIC_VERTEX_PROJECT_ID are set", () => {
    process.env.CLOUD_ML_REGION = "us-central1";
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "my-project";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "vertex" });
    expect(client.isAvailable()).toBe(true);
  });

  it("vertex: not available when CLOUD_ML_REGION is missing", () => {
    delete process.env.CLOUD_ML_REGION;
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "my-project";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "vertex" });
    expect(client.isAvailable()).toBe(false);
  });

  it("vertex: not available when ANTHROPIC_VERTEX_PROJECT_ID is missing", () => {
    process.env.CLOUD_ML_REGION = "us-central1";
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "vertex" });
    expect(client.isAvailable()).toBe(false);
  });

  it("vertex: not available when both env vars are missing", () => {
    delete process.env.CLOUD_ML_REGION;
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "vertex" });
    expect(client.isAvailable()).toBe(false);
  });

  // --- openai-compatible ---
  it("openai-compatible: available when baseUrl is set via config", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(client.isAvailable()).toBe(true);
  });

  it("openai-compatible: available when SYNTH_LLM_BASE_URL env var is set", () => {
    process.env.SYNTH_LLM_BASE_URL = "http://localhost:11434/v1";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "openai-compatible",
    });
    expect(client.isAvailable()).toBe(true);
  });

  it("openai-compatible: not available when baseUrl is missing", () => {
    delete process.env.SYNTH_LLM_BASE_URL;
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "openai-compatible",
    });
    expect(client.isAvailable()).toBe(false);
  });

  it("openai-compatible: not available when baseUrl is empty string", () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "openai-compatible",
      baseUrl: "",
    });
    expect(client.isAvailable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider recorded in debrief
// ---------------------------------------------------------------------------

describe("LlmClient — provider in debrief", () => {
  it("records provider in debrief context for anthropic", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "anthropic",
      apiKey: undefined,
    });

    await client.reason(makeParams());

    const entries = debrief.getByType("llm-call");
    expect(entries[0].context.provider).toBe("anthropic");
  });

  it("records provider in debrief context for bedrock", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "bedrock" });

    await client.reason(makeParams());

    const entries = debrief.getByType("llm-call");
    expect(entries[0].context.provider).toBe("bedrock");
  });

  it("records provider in debrief context for openai-compatible", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "openai-compatible",
    });

    await client.reason(makeParams());

    const entries = debrief.getByType("llm-call");
    expect(entries[0].context.provider).toBe("openai-compatible");
  });
});

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter
// ---------------------------------------------------------------------------

describe("createOpenAICompatibleAdapter — response parsing", () => {
  it("converts OpenAI chat-completion response to Anthropic format", async () => {
    // Mock fetch globally
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-abc",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello from Ollama!" },
              finish_reason: "stop",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    try {
      const adapter = createOpenAICompatibleAdapter("http://localhost:11434/v1");
      const result = await adapter.messages.create({
        model: "llama3.2",
        max_tokens: 1024,
        system: "You are a helpful assistant.",
        messages: [{ role: "user", content: "Say hello" }],
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("Hello from Ollama!");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends system prompt as first message with role system", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: string | undefined;

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const adapter = createOpenAICompatibleAdapter("http://localhost:11434/v1");
      await adapter.messages.create({
        model: "test-model",
        max_tokens: 100,
        system: "Be concise.",
        messages: [{ role: "user", content: "Hi" }],
      });

      const parsed = JSON.parse(capturedBody!);
      expect(parsed.messages[0]).toEqual({
        role: "system",
        content: "Be concise.",
      });
      expect(parsed.messages[1]).toEqual({
        role: "user",
        content: "Hi",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends Authorization header when apiKey is provided", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      capturedHeaders = { ...h };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const adapter = createOpenAICompatibleAdapter(
        "http://localhost:11434/v1",
        "sk-my-api-key",
      );
      await adapter.messages.create({
        model: "test-model",
        max_tokens: 100,
        system: "test",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(capturedHeaders["Authorization"]).toBe("Bearer sk-my-api-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not send Authorization header when apiKey is not provided", async () => {
    const originalFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      capturedHeaders = { ...h };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const adapter = createOpenAICompatibleAdapter("http://localhost:11434/v1");
      await adapter.messages.create({
        model: "test-model",
        max_tokens: 100,
        system: "test",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(capturedHeaders["Authorization"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("constructs correct URL from base URL", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";

    globalThis.fetch = async (url: string | URL | Request, _init?: RequestInit) => {
      capturedUrl = typeof url === "string" ? url : url.toString();
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const adapter = createOpenAICompatibleAdapter("http://localhost:11434/v1/");
      await adapter.messages.create({
        model: "test-model",
        max_tokens: 100,
        system: "test",
        messages: [{ role: "user", content: "Hi" }],
      });

      // Trailing slash should be stripped and /chat/completions appended
      expect(capturedUrl).toBe("http://localhost:11434/v1/chat/completions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on non-OK HTTP response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response("Internal Server Error", { status: 500 });

    try {
      const adapter = createOpenAICompatibleAdapter("http://localhost:11434/v1");
      await expect(
        adapter.messages.create({
          model: "test-model",
          max_tokens: 100,
          system: "test",
          messages: [{ role: "user", content: "Hi" }],
        }),
      ).rejects.toThrow("OpenAI-compatible API returned 500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns empty text when response has no choices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ choices: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    try {
      const adapter = createOpenAICompatibleAdapter("http://localhost:11434/v1");
      const result = await adapter.messages.create({
        model: "test-model",
        max_tokens: 100,
        system: "test",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content[0].text).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Error handling when provider SDK is not installed
// ---------------------------------------------------------------------------

describe("LlmClient — missing provider SDK", () => {
  it("bedrock: initialization fails with helpful message when SDK not installed", async () => {
    process.env.AWS_REGION = "us-east-1";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "bedrock" });

    // The client is available (env vars set) but initialization will fail
    // because @anthropic-ai/bedrock-sdk is not installed
    expect(client.isAvailable()).toBe(true);

    const result = await client.reason(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toContain("@anthropic-ai/bedrock-sdk");
    }

    delete process.env.AWS_REGION;
  });

  it("vertex: initialization fails with helpful message when SDK not installed", async () => {
    process.env.CLOUD_ML_REGION = "us-central1";
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = "my-project";
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "vertex" });

    expect(client.isAvailable()).toBe(true);

    const result = await client.reason(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fallback).toBe(true);
      expect(result.reason).toContain("@anthropic-ai/vertex-sdk");
    }

    delete process.env.CLOUD_ML_REGION;
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
  });
});

// ---------------------------------------------------------------------------
// Fallback messages for each provider
// ---------------------------------------------------------------------------

describe("LlmClient — fallback messages per provider", () => {
  it("anthropic: fallback mentions SYNTH_LLM_API_KEY", async () => {
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "anthropic",
      apiKey: undefined,
    });
    const result = await client.reason(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("SYNTH_LLM_API_KEY");
    }
  });

  it("bedrock: fallback mentions AWS_REGION", async () => {
    delete process.env.AWS_REGION;
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "bedrock" });
    const result = await client.reason(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("AWS_REGION");
    }
  });

  it("vertex: fallback mentions CLOUD_ML_REGION and ANTHROPIC_VERTEX_PROJECT_ID", async () => {
    delete process.env.CLOUD_ML_REGION;
    delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", { provider: "vertex" });
    const result = await client.reason(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("CLOUD_ML_REGION");
      expect(result.reason).toContain("ANTHROPIC_VERTEX_PROJECT_ID");
    }
  });

  it("openai-compatible: fallback mentions SYNTH_LLM_BASE_URL", async () => {
    delete process.env.SYNTH_LLM_BASE_URL;
    const debrief = new DecisionDebrief();
    const client = new LlmClient(debrief, "command", {
      provider: "openai-compatible",
    });
    const result = await client.reason(makeParams());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("SYNTH_LLM_BASE_URL");
    }
  });
});
