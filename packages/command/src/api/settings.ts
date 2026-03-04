import type { FastifyInstance } from "fastify";
import type { ISettingsStore, AppSettings, LlmProviderConfig } from "@deploystack/core";
import { UpdateSettingsSchema } from "./schemas.js";

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
      typeof process.env.DEPLOYSTACK_LLM_API_KEY === "string" &&
      process.env.DEPLOYSTACK_LLM_API_KEY.length > 0;

    if (sanitized.llm.fallbacks) {
      for (const fb of sanitized.llm.fallbacks) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (fb as any)["apiKey"];
        fb.apiKeyConfigured =
          typeof process.env.DEPLOYSTACK_LLM_API_KEY === "string" &&
          process.env.DEPLOYSTACK_LLM_API_KEY.length > 0;
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
      typeof process.env.DEPLOYSTACK_LLM_API_KEY === "string" &&
      process.env.DEPLOYSTACK_LLM_API_KEY.length > 0,
  };
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  settings: ISettingsStore,
): void {
  // Get all settings
  app.get("/api/settings", async () => {
    return { settings: sanitizeLlmSettings(settings.get()) };
  });

  // Update settings (partial merge)
  app.put("/api/settings", async (request, reply) => {
    const parsed = UpdateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    // Strip API key from LLM config before persisting
    const data = parsed.data as Partial<AppSettings> & { llm?: LlmProviderConfig & { apiKey?: string } };
    if (data.llm) {
      data.llm = stripApiKeyFromConfig(data.llm);
    }

    const updated = settings.update(data as Partial<AppSettings>);
    return { settings: sanitizeLlmSettings(updated) };
  });

  // Read-only command info
  app.get("/api/settings/command-info", async () => {
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
