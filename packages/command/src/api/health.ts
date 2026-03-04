import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { LlmClient } from "@deploystack/core";

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
      return { status: "ok", service: "deploystack-server", timestamp: new Date().toISOString() };
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
      service: "deploystack-server",
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
      const apiKey = options?.llmApiKey ?? process.env.DEPLOYSTACK_LLM_API_KEY;
      const baseUrl = options?.llmBaseUrl ?? process.env.DEPLOYSTACK_LLM_BASE_URL ?? "https://api.anthropic.com";
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
}

function detectProvider(): string | undefined {
  return process.env.DEPLOYSTACK_LLM_PROVIDER ?? "anthropic";
}
