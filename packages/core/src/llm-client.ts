import type { DebriefWriter } from "./debrief.js";
import type { AgentType, LlmProviderConfig, LlmHealthStatus, TaskModelConfig, TaskModelTask, CapabilityLevel, TaskCapabilityResult, TaskGatingResult } from "./types.js";

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
  | { ok: true; text: string; model: string; responseTimeMs: number; notice?: string }
  | { ok: false; fallback: true; reason: string; gated?: boolean };

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
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

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
 * SYNTH_LLM_API_KEY since we never store it in settings.
 */
export function buildLlmConfigFromSettings(
  providerConfig?: LlmProviderConfig,
): LlmConfig {
  if (!providerConfig || !providerConfig.provider) {
    // No settings configured (or only apiKeyConfigured flag was stored) — fall back to pure env var resolution
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
    apiKey: process.env.SYNTH_LLM_API_KEY,
  };
}

// ---------------------------------------------------------------------------
// Task description helper
// ---------------------------------------------------------------------------

function taskDescription(task: TaskModelTask): string {
  switch (task) {
    case "logClassification": return "log classification";
    case "diagnosticSynthesis": return "diagnostic synthesis";
    case "postmortemGeneration": return "postmortem generation";
    case "queryAnswering": return "query answering";
  }
}

// ---------------------------------------------------------------------------
// LlmClient
// ---------------------------------------------------------------------------

export class LlmClient {
  private _anthropicClient: unknown = null;
  private _initialized = false;
  private _lastInitializedApiKey: string | undefined = undefined;
  private readonly _configuredApiKey: string | undefined;
  private readonly _provider: LlmSdkProvider;
  private readonly _baseUrl: string | undefined;
  private readonly _reasoningModel: string;
  private readonly _classificationModel: string;
  private readonly _timeoutMs: number;
  private readonly _rateLimitPerMinute: number;
  private readonly _taskModels: TaskModelConfig;
  private _callTimestamps: number[] = [];
  private _lastHealthCheck: LlmHealthStatus | null = null;
  private _capabilityResults: Map<string, TaskCapabilityResult> = new Map();

  constructor(
    private readonly _debrief: DebriefWriter,
    private readonly _agent: AgentType,
    config: LlmConfig = {},
  ) {
    this._configuredApiKey = config.apiKey;
    this._provider =
      config.provider ??
      (process.env.SYNTH_LLM_PROVIDER as LlmSdkProvider | undefined) ??
      "anthropic";
    this._baseUrl =
      config.baseUrl ?? process.env.SYNTH_LLM_BASE_URL;
    this._reasoningModel =
      config.reasoningModel ??
      config.model ??
      process.env.SYNTH_LLM_MODEL ??
      DEFAULT_REASONING_MODEL;
    this._classificationModel =
      config.classificationModel ?? process.env.SYNTH_LLM_CLASSIFICATION_MODEL ?? DEFAULT_CLASSIFICATION_MODEL;
    this._timeoutMs =
      config.timeoutMs ??
      (process.env.SYNTH_LLM_TIMEOUT_MS
        ? parseInt(process.env.SYNTH_LLM_TIMEOUT_MS, 10)
        : DEFAULT_TIMEOUT_MS);
    this._rateLimitPerMinute =
      config.rateLimitPerMinute ??
      (process.env.SYNTH_LLM_RATE_LIMIT
        ? parseInt(process.env.SYNTH_LLM_RATE_LIMIT, 10)
        : DEFAULT_RATE_LIMIT_PER_MINUTE);
    this._taskModels = config.taskModels ?? {};
  }

