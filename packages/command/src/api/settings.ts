import type { FastifyInstance } from "fastify";
import type { ISettingsStore, AppSettings } from "@deploystack/core";
import { UpdateSettingsSchema } from "./schemas.js";

export function registerSettingsRoutes(
  app: FastifyInstance,
  settings: ISettingsStore,
): void {
  // Get all settings
  app.get("/api/settings", async () => {
    return { settings: settings.get() };
  });

  // Update settings (partial merge)
  app.put("/api/settings", async (request, reply) => {
    const parsed = UpdateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }
    const updated = settings.update(parsed.data as Partial<AppSettings>);
    return { settings: updated };
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
