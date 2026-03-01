import type { FastifyInstance } from "fastify";
import type { ISettingsStore, AppSettings } from "@deploystack/core";

export function registerSettingsRoutes(
  app: FastifyInstance,
  settings: ISettingsStore,
): void {
  // Get all settings
  app.get("/api/settings", async () => {
    return { settings: settings.get() };
  });

  // Update settings (partial merge)
  app.put("/api/settings", async (request) => {
    const updates = request.body as Partial<AppSettings>;
    const updated = settings.update(updates);
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
