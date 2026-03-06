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

// Cached LLM health result (30-second TTL)
let llmHealthCache: { healthy: boolean; checkedAt: number } | null = null;
const LLM_HEALTH_CACHE_TTL_MS = 30_000;

export function registerHealthRoutes(
  app: FastifyInstance,
  options?: HealthCheckOptions,
): void {
  app.get("/health", async () => {
    if (!options) {
      return { status: "ok", service: "synth-command", timestamp: new Date().toISOString() };
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
      service: "synth-command",
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

    // Lightweight ping to verify the provider is reachable
    let healthy = false;
    try {
      const apiKey = options?.llmApiKey ?? process.env.SYNTH_LLM_API_KEY;
      const baseUrl = options?.llmBaseUrl ?? process.env.SYNTH_LLM_BASE_URL ?? "https://api.anthropic.com";
      const provider = detectProvider();

      if (provider === "anthropic" && apiKey) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        healthy = res.status < 500;
      } else if (provider === "openai-compatible") {
        // For openai-compatible, just check the base URL is reachable
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
          signal: controller.signal,
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        });
        clearTimeout(timeout);
        healthy = res.status < 500;
      } else {
        // For bedrock/vertex, assume healthy if configured (SDK handles auth)
        healthy = true;
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
type VerifyStatus = "verified" | "marginal" | "insufficient";

interface CapabilityVerificationResult {
  task: string;
  model: string;
  status: VerifyStatus;
  explanation: string;
}

const PROBE_PROMPTS: Record<TaskModelTask, { system: string; user: string; validator: (text: string) => VerifyStatus }> = {
  logClassification: {
    system: "You are a log classifier. Respond ONLY with valid JSON.",
    user: 'Classify this log line into a category. Log: "ERROR 2025-01-15 Connection refused on port 5432". Respond with JSON: {"category": "<string>", "severity": "<string>"}',
    validator: (text: string) => {
      try {
        const parsed = JSON.parse(text.trim());
        if (parsed.category && parsed.severity) return "verified";
        return "marginal";
      } catch {
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

async function runTaskModelVerification(
  client: LlmClient,
  task: string,
  model: string,
): Promise<CapabilityVerificationResult> {
  const probe = PROBE_PROMPTS[task as TaskModelTask];
  if (!probe) {
    return { task, model, status: "insufficient", explanation: `Unknown task: ${task}` };
  }

  // Use classify() for the probe — it's lightweight and won't use reasoning budget
  const result = await client.classify({
    prompt: probe.user,
    systemPrompt: probe.system,
    promptSummary: `Capability verification probe for ${task}`,
    maxTokens: 256,
  });

  if (!result.ok) {
    return {
      task,
      model,
      status: "insufficient",
      explanation: `Model could not be reached: ${result.reason}`,
    };
  }

  const status = probe.validator(result.text);
  const explanations: Record<VerifyStatus, string> = {
    verified: `Model produced expected output format and reasoning quality for ${task}.`,
    marginal: `Model produced partially correct output for ${task}. It may work but results could be inconsistent.`,
    insufficient: `Model did not produce usable output for ${task}. Consider using a more capable model.`,
  };

  return { task, model, status, explanation: explanations[status] };
}

function detectProvider(): string | undefined {
  return process.env.SYNTH_LLM_PROVIDER ?? "anthropic";
}