  /**
   * Returns the effective API key — prefers explicitly configured key,
   * falls back to env var read at call time (not cached at construction).
   */
  private get _apiKey(): string | undefined {
    return this._configuredApiKey ?? process.env.SYNTH_LLM_API_KEY;
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
        await client.messages.create(
          {
            model: this._classificationModel,
            max_tokens: 1,
            system: "health check",
            messages: [{ role: "user", content: "ping" }],
          },
          { signal: controller.signal },
        );

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

  // -------------------------------------------------------------------------
  // Capability gating
  // -------------------------------------------------------------------------

  private _capabilityKey(task: TaskModelTask, model: string): string {
    return `${task}:${model}`;
  }

  /**
   * Record a capability verification result for a task/model pair.
   * Called by verifyModelCapability after probe verification completes.
   */
  recordCapability(result: TaskCapabilityResult): void {
    this._capabilityResults.set(
      this._capabilityKey(result.task, result.model),
      result,
    );
  }

  /**
   * Get the capability level for a given task, based on previously
   * recorded verification results. Returns 'unverified' if no
   * verification has been recorded for the task's current model.
   */
  getCapabilityLevel(task: TaskModelTask): CapabilityLevel {
    const model = this.getModelForTask(task);
    const result = this._capabilityResults.get(
      this._capabilityKey(task, model),
    );
    return result?.level ?? "unverified";
  }

  /**
   * Check whether a task should proceed given capability verification results.
   *
   * - Classification is never gated (lightweight enough for any model).
   * - 'verified' proceeds silently.
   * - 'marginal' and 'unverified' proceed with a notice attached.
   * - 'insufficient' blocks the LLM call entirely.
   */
  checkTaskGating(task: TaskModelTask): TaskGatingResult {
    // Classification is never gated
    if (task === "logClassification") {
      return { proceed: true, level: "verified", notice: null };
    }

    const level = this.getCapabilityLevel(task);
    const model = this.getModelForTask(task);

    switch (level) {
      case "verified":
        return { proceed: true, level, notice: null };
      case "marginal":
      case "unverified":
        return {
          proceed: true,
          level,
          notice: `This analysis was generated by ${model}, which ${level === "marginal" ? "scored marginal" : "has not been verified"} on ${taskDescription(task)} during capability verification. Results may lack specificity. Consider configuring a more capable model in Settings > Model Configuration.`,
        };
      case "insufficient":
        return {
          proceed: false,
          level,
          notice: `${taskDescription(task)} requires capabilities that ${model} did not demonstrate during capability verification.`,
          model,
          task,
        };
    }
  }

  /**
   * Reasoning task — uses the larger model (Sonnet) by default.
   * For synthesis: postmortems, answer generation, diagnostic reports.
   * An optional `task` parameter routes to a per-task model override if configured.
   *
   * When a task is provided, capability gating is checked:
   * - 'insufficient' models are blocked before the LLM call is made.
   * - 'marginal' / 'unverified' models proceed with a notice attached to the result.
   * - 'verified' models proceed silently.
   * - Classification tasks are never gated.
   */
  async reason(params: LlmCallParams, task?: TaskModelTask): Promise<LlmResult> {
    const model = this._resolveTaskModel(task) ?? this._reasoningModel;

    // Apply capability gating when a task is specified
    if (task) {
      const gating = this.checkTaskGating(task);

      if (!gating.proceed) {
        // Record the gating decision to debrief
        this._recordGatingDebrief(params, task, model, gating);
        return { ok: false, fallback: true, reason: gating.notice!, gated: true };
      }

      // Record gating decision for marginal/unverified before the call
      if (gating.notice) {
        this._recordGatingDebrief(params, task, model, gating);
      }

      // Proceed with the LLM call, attaching notice if present
      const result = await this._call(params, model);

      if (result.ok && gating.notice) {
        return { ...result, notice: gating.notice };
      }

      return result;
    }

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
      console.log(`[LlmClient._call] NOT AVAILABLE: ${reason}`);
      this._recordDebrief(params, model, null, reason, true);
      return { ok: false, fallback: true, reason };
    }

    try {
      await this._ensureInitialized();
    } catch (error) {
      const reason = `LLM call failed: ${error instanceof Error ? error.message : String(error)}`;
      console.log(`[LlmClient._call] INIT FAILED: ${reason}`);
      this._recordDebrief(params, model, null, reason, true);
      return { ok: false, fallback: true, reason };
    }

    if (!this._checkRateLimit()) {
      const reason = `LLM rate limit exceeded (${this._rateLimitPerMinute} calls/min). Timestamps in window: ${this._callTimestamps.length}`;
      console.log(`[LlmClient._call] RATE LIMITED: ${reason}`);
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
        const response = await client.messages.create(
          {
            model,
            max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
            system: params.systemPrompt,
            messages: [{ role: "user", content: params.prompt }],
          },
          { signal: controller.signal },
        );

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
      const msg = error instanceof Error ? error.message : String(error);
      const isTimeout =
        (error instanceof Error && error.name === "AbortError") ||
        msg.includes("aborted") ||
        msg.includes("abort");
      const reason = isTimeout
        ? `LLM request timed out after ${this._timeoutMs}ms`
        : `LLM call failed: ${msg}`;
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
        return "LLM not configured — SYNTH_LLM_API_KEY not set";
      case "bedrock":
        return "LLM not configured — AWS_REGION not set for Bedrock provider";
      case "vertex":
        return "LLM not configured — CLOUD_ML_REGION and/or ANTHROPIC_VERTEX_PROJECT_ID not set for Vertex provider";
      case "openai-compatible":
        return "LLM not configured — SYNTH_LLM_BASE_URL not set for openai-compatible provider";
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
    const currentKey = this._apiKey;
    if (this._initialized && currentKey === this._lastInitializedApiKey) return;
    // Reset so we re-initialize with the current key
    this._initialized = false;
    this._lastInitializedApiKey = currentKey;

    switch (this._provider) {
      case "anthropic": {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        this._anthropicClient = new Anthropic({ apiKey: currentKey });
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

  private _recordGatingDebrief(
    params: LlmCallParams,
    task: TaskModelTask,
    model: string,
    gating: TaskGatingResult,
  ): void {
    const action = gating.proceed ? "proceeded" : "skipped";
    this._debrief.record({
      partitionId: params.partitionId ?? null,
      deploymentId: params.deploymentId ?? null,
      agent: this._agent,
      decisionType: "llm-call",
      decision: `Task ${taskDescription(task)} gated: ${gating.level}`,
      reasoning: gating.notice ?? `Capability level ${gating.level} — no notice.`,
      context: {
        task,
        model,
        level: gating.level,
        userChoice: action,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Probe loop — agentic tool-use loop for pre-flight environment discovery
  // -------------------------------------------------------------------------

  /**
   * Runs an agentic LLM loop that provides the model with a `probe(command)`
   * tool during planning. The LLM calls the tool to discover real machine state
   * before generating its final response.
   *
   * Supports both Anthropic native tool_use (Anthropic/Bedrock/Vertex providers)
   * and OpenAI function-calling (openai-compatible provider).
   *
   * When probe() is called, `onProbe` is invoked with the command string. The
   * caller is responsible for executing the probe safely and returning the
   * output string (or a blocked/error message) to be fed back to the LLM.
   *
   * The loop continues until the model stops calling the tool (stop_reason
   * "end_turn" for Anthropic, finish_reason "stop" for OpenAI-compatible) or
   * `maxProbes` turns are exhausted.
   */
  async callWithProbeLoop(opts: {
    systemPrompt: string;
    prompt: string;
    onProbe: (command: string) => Promise<string>;
    maxProbes?: number;
    maxTokens?: number;
    promptSummary: string;
    partitionId?: string | null;
    deploymentId?: string | null;
  }): Promise<LlmResult> {
    console.log(`[LlmClient.callWithProbeLoop] Entry — available: ${this.isAvailable()}, timestamps: ${this._callTimestamps.length}`);
    if (!this.isAvailable()) {
      const reason = this._notConfiguredReason();
      console.log(`[LlmClient.callWithProbeLoop] NOT AVAILABLE: ${reason}`);
      return { ok: false, fallback: true, reason };
    }

    try {
      await this._ensureInitialized();
    } catch (error) {
      const reason = `LLM call failed: ${error instanceof Error ? error.message : String(error)}`;
      console.log(`[LlmClient.callWithProbeLoop] INIT FAILED: ${reason}`);
      return { ok: false, fallback: true, reason };
    }

    const maxProbes = opts.maxProbes ?? 20;
    const maxTokens = opts.maxTokens ?? 4096;
    const model = this._reasoningModel;

    // Rate-limit the entire probe loop as a single logical call, not each turn.
    if (!this._checkRateLimit()) {
      console.log(`[LlmClient.callWithProbeLoop] RATE LIMITED: timestamps=${this._callTimestamps.length}, limit=${this._rateLimitPerMinute}`);
      return { ok: false, fallback: true, reason: `LLM rate limit exceeded (${this._rateLimitPerMinute} calls/min)` };
    }
    this._callTimestamps.push(Date.now());

    return this._provider === "openai-compatible"
      ? this._probeLoopOpenAI(opts, model, maxProbes, maxTokens)
      : this._probeLoopAnthropic(opts, model, maxProbes, maxTokens);
  }

  private async _probeLoopAnthropic(
    opts: Parameters<LlmClient["callWithProbeLoop"]>[0],
    model: string,
    maxProbes: number,
    maxTokens: number,
  ): Promise<LlmResult> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = this._anthropicClient as any;

    const probeTool = {
      name: "probe",
      description:
        "Run a read-only shell command to discover real machine state. " +
        "Use this to check tool availability (which), paths (ls, stat, find), " +
        "running processes (ps, systemctl status), OS details (uname, cat /etc/os-release), " +
        "disk space (df), user context (id, whoami), and any other observable facts " +
        "your plan depends on. Only read-only commands are permitted.",
      input_schema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The read-only shell command to run (e.g. 'which docker', 'ls /opt/app', 'cat /etc/os-release')",
          },
        },
        required: ["command"],
      },
    };

    // Multi-turn message history
    const messages: Array<{ role: string; content: unknown }> = [
      { role: "user", content: opts.prompt },
    ];

    let probeCount = 0;
    const startTime = Date.now();

    for (let turn = 0; turn <= maxProbes; turn++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeoutMs);

      let response: {
        content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
        stop_reason: string;
      };

      try {
        response = await client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            system: opts.systemPrompt,
            tools: [probeTool],
            messages,
          },
          { signal: controller.signal },
        );
      } catch (error) {
        clearTimeout(timer);
        const msg = error instanceof Error ? error.message : String(error);
        // The Anthropic SDK throws APIUserAbortError (name="Error", message="Request was aborted.")
        // when AbortController fires. Check both the native AbortError and the SDK wrapper.
        const isTimeout =
          (error instanceof Error && error.name === "AbortError") ||
          msg.includes("aborted") ||
          msg.includes("abort");
        const reason = isTimeout
          ? `LLM request timed out after ${this._timeoutMs}ms (turn ${turn + 1})`
          : `LLM call failed: ${msg}`;
        console.log(`[LlmClient.probeLoop] Error on turn ${turn + 1}: ${reason}`);
        return { ok: false, fallback: true, reason };
      } finally {
        clearTimeout(timer);
      }

      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      const textBlocks = response.content.filter((b) => b.type === "text");

      // No tool calls — LLM is done
      if (response.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
        const text = textBlocks.map((b) => b.text ?? "").join("").trim();
        const responseTimeMs = Date.now() - startTime;
        this._recordDebrief(
          { ...opts, maxTokens },
          model,
          responseTimeMs,
          null,
          false,
        );
        return { ok: true, text, model, responseTimeMs };
      }

      if (probeCount >= maxProbes) {
        // Safety limit hit — take whatever text the LLM has so far
        const text = textBlocks.map((b) => b.text ?? "").join("").trim();
        const responseTimeMs = Date.now() - startTime;
        return {
          ok: true,
          text: text || "{}",
          model,
          responseTimeMs,
          notice: `Probe limit (${maxProbes}) reached — plan generated from partial observations.`,
        };
      }

      // Append the assistant turn (including tool_use blocks)
      messages.push({ role: "assistant", content: response.content });

      // Execute probes and collect tool_result blocks
      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
      }> = [];

      for (const toolUse of toolUseBlocks) {
        const command = (toolUse.input as { command?: string })?.command ?? "";
        const output = await opts.onProbe(command);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id ?? "",
          content: output,
        });
        probeCount++;
      }

