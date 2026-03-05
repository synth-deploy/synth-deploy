import type { DebriefWriter } from "./debrief.js";
import type { AgentType, LlmProviderConfig, LlmHealthStatus, TaskModelConfig, TaskModelTask } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * SDK-level provider identifier — maps to the actual SDK/transport used.
 * This is distinct from the user-facing LlmProvider type in types.ts which
 * represents the provider brand (claude, openai, gemini, etc.).
 */
export type LlmSdkProvider = "anthropic" | "bedrock" | "vertex" | "openai-compatible";

/** @deprecated Use LlmSdkProvider instead. Kept for backward compatibility. */
export type LlmProvider = LlmSdkProvider;

export interface LlmConfig {
  apiKey?: string;
  provider?: LlmSdkProvider;
  baseUrl?: string;
  model?: string;
  reasoningModel?: string;
  classificationModel?: string;
  timeoutMs?: number;
  rateLimitPerMinute?: number;
  taskModels?: TaskModelConfig;
}

export interface LlmCallParams {
  /** The user/task prompt */
  prompt: string;
  /** System prompt providing role and constraints */
  systemPrompt: string;
  /** One-line summary for debrief recording (never the full prompt) */
  promptSummary: string;
  /** Partition context for debrief */
  partitionId?: string | null;
  /** Deployment context for debrief */
  deploymentId?: string | null;
  /** Max tokens for response */
  maxTokens?: number;
}

export type LlmResult =
  | { ok: true; text: string; model: string; responseTimeMs: number }
  | { ok: false; fallback: true; reason: string };

// ---------------------------------------------------------------------------
// Provider adapter interface
// ---------------------------------------------------------------------------

/**
 * Abstraction layer for LLM provider SDKs. Each supported provider implements
 * this interface, allowing the LlmClient to route calls without provider-specific
 * logic leaking into agent behavior.
 */
