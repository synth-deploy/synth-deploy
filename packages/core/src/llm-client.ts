import type { DebriefWriter } from "./debrief.js";
import type { AgentType } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LlmProvider = "anthropic" | "bedrock" | "vertex" | "openai-compatible";

export interface LlmConfig {
  apiKey?: string;
  provider?: LlmProvider;
  baseUrl?: string;
  model?: string;
  reasoningModel?: string;
  classificationModel?: string;
  timeoutMs?: number;
  rateLimitPerMinute?: number;
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
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_REASONING_MODEL = "claude-sonnet-4-6";
const DEFAULT_CLASSIFICATION_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;

// ---------------------------------------------------------------------------
// LlmClient
// ---------------------------------------------------------------------------

export class LlmClient {
  private _anthropicClient: unknown = null;
  private _initialized = false;
  private readonly _apiKey: string | undefined;
  private readonly _provider: LlmProvider;
  private readonly _baseUrl: string | undefined;
  private readonly _reasoningModel: string;
  private readonly _classificationModel: string;
  private readonly _timeoutMs: number;
  private readonly _rateLimitPerMinute: number;
  private _callTimestamps: number[] = [];

  constructor(
    private readonly _debrief: DebriefWriter,
    private readonly _agent: AgentType,
    config: LlmConfig = {},
  ) {
    this._apiKey = config.apiKey ?? process.env.DEPLOYSTACK_LLM_API_KEY;
    this._provider =
      config.provider ??
      (process.env.DEPLOYSTACK_LLM_PROVIDER as LlmProvider | undefined) ??
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
   * Reasoning task — uses the larger model (Sonnet).
   * For synthesis: postmortems, answer generation, diagnostic reports.
   */
  async reason(params: LlmCallParams): Promise<LlmResult> {
    return this._call(params, this._reasoningModel);
  }

  /**
   * Classification task — uses the smaller model (Haiku).
   * For classification: intent parsing, error categorization.
   */
  async classify(params: LlmCallParams): Promise<LlmResult> {
    return this._call(params, this._classificationModel);
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
