import type { DebriefWriter } from "./debrief.js";
import type { AgentType } from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LlmConfig {
  apiKey?: string;
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
    this._reasoningModel =
      config.reasoningModel ??
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
   * Synchronous check: is an API key configured?
   * Does NOT validate the key — just checks presence.
   */
  isAvailable(): boolean {
    return typeof this._apiKey === "string" && this._apiKey.length > 0;
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
      const reason = "LLM not configured — DEPLOYSTACK_LLM_API_KEY not set";
      this._recordDebrief(params, model, null, reason, true);
      return { ok: false, fallback: true, reason };
    }

    await this._ensureInitialized();

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
   * Lazy initialization of the Anthropic SDK client.
   * The SDK is dynamically imported on first use so that the module
   * can be loaded without the SDK installed (graceful degradation).
   */
  private async _ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    this._anthropicClient = new Anthropic({ apiKey: this._apiKey });
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
        responseTimeMs,
        promptSummary: params.promptSummary,
        fallbackUsed,
        ...(failureReason ? { failureReason } : {}),
      },
    });
  }
}
