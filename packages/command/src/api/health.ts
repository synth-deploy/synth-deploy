import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

interface HealthCheckOptions {
  entityDb: Database.Database;
  dataDir: string;
  envoyUrl?: string;
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
      checks.db = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Filesystem check
    try {
      fs.accessSync(options.dataDir, fs.constants.R_OK | fs.constants.W_OK);
      checks.fs = { ok: true };
    } catch (err) {
      checks.fs = { ok: false, error: err instanceof Error ? err.message : String(err) };
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
        checks.envoy = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // Determine overall status
    const dbOrFsFailed = !checks.db.ok || !checks.fs.ok;
    const envoyFailed = checks.envoy && !checks.envoy.ok;

    let status: "healthy" | "degraded" | "unhealthy";
    if (dbOrFsFailed) {
      status = "unhealthy";
    } else if (envoyFailed) {
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
