import type { FastifyInstance } from "fastify";
import type { ITelemetryStore, TelemetryAction } from "@deploystack/core";
import { TelemetryQuerySchema } from "./schemas.js";
import { requirePermission } from "../middleware/permissions.js";

export function registerTelemetryRoutes(
  app: FastifyInstance,
  telemetryStore: ITelemetryStore,
): void {
  app.get("/api/telemetry", { preHandler: [requirePermission("settings.manage")] }, async (request) => {
    const parsed = TelemetryQuerySchema.safeParse(request.query);
    const filters = parsed.success ? parsed.data : {};

    const events = telemetryStore.query({
      actor: filters.actor,
      action: filters.action as TelemetryAction | undefined,
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(filters.to) : undefined,
      limit: filters.limit ?? 50,
      offset: filters.offset ?? 0,
    });

    const total = telemetryStore.count({
      actor: filters.actor,
      action: filters.action as TelemetryAction | undefined,
      from: filters.from ? new Date(filters.from) : undefined,
      to: filters.to ? new Date(filters.to) : undefined,
    });

    return { events, total };
  });
}
