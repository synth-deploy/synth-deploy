import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ISecurityBoundaryStore, ITelemetryStore } from "@synth-deploy/core";
import { SetSecurityBoundariesSchema } from "./schemas.js";
import { requirePermission } from "../middleware/permissions.js";

export function registerSecurityBoundaryRoutes(
  app: FastifyInstance,
  securityBoundaryStore: ISecurityBoundaryStore,
  telemetry: ITelemetryStore,
): void {
  // Get boundaries for envoy
  app.get<{ Params: { envoyId: string } }>(
    "/api/envoys/:envoyId/security-boundaries",
    { preHandler: [requirePermission("envoy.view")] },
    async (request) => {
      const boundaries = securityBoundaryStore.get(request.params.envoyId);
      return { boundaries };
    },
  );

  // Set/replace boundaries for envoy
  app.put<{ Params: { envoyId: string } }>(
    "/api/envoys/:envoyId/security-boundaries",
    { preHandler: [requirePermission("envoy.configure")] },
    async (request, reply) => {
      const parsed = SetSecurityBoundariesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      const boundaries = parsed.data.boundaries.map((b) => ({
        id: crypto.randomUUID(),
        envoyId: request.params.envoyId,
        boundaryType: b.boundaryType,
        config: b.config,
      }));

      securityBoundaryStore.set(request.params.envoyId, boundaries);
      telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "security-boundary.updated", target: { type: "envoy", id: request.params.envoyId }, details: { boundaryCount: boundaries.length } });
      return { boundaries };
    },
  );

  // Remove all boundaries for envoy
  app.delete<{ Params: { envoyId: string } }>(
    "/api/envoys/:envoyId/security-boundaries",
    { preHandler: [requirePermission("envoy.configure")] },
    async (request, reply) => {
      securityBoundaryStore.delete(request.params.envoyId);
      return reply.status(204).send();
    },
  );
}
