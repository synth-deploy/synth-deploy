import type { FastifyInstance } from "fastify";
import type { ISettingsStore, ITelemetryStore, AppSettings, LlmProviderConfig } from "@synth-deploy/core";
import { UpdateSettingsSchema } from "./schemas.js";
import { requirePermission } from "../middleware/permissions.js";
import { requireEnterprise, getEdition, getLicenseInfo, getMaxEnvoys, isPartnership, ENTERPRISE_FEATURES } from "@synth-deploy/core";
import { invalidateLlmHealthCache } from "./health.js";

/**
 * Strips API key from LLM settings before returning to the frontend.
 * The apiKeyConfigured field tells the UI whether a key is set without exposing it.
 */
function sanitizeLlmSettings(settings: AppSettings): AppSettings {
  const sanitized = structuredClone(settings);

  if (sanitized.llm) {
    // Remove any raw apiKey that leaked into the config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (sanitized.llm as any)["apiKey"];
    // Ensure apiKeyConfigured reflects whether an env var key is set
    sanitized.llm.apiKeyConfigured =
      typeof process.env.SYNTH_LLM_API_KEY === "string" &&
      process.env.SYNTH_LLM_API_KEY.length > 0;

    if (sanitized.llm.fallbacks) {
      for (const fb of sanitized.llm.fallbacks) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (fb as any)["apiKey"];
        fb.apiKeyConfigured =
          typeof process.env.SYNTH_LLM_API_KEY === "string" &&
          process.env.SYNTH_LLM_API_KEY.length > 0;
      }
    }
  }

  return sanitized;
}

/**
 * Strips API key from incoming LLM provider config before persisting.
 * API keys are stored in environment variables only — never in the settings store.
 */
function stripApiKeyFromConfig(
  llmConfig: LlmProviderConfig & { apiKey?: string },
): LlmProviderConfig {
  const { apiKey: _apiKey, ...rest } = llmConfig;
  return {
    ...rest,
    apiKeyConfigured:
      typeof process.env.SYNTH_LLM_API_KEY === "string" &&
      process.env.SYNTH_LLM_API_KEY.length > 0,
  };
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  settings: ISettingsStore,
  telemetry: ITelemetryStore,
): void {
  // Get all settings
  app.get("/api/settings", { preHandler: [requirePermission("settings.manage")] }, async () => {
    return { settings: sanitizeLlmSettings(settings.get()) };
  });

  // Update settings (partial merge)
  app.put("/api/settings", { preHandler: [requirePermission("settings.manage")] }, async (request, reply) => {
    const parsed = UpdateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
      return reply.status(400).send({ error: msg || "Invalid input" });
    }

    // Gate enterprise-only settings
    const data = parsed.data as Partial<AppSettings> & { llm?: LlmProviderConfig & { apiKey?: string } };
    if (data.coBranding) requireEnterprise("co-branding");
    if (data.mcpServers && data.mcpServers.length > 0) requireEnterprise("mcp-servers");

    // Persist API key encrypted in DB and apply to process env, then strip before storing settings
    if (data.llm) {
      if (data.llm.apiKey && data.llm.apiKey.length > 0) {
        settings.setSecret("llm_api_key", data.llm.apiKey);
        process.env.SYNTH_LLM_API_KEY = data.llm.apiKey;
        invalidateLlmHealthCache();
      }
      data.llm = stripApiKeyFromConfig(data.llm);
    }

    const updated = settings.update(data as Partial<AppSettings>);
    telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "settings.updated", target: { type: "settings", id: "app" }, details: { fields: Object.keys(parsed.data) } });
    return { settings: sanitizeLlmSettings(updated) };
  });

  // Edition info — public (no auth required), used by UI to render edition badge and gate features
  app.get("/api/edition", async () => {
    const edition = getEdition();
    const license = getLicenseInfo();
    return {
      edition,
      maxEnvoys: getMaxEnvoys(),
      partnership: isPartnership(),
      license,
      features: ENTERPRISE_FEATURES,
    };
  });

  // Read-only command info
  app.get("/api/settings/command-info", { preHandler: [requirePermission("settings.manage")] }, async () => {
    return {
      info: {
        version: "0.1.0",
        host: process.env.HOST ?? "0.0.0.0",
        port: parseInt(process.env.PORT ?? "3000", 10),
        startedAt: commandStartTime,
      },
    };
  });
}

const commandStartTime = new Date().toISOString();