export interface LlmProviderAdapter {
  /** Human-readable name for logging/debrief */
  readonly name: string;
  /** Whether this adapter has all required configuration */
  isConfigured(): boolean;
  /** Human-readable reason if not configured */
  notConfiguredReason(): string;
  /** Initialize the underlying SDK client (lazy, called once) */
  initialize(): Promise<void>;
  /** Send a message and return the response text */
  call(opts: {
    model: string;
    maxTokens: number;
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_REASONING_MODEL = "claude-sonnet-4-6";
const DEFAULT_CLASSIFICATION_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;

// ---------------------------------------------------------------------------
// Provider-to-SDK mapping
// ---------------------------------------------------------------------------

/**
 * Maps user-facing provider names to the SDK-level provider used internally.
 * Claude uses the native Anthropic SDK; OpenAI, Gemini, Grok, DeepSeek use
 * the OpenAI-compatible adapter; Ollama uses OpenAI-compatible with localhost
 * defaults; Custom is always OpenAI-compatible.
 */
export function resolveProviderToSdk(
  provider: import("./types.js").LlmProvider,
): LlmSdkProvider {
  switch (provider) {
    case "claude":
      return "anthropic";
    case "openai":
    case "gemini":
    case "grok":
    case "deepseek":
      return "openai-compatible";
    case "ollama":
      return "openai-compatible";
    case "custom":
      return "openai-compatible";
    default:
      return "openai-compatible";
  }
}

/**
 * Returns the default base URL for known providers.
 */
export function defaultBaseUrlForProvider(
  provider: import("./types.js").LlmProvider,
): string | undefined {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    case "grok":
      return "https://api.x.ai/v1";
    case "deepseek":
      return "https://api.deepseek.com/v1";
    case "ollama":
      return "http://localhost:11434/v1";
    default:
      return undefined;
  }
}

/**
 * Builds an LlmConfig from a persisted LlmProviderConfig (settings store)
 * with env var fallback. The apiKey is read from the environment variable
 * DEPLOYSTACK_LLM_API_KEY since we never store it in settings.
 */
export function buildLlmConfigFromSettings(
  providerConfig?: LlmProviderConfig,
): LlmConfig {
  if (!providerConfig) {
    // No settings configured — fall back to pure env var resolution
    return {};
  }

  const sdkProvider = resolveProviderToSdk(providerConfig.provider);
  const baseUrl =
    providerConfig.baseUrl ??
    defaultBaseUrlForProvider(providerConfig.provider);

  return {
    provider: sdkProvider,
    baseUrl,
    reasoningModel: providerConfig.reasoningModel,
    classificationModel: providerConfig.classificationModel,
    timeoutMs: providerConfig.timeoutMs,
    rateLimitPerMinute: providerConfig.rateLimitPerMin,
    // API key is always read from env — never stored in settings
    apiKey: process.env.DEPLOYSTACK_LLM_API_KEY,
  };
}

// ---------------------------------------------------------------------------
// LlmClient
// ---------------------------------------------------------------------------

export class LlmClient {
  private _anthropicClient: unknown = null;
  private _initialized = false;
  private readonly _apiKey: string | undefined;
  private readonly _provider: LlmSdkProvider;
  private readonly _baseUrl: string | undefined;
  private readonly _reasoningModel: string;
  private readonly _classificationModel: string;
  private readonly _timeoutMs: number;
  private readonly _rateLimitPerMinute: number;
  private readonly _taskModels: TaskModelConfig;
  private _callTimestamps: number[] = [];
  private _lastHealthCheck: LlmHealthStatus | null = null;

  constructor(
    private readonly _debrief: DebriefWriter,
    private readonly _agent: AgentType,
    config: LlmConfig = {},
  ) {
    this._apiKey = config.apiKey ?? process.env.DEPLOYSTACK_LLM_API_KEY;
    this._provider =
      config.provider ??
      (process.env.DEPLOYSTACK_LLM_PROVIDER as LlmSdkProvider | undefined) ??
      "anthropic";
    this._baseUrl =
      config.baseUrl ?? process.env.DEPLOYSTACK_LLM_BASE_URL;
    this._reasoningModel =
      config.reasoningModel ??
      config.model ??
      process.env.DEPLOYSTACK_LLM_MODEL ??
      DEFAULT_REASONING_MODEL;
    this._classificationModel =
      config.classificationModel ?? process.env.DEPLOYSTACK_LLM_CLASSIFICATION_MODEL ?? DEFAULT_CLASSIFICATION_MODEL;
    this._timeoutMs =
      config.timeoutMs ??
      (process.env.DEPLOYSTACK_LLM_TIMEOUT_MS
        ? parseInt(process.env.DEPLOYSTACK_LLM_TIMEOUT_MS, 10)
        : DEFAULT_TIMEOUT_MS);
    this._rateLimitPerMinute =
      config.rateLimitPerMinute ??
      (process.env.DEPLOYSTACK_LLM_RATE_LIMIT
        ? parseInt(process.env.DEPLOYSTACK_LLM_RATE_LIMIT, 10)
        : DEFAULT_RATE_LIMIT_PER_MINUTE);
    this._taskModels = config.taskModels ?? {};
  }

  /**
   * Synchronous check: is the LLM provider configured?
   * Does NOT validate credentials — just checks presence of required config.
   */
  isAvailable(): boolean {
    switch (this._provider) {
      case "anthropic":
        return typeof this._apiKey === "string" && this._apiKey.length > 0;
      case "bedrock":
        return (
          typeof process.env.AWS_REGION === "string" &&
          process.env.AWS_REGION.length > 0
        );
      case "vertex":
        return (
          typeof process.env.CLOUD_ML_REGION === "string" &&
          process.env.CLOUD_ML_REGION.length > 0 &&
          typeof process.env.ANTHROPIC_VERTEX_PROJECT_ID === "string" &&
          process.env.ANTHROPIC_VERTEX_PROJECT_ID.length > 0
        );
      case "openai-compatible":
        return (
          typeof this._baseUrl === "string" && this._baseUrl.length > 0
        );
      default:
        return false;
    }
  }

  /**
   * Lightweight health check — attempts a minimal LLM call to verify
   * the provider is reachable and the API key is valid.
   * Returns an LlmHealthStatus suitable for the /health endpoint.
   */
  async healthCheck(): Promise<LlmHealthStatus> {
    const configured = this.isAvailable();
    if (!configured) {
      const status: LlmHealthStatus = {
        configured: false,
        healthy: false,
        provider: this._provider,
        lastChecked: new Date(),
      };
      this._lastHealthCheck = status;
      return status;
    }

    try {
      await this._ensureInitialized();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = this._anthropicClient as any;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      try {
        await client.messages.create({
          model: this._classificationModel,
          max_tokens: 1,
          system: "health check",
          messages: [{ role: "user", content: "ping" }],
          signal: controller.signal,
        });

        const status: LlmHealthStatus = {
          configured: true,
          healthy: true,
          provider: this._provider,
          lastChecked: new Date(),
        };
        this._lastHealthCheck = status;
        return status;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      const status: LlmHealthStatus = {
        configured: true,
        healthy: false,
        provider: this._provider,
        lastChecked: new Date(),
      };
      this._lastHealthCheck = status;
      return status;
    }
  }

  /**
   * Returns the last cached health check result, or null if never checked.
   */
  getLastHealthStatus(): LlmHealthStatus | null {
    return this._lastHealthCheck;
  }

  /**
   * Reasoning task — uses the larger model (Sonnet) by default.
   * For synthesis: postmortems, answer generation, diagnostic reports.
   * An optional `task` parameter routes to a per-task model override if configured.
   */
  async reason(params: LlmCallParams, task?: TaskModelTask): Promise<LlmResult> {
    const model = this._resolveTaskModel(task) ?? this._reasoningModel;
    return this._call(params, model);
  }

  /**
   * Classification task — uses the smaller model (Haiku) by default.
   * For classification: intent parsing, error categorization.
   * An optional `task` parameter routes to a per-task model override if configured.
   */
  async classify(params: LlmCallParams, task?: TaskModelTask): Promise<LlmResult> {
    const model = this._resolveTaskModel(task) ?? this._classificationModel;
    return this._call(params, model);
  }

  /**
   * Resolves a per-task model override from the TaskModelConfig.
   * Returns undefined if no override is configured for the given task.
   */
  private _resolveTaskModel(task?: TaskModelTask): string | undefined {
    if (!task) return undefined;
    const override = this._taskModels[task];
    return override && override.length > 0 ? override : undefined;
  }

  /**
   * Returns the currently configured task model overrides.
   */
  getTaskModels(): TaskModelConfig {
    return { ...this._taskModels };
  }

  /**
   * Returns the model that would be used for a given task.
   * Useful for display and verification purposes.
   */
  getModelForTask(task: TaskModelTask): string {
    return this._resolveTaskModel(task) ?? (
      task === "logClassification" ? this._classificationModel : this._reasoningModel
    );
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private _checkRateLimit(): boolean {
    const now = Date.now();
    const windowStart = now - 60_000;
    this._callTimestamps = this._callTimestamps.filter((ts) => ts > windowStart);
    return this._callTimestamps.length < this._rateLimitPerMinute;
  }

  private async _call(
    params: LlmCallParams,
    model: string,
  ): Promise<LlmResult> {
    if (!this.isAvailable()) {
      const reason = this._notConfiguredReason();
      this._recordDebrief(params, model, null, reason, true);
      return { ok: false, fallback: true, reason };
    }

    try {
      await this._ensureInitialized();
    } catch (error) {
      const reason = `LLM call failed: ${error instanceof Error ? error.message : String(error)}`;
      this._recordDebrief(params, model, null, reason, true);
      return { ok: false, fallback: true, reason };
    }

    if (!this._checkRateLimit()) {
      const reason = `LLM rate limit exceeded (${this._rateLimitPerMinute} calls/min)`;
      this._recordDebrief(params, model, null, reason, true);
      return { ok: false, fallback: true, reason };
    }
    this._callTimestamps.push(Date.now());

    const startTime = Date.now();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = this._anthropicClient as any;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeoutMs);
      try {
        const response = await client.messages.create({
          model,
          max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
          system: params.systemPrompt,
          messages: [{ role: "user", content: params.prompt }],
          signal: controller.signal,
        });

        const responseTimeMs = Date.now() - startTime;

        const text = response.content
          .filter(
            (block: { type: string }): block is { type: "text"; text: string } =>
              block.type === "text",
          )
          .map((block: { text: string }) => block.text)
          .join("");

        this._recordDebrief(params, model, responseTimeMs, null, false);

        return { ok: true, text, model, responseTimeMs };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const responseTimeMs = Date.now() - startTime;
      const isTimeout = error instanceof Error && error.name === "AbortError";
      const reason = isTimeout
        ? `LLM request timed out after ${this._timeoutMs}ms`
        : `LLM call failed: ${error instanceof Error ? error.message : String(error)}`;
      this._recordDebrief(params, model, responseTimeMs, reason, true);
      return { ok: false, fallback: true, reason };
    }
  }

  /**
   * Returns a human-readable reason why the provider is not configured.
   */
  private _notConfiguredReason(): string {
    switch (this._provider) {
      case "anthropic":
        return "LLM not configured — DEPLOYSTACK_LLM_API_KEY not set";
      case "bedrock":
        return "LLM not configured — AWS_REGION not set for Bedrock provider";
      case "vertex":
        return "LLM not configured — CLOUD_ML_REGION and/or ANTHROPIC_VERTEX_PROJECT_ID not set for Vertex provider";
      case "openai-compatible":
        return "LLM not configured — DEPLOYSTACK_LLM_BASE_URL not set for openai-compatible provider";
      default:
        return `LLM not configured — unknown provider "${this._provider}"`;
    }
  }

  /**
   * Lazy initialization of the LLM client based on the configured provider.
   * SDKs are dynamically imported on first use so that the module
   * can be loaded without optional SDKs installed (graceful degradation).
   */
  private async _ensureInitialized(): Promise<void> {
    if (this._initialized) return;

    switch (this._provider) {
      case "anthropic": {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        this._anthropicClient = new Anthropic({ apiKey: this._apiKey });
        break;
      }

      case "bedrock": {
        try {
          const { default: AnthropicBedrock } = await import(
            // @ts-expect-error — optional peer dependency, not in devDependencies
            "@anthropic-ai/bedrock-sdk"
          );
          this._anthropicClient = new AnthropicBedrock();
        } catch {
          throw new Error(
            "Bedrock provider requires @anthropic-ai/bedrock-sdk — install it with: npm install @anthropic-ai/bedrock-sdk",
          );
        }
        break;
      }

      case "vertex": {
        try {
          const { default: AnthropicVertex } = await import(
            // @ts-expect-error — optional peer dependency, not in devDependencies
            "@anthropic-ai/vertex-sdk"
          );
          this._anthropicClient = new AnthropicVertex();
        } catch {
          throw new Error(
            "Vertex provider requires @anthropic-ai/vertex-sdk — install it with: npm install @anthropic-ai/vertex-sdk",
          );
        }
        break;
      }

      case "openai-compatible": {
        const baseUrl =
          this._baseUrl ?? "http://localhost:11434/v1";
        this._anthropicClient = createOpenAICompatibleAdapter(
          baseUrl,
          this._apiKey,
        );
        break;
      }

      default:
        throw new Error(`Unknown LLM provider: ${this._provider}`);
    }

    this._initialized = true;
  }

  private _recordDebrief(
    params: LlmCallParams,
    model: string,
    responseTimeMs: number | null,
    failureReason: string | null,
    fallbackUsed: boolean,
  ): void {
    this._debrief.record({
      partitionId: params.partitionId ?? null,
      deploymentId: params.deploymentId ?? null,
      agent: this._agent,
      decisionType: "llm-call",
      decision: fallbackUsed
        ? `LLM call skipped — falling back to deterministic logic: ${params.promptSummary}`
        : `LLM call completed: ${params.promptSummary}`,
      reasoning: fallbackUsed
        ? `${failureReason}. The system will use deterministic logic for this operation. ` +
          `No degradation of core functionality — LLM enhancement is additive.`
        : `Called ${model} for: ${params.promptSummary}. ` +
          `Response received in ${responseTimeMs}ms.`,
      context: {
        model,
        provider: this._provider,
        responseTimeMs,
        promptSummary: params.promptSummary,
        fallbackUsed,
        ...(failureReason ? { failureReason } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter
// ---------------------------------------------------------------------------

/**
 * Lightweight adapter that wraps any OpenAI-compatible API endpoint
 * (e.g. Ollama, LM Studio, vLLM) to expose a `messages.create()` method
 * matching the shape the `_call()` method expects.
 *
 * Converts from Anthropic message format on the way in and from
 * OpenAI chat-completion format on the way out.
 */
export function createOpenAICompatibleAdapter(
  baseUrl: string,
  apiKey?: string,
) {
  return {
    messages: {
      async create(opts: {
        model: string;
        max_tokens: number;
        system: string;
        messages: Array<{ role: string; content: string }>;
        signal?: AbortSignal;
      }) {
        // Build OpenAI chat-completion request body
        const openaiMessages: Array<{ role: string; content: string }> = [];

        // System prompt becomes the first message with role "system"
        if (opts.system) {
          openaiMessages.push({ role: "system", content: opts.system });
        }

        // Map Anthropic-style messages to OpenAI format (they are compatible)
        for (const msg of opts.messages) {
          openaiMessages.push({ role: msg.role, content: msg.content });
        }

        const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) {
          headers["Authorization"] = `Bearer ${apiKey}`;
        }

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: opts.model,
            max_tokens: opts.max_tokens,
            messages: openaiMessages,
          }),
          signal: opts.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `OpenAI-compatible API returned ${response.status}: ${body}`,
          );
        }

        const json = await response.json() as {
          choices?: Array<{
            message?: { content?: string };
          }>;
        };

        // Convert OpenAI chat-completion response to Anthropic message format
        const text =
          json.choices?.[0]?.message?.content ?? "";

        return {
          content: [{ type: "text" as const, text }],
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Capability Verification
// ---------------------------------------------------------------------------

export interface CapabilityVerificationResult {
  task: string;
  model: string;
  status: "verified" | "marginal" | "insufficient";
  explanation: string;
}

/**
 * Probe prompts per task — lightweight tests that evaluate whether
 * a model can handle the required output format and reasoning depth.
 */
const TASK_PROBE_PROMPTS: Record<TaskModelTask, { system: string; user: string; validator: (text: string) => CapabilityVerificationResult["status"] }> = {
  logClassification: {
    system: "You are a log classifier. Respond ONLY with valid JSON.",
    user: 'Classify this log line into a category. Log: "ERROR 2025-01-15 Connection refused on port 5432". Respond with JSON: {"category": "<string>", "severity": "<string>"}',
    validator: (text: string) => {
      try {
        const parsed = JSON.parse(text.trim());
        if (parsed.category && parsed.severity) return "verified";
        return "marginal";
      } catch {
        // Check if it contains JSON-like structure even with surrounding text
        const jsonMatch = text.match(/\{[^}]*"category"[^}]*\}/);
        if (jsonMatch) return "marginal";
        return "insufficient";
      }
    },
  },
  diagnosticSynthesis: {
    system: "You are a deployment diagnostics expert. Write concise, actionable reports.",
    user: "Synthesize a one-paragraph diagnostic from these facts: (1) Deploy started at 14:00, (2) Health check failed at 14:02, (3) Port 8080 was already in use. Include root cause and recommendation.",
    validator: (text: string) => {
      const lower = text.toLowerCase();
      const hasRootCause = lower.includes("port") || lower.includes("cause") || lower.includes("conflict");
      const hasRecommendation = lower.includes("recommend") || lower.includes("should") || lower.includes("fix") || lower.includes("resolve");
      if (hasRootCause && hasRecommendation && text.length > 50) return "verified";
      if (hasRootCause || hasRecommendation) return "marginal";
      return "insufficient";
    },
  },
  postmortemGeneration: {
    system: "You are a postmortem writer for deployment incidents. Identify causal chains.",
    user: "Given: (1) v2.4.1 deployed to production, (2) Migration partially applied, (3) /api/v2/users returned 502, (4) Rolled back to v2.4.0. Write a 2-sentence root cause analysis identifying the causal chain.",
    validator: (text: string) => {
      const lower = text.toLowerCase();
      const hasCausality = lower.includes("because") || lower.includes("caused") || lower.includes("led to") || lower.includes("resulted") || lower.includes("due to");
      const hasMultipleEvents = (lower.includes("migration") || lower.includes("schema")) && (lower.includes("502") || lower.includes("error") || lower.includes("fail"));
      if (hasCausality && hasMultipleEvents && text.length > 40) return "verified";
      if (hasCausality || hasMultipleEvents) return "marginal";
      return "insufficient";
    },
  },
  queryAnswering: {
    system: "You are a deployment data analyst. Answer questions based on provided data only.",
    user: 'Data: {"deployments": 15, "succeeded": 12, "failed": 3, "success_rate": "80%"}. Question: What is the deployment success rate and how many failed? Answer in one sentence citing the numbers.',
    validator: (text: string) => {
      const has80 = text.includes("80%") || text.includes("80 percent");
      const has3 = text.includes("3") || text.includes("three");
      if (has80 && has3) return "verified";
      if (has80 || has3) return "marginal";
      return "insufficient";
    },
  },
};

/**
 * Verifies whether a model is capable of handling a given task
 * by sending a lightweight probe prompt and evaluating the response.
 *
 * This is advisory — it does not block configuration.
 */
export async function verifyModelCapability(
  client: LlmClient,
  task: TaskModelTask,
  model: string,
): Promise<CapabilityVerificationResult> {
  const probe = TASK_PROBE_PROMPTS[task];

  const result = await client["_call"](
    {
      prompt: probe.user,
      systemPrompt: probe.system,
      promptSummary: `Capability verification probe for ${task}`,
      maxTokens: 256,
    },
    model,
  );

  if (!result.ok) {
    return {
      task,
      model,
      status: "insufficient",
      explanation: `Model could not be reached: ${result.reason}`,
    };
  }

  const status = probe.validator(result.text);
  const explanations: Record<CapabilityVerificationResult["status"], string> = {
    verified: `Model produced expected output format and reasoning quality for ${task}.`,
    marginal: `Model produced partially correct output for ${task}. It may work but results could be inconsistent.`,
    insufficient: `Model did not produce usable output for ${task}. Consider using a more capable model.`,
  };

  return {
    task,
    model,
    status,
    explanation: explanations[status],
  };
}
