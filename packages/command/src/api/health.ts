import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface HealthCheckOptions {
  entityDb: Database.Database;
  dataDir: string;
  envoyUrl?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  mcpServers?: Array<{ name: string; url: string }>;
}

interface CheckResult {
  ok: boolean;
  error?: string;
  responseTimeMs?: number;
}

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
}