      messages.push({ role: "user", content: toolResults });
    }

    return {
      ok: false,
      fallback: true,
      reason: `Probe loop exceeded ${maxProbes} turns without producing a plan`,
    };
  }

  private async _probeLoopOpenAI(
    opts: Parameters<LlmClient["callWithProbeLoop"]>[0],
    model: string,
    maxProbes: number,
    maxTokens: number,
  ): Promise<LlmResult> {
    const baseUrl = (this._baseUrl ?? "http://localhost:11434/v1").replace(/\/+$/, "");
    const apiKey = this._apiKey;

    const probeTool = {
      type: "function" as const,
      function: {
        name: "probe",
        description:
          "Run a read-only shell command to discover real machine state. " +
          "Use this to check tool availability (which), paths (ls, stat), " +
          "running processes (ps), OS details (uname, cat /etc/os-release), " +
          "disk space (df), and any facts your plan depends on.",
        parameters: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "The read-only shell command to run",
            },
          },
          required: ["command"],
        },
      },
    };

    type OaiMessage = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string };
    const messages: OaiMessage[] = [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.prompt },
    ];

    let probeCount = 0;
    const startTime = Date.now();

    for (let turn = 0; turn <= maxProbes; turn++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._timeoutMs);

      let json: {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason?: string;
        }>;
      };

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages,
            tools: [probeTool],
            tool_choice: "auto",
          }),
          signal: controller.signal,
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          return { ok: false, fallback: true, reason: `OpenAI-compatible API returned ${resp.status}: ${body}` };
        }

        json = await resp.json() as typeof json;
      } catch (error) {
        clearTimeout(timer);
        const msg = error instanceof Error ? error.message : String(error);
        const isTimeout =
          (error instanceof Error && error.name === "AbortError") ||
          msg.includes("aborted") ||
          msg.includes("abort");
        const reason = isTimeout
          ? `LLM request timed out after ${this._timeoutMs}ms (turn ${turn + 1})`
          : `LLM call failed: ${msg}`;
        console.log(`[LlmClient.probeLoop] Error on turn ${turn + 1}: ${reason}`);
        return { ok: false, fallback: true, reason };
      } finally {
        clearTimeout(timer);
      }

      const choice = json.choices?.[0];
      const message = choice?.message;
      const toolCalls = message?.tool_calls ?? [];
      const finishReason = choice?.finish_reason;

      // No tool calls — LLM is done
      if (finishReason !== "tool_calls" || toolCalls.length === 0) {
        const text = (message?.content ?? "").trim();
        const responseTimeMs = Date.now() - startTime;
        this._recordDebrief(
          { ...opts, maxTokens },
          model,
          responseTimeMs,
          null,
          false,
        );
        return { ok: true, text, model, responseTimeMs };
      }

      if (probeCount >= maxProbes) {
        const text = (message?.content ?? "").trim();
        const responseTimeMs = Date.now() - startTime;
        return {
          ok: true,
          text: text || "{}",
          model,
          responseTimeMs,
          notice: `Probe limit (${maxProbes}) reached — plan generated from partial observations.`,
        };
      }

      // Append assistant message
      messages.push({
        role: "assistant",
        content: message?.content ?? null,
        tool_calls: toolCalls,
      });

      // Execute probes and append tool results
      for (const toolCall of toolCalls) {
        let command = "";
        try {
          const parsed = JSON.parse(toolCall.function.arguments) as { command?: string };
          command = parsed.command ?? "";
        } catch {
          command = toolCall.function.arguments;
        }

        const output = await opts.onProbe(command);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: output,
          name: "probe",
        });
        probeCount++;
      }
    }

    return {
      ok: false,
      fallback: true,
      reason: `Probe loop exceeded ${maxProbes} turns without producing a plan`,
    };
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
// Error message helpers
// ---------------------------------------------------------------------------

