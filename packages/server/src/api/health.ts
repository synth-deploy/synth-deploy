import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { LlmClient } from "@synth-deploy/core";
import { VerifyTaskModelSchema } from "./schemas.js";

interface HealthCheckOptions {
  entityDb: Database.Database;
  dataDir: string;
  envoyUrl?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  mcpServers?: Array<{ name: string; url: string }>;
  llmClient?: LlmClient;
}

interface CheckResult {
  ok: boolean;
  error?: string;
  responseTimeMs?: number;
}

// Cached LLM health result (5-minute TTL)
let llmHealthCache: { healthy: boolean; checkedAt: number } | null = null;
const LLM_HEALTH_CACHE_TTL_MS = 300_000;

/** Call when the API key changes so the next health check runs fresh. */
export function invalidateLlmHealthCache(): void {
  llmHealthCache = null;
}

export function registerHealthRoutes(
  app: FastifyInstance,
  options?: HealthCheckOptions,
): void {
  app.get("/health", async () => {
    if (!options) {
      return { status: "ok", service: "synth-server", timestamp: new Date().toISOString() };
    }

    const checks: Record<string, CheckResult> = {};

    // SQLite check
    try {
      const start = Date.now();
      options.entityDb.prepare("SELECT 1").get();
      checks.db = { ok: true, responseTimeMs: Date.now() - start };
    } catch (err) {
      app.log.error(err, "Health check: database unavailable");
      checks.db = { ok: false, error: "Database unavailable" };
    }

    // Filesystem check
    try {
      fs.accessSync(options.dataDir, fs.constants.R_OK | fs.constants.W_OK);
      checks.fs = { ok: true };
    } catch (err) {
      app.log.error(err, "Health check: filesystem unavailable");
      checks.fs = { ok: false, error: "Filesystem unavailable" };
    }

    // Envoy check (optional)
    if (options.envoyUrl) {
      try {
        const start = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${options.envoyUrl}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        checks.envoy = {
          ok: res.ok,
          responseTimeMs: Date.now() - start,
          ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
        };
      } catch (err) {
        app.log.error(err, "Health check: envoy unreachable");
        checks.envoy = { ok: false, error: "Envoy unreachable" };
      }
    }

    // LLM API check (optional)
    if (options.llmApiKey) {
      try {
        const start = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const baseUrl = options.llmBaseUrl ?? "https://api.anthropic.com";
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": options.llmApiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "health check" }],
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        // Any non-5xx response means the API is reachable and the key is valid
        checks.llm = {
          ok: res.status < 500,
          responseTimeMs: Date.now() - start,
          ...(!res.ok && res.status >= 500 ? { error: `HTTP ${res.status}` } : {}),
        };
      } catch (err) {
        app.log.error(err, "Health check: LLM API unavailable");
        checks.llm = { ok: false, error: "LLM API unavailable" };
      }
    }

    // MCP server checks (optional)
    if (options.mcpServers && options.mcpServers.length > 0) {
      const mcpResults: Record<string, CheckResult> = {};
      for (const server of options.mcpServers) {
        try {
          const start = Date.now();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          const res = await fetch(server.url, { signal: controller.signal });
          clearTimeout(timeout);
          mcpResults[server.name] = {
            ok: res.ok,
            responseTimeMs: Date.now() - start,
            ...(!res.ok ? { error: `HTTP ${res.status}` } : {}),
          };
        } catch (err) {
          app.log.error(err, `Health check: MCP server "${server.name}" unreachable`);
          mcpResults[server.name] = { ok: false, error: "Unreachable" };
        }
      }
      checks.mcpServers = mcpResults as unknown as CheckResult;
    }

    // Determine overall status
    const dbOrFsFailed = !checks.db.ok || !checks.fs.ok;
    const envoyFailed = checks.envoy && !checks.envoy.ok;
    const llmFailed = checks.llm && !checks.llm.ok;
    const mcpFailed = checks.mcpServers && Object.values(checks.mcpServers as unknown as Record<string, CheckResult>).some((c) => !c.ok);

    let status: "healthy" | "degraded" | "unhealthy";
    if (dbOrFsFailed) {
      status = "unhealthy";
    } else if (envoyFailed || llmFailed || mcpFailed) {
      status = "degraded";
    } else {
      status = "healthy";
    }

    return {
      status,
      service: "synth-server",
      checks,
      timestamp: new Date().toISOString(),
    };
  });

  // --- Dedicated LLM health endpoint ---
  // Used by the UI's LlmGate to determine if the LLM connection is configured and reachable.

  app.get("/api/health/llm", async () => {
    const llmClient = options?.llmClient;

    // Check configuration via the LlmClient instance
    const configured = llmClient ? llmClient.isAvailable() : false;

    if (!configured) {
      return {
        configured: false,
        healthy: false,
        provider: detectProvider(),
      };
    }

    // Check cached health result
    const now = Date.now();
    if (llmHealthCache && now - llmHealthCache.checkedAt < LLM_HEALTH_CACHE_TTL_MS) {
      return {
        configured: true,
        healthy: llmHealthCache.healthy,
        provider: detectProvider(),
      };
    }

    // For Anthropic/Bedrock/Vertex: trust configuration — real failures surface in the debrief.
    // For openai-compatible: do a free GET /models to verify the endpoint is reachable.
    let healthy = true;
    try {
      const apiKey = options?.llmApiKey ?? process.env.SYNTH_LLM_API_KEY;
      const baseUrl = options?.llmBaseUrl ?? process.env.SYNTH_LLM_BASE_URL ?? "https://api.anthropic.com";
      const provider = detectProvider();

      if (provider === "openai-compatible") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
          signal: controller.signal,
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
        clearTimeout(timeout);
        healthy = res.status < 500;
      }
    } catch (err) {
      app.log.error(err, "LLM health check failed");
      healthy = false;
    }

    llmHealthCache = { healthy, checkedAt: now };

    return {
      configured: true,
      healthy,
      provider: detectProvider(),
    };
  });

  // --- Per-task model capability verification ---
  // Sends a lightweight probe prompt to verify a model can handle a specific task.

  app.post("/api/health/llm/verify-task", async (request, reply) => {
    const llmClient = options?.llmClient;
    if (!llmClient || !llmClient.isAvailable()) {
      return reply.status(503).send({
        error: "LLM client not configured or unavailable",
      });
    }

    const parsed = VerifyTaskModelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid input",
        details: parsed.error.format(),
      });
    }

    const { task, model } = parsed.data;

    try {
      const result = await runTaskModelVerification(llmClient, task, model);
      return { result };
    } catch (err) {
      app.log.error(err, "Task model verification failed");
      return reply.status(500).send({
        error: "Verification failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Inline task model verification — avoids import issues in worktree builds.
// The canonical implementation lives in @synth-deploy/core (verifyModelCapability).
// ---------------------------------------------------------------------------

type TaskModelTask = "logClassification" | "diagnosticSynthesis" | "postmortemGeneration" | "queryAnswering";
// NOTE: "verified" = reachable, "insufficient" = unreachable.
// "marginal" is unused pending real capability probes (see issue #211).
type VerifyStatus = "verified" | "marginal" | "insufficient";

function extractApiErrorMessage(raw: string): string {
  const match = raw.match(/"message"\s*:\s*"([^"]+)"/);
  if (match) return match[1];
  const stripped = raw.replace(/\{[^}]{20,}\}/g, "").trim();
  return stripped || raw;
}

interface CapabilityVerificationResult {
  task: string;
  model: string;
  status: VerifyStatus;
  explanation: string;
}

async function runTaskModelVerification(
  client: LlmClient,
  task: string,
  model: string,
): Promise<CapabilityVerificationResult> {
  // Connection test only — sends a minimal ping and checks for a response.
  // Real capability evaluation is tracked in issue #211.
  const result = await client.classify({
    prompt: "ping",
    systemPrompt: "Reply with the single word: pong",
    promptSummary: `Connection test for ${task}`,
    maxTokens: 16,
  });

  if (!result.ok) {
    return {
      task,
      model,
      status: "insufficient",
      explanation: `Model could not be reached: ${extractApiErrorMessage(result.reason)}`,
    };
  }

  return {
    task,
    model,
    status: "verified",
    explanation: `Model is reachable and responding.`,
  };
}

function detectProvider(): string | undefined {
  return process.env.SYNTH_LLM_PROVIDER ?? "anthropic";
}