/**
 * Extracts a human-readable error message from raw API error strings.
 * Anthropic SDK errors include the HTTP status + raw JSON body — this
 * pulls out just the "message" field from the JSON when present.
 */
export function extractApiErrorMessage(raw: string): string {
  const match = raw.match(/"message"\s*:\s*"([^"]+)"/);
  if (match) return match[1];
  // If no JSON message found, strip any JSON-looking blobs
  const stripped = raw.replace(/\{[^}]{20,}\}/g, "").trim();
  return stripped || raw;
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
      // Extract JSON object from the response — greedy so nested objects don't truncate early
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.category && parsed.severity) return "verified";
          if (parsed.category || parsed.severity) return "marginal";
        } catch { /* fall through */ }
      }
      return "insufficient";
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
    const cleanReason = extractApiErrorMessage(result.reason);
    // Record insufficient capability when the model cannot be reached
    client.recordCapability({
      task,
      model,
      level: "insufficient",
      verifiedAt: new Date(),
      details: `Model could not be reached: ${cleanReason}`,
    });
    return {
      task,
      model,
      status: "insufficient",
      explanation: `Model could not be reached: ${cleanReason}`,
    };
  }

  const status = probe.validator(result.text);
  const explanations: Record<CapabilityVerificationResult["status"], string> = {
    verified: `Model produced expected output format and reasoning quality for ${task}.`,
    marginal: `Model produced partially correct output for ${task}. It may work but results could be inconsistent.`,
    insufficient: `Model did not produce usable output for ${task}. Consider using a more capable model.`,
  };

  // Record the capability verification result for runtime gating
  client.recordCapability({
    task,
    model,
    level: status,
    verifiedAt: new Date(),
    details: explanations[status],
  });

  return {
    task,
    model,
    status,
    explanation: explanations[status],
  };
}
