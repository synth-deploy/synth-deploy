import type { FastifyInstance } from "fastify";
import type { ISettingsStore, ITelemetryStore, IDeploymentStore, DebriefReader } from "@synth-deploy/core";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";
import { requirePermission } from "../middleware/permissions.js";

export function registerEnvoyRoutes(
  app: FastifyInstance,
  settings: ISettingsStore,
  registry: EnvoyRegistry,
  telemetry: ITelemetryStore,
  deployments: IDeploymentStore,
  debrief: DebriefReader,
): void {
  // List all registered Envoys (cached data — no live probe)
  app.get("/api/envoys", { preHandler: [requirePermission("envoy.view")] }, async () => {
    let entries = registry.listEntries();

    // Also include the legacy settings-based default envoy if no registry entries
    if (entries.length === 0) {
      const envoyConfig = settings.get().envoy;
      if (envoyConfig?.url) {
        const legacy = registry.register({
          name: "default",
          url: envoyConfig.url,
        });
        const entry = registry.get(legacy.id);
        if (entry) entries = [entry];
      }
    }

    return {
      envoys: entries.map((e) => ({
        id: e.id,
        name: e.name,
        url: e.url,
        health: e.health,
        hostname: e.hostname,
        os: e.os,
        lastSeen: e.lastSeen,
        summary: e.summary,
        readiness: e.readiness,
        assignedEnvironments: e.assignedEnvironments,
        assignedPartitions: e.assignedPartitions,
        envoyContext: e.envoyContext,
      })),
    };
  });

  // Register a new Envoy
  app.post("/api/envoys", { preHandler: [requirePermission("envoy.register")] }, async (request, reply) => {
    const body = request.body as {
      name: string;
      url: string;
      assignedEnvironments?: string[];
      assignedPartitions?: string[];
    };

    if (!body.name || !body.url) {
      return reply.status(400).send({ error: "name and url are required" });
    }

    const registration = registry.register({
      name: body.name,
      url: body.url,
      assignedEnvironments: body.assignedEnvironments,
      assignedPartitions: body.assignedPartitions,
    });

    // Probe health immediately after registration
    const entry = await registry.probe(registration.id);

    telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "envoy.registered", target: { type: "envoy", id: registration.id }, details: { name: body.name, url: body.url } });

    return reply.status(201).send({
      envoy: {
        id: registration.id,
        name: registration.name,
        url: registration.url,
        token: registration.token,
        assignedEnvironments: registration.assignedEnvironments,
        assignedPartitions: registration.assignedPartitions,
        registeredAt: registration.registeredAt,
        health: entry?.health ?? "Unreachable",
      },
    });
  });

  // Get a specific Envoy's cached status (instant, no live probe)
  app.get("/api/envoys/:id/health", { preHandler: [requirePermission("envoy.view")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = registry.get(id);

    if (!entry) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    return {
      envoy: {
        id: entry.id,
        name: entry.name,
        url: entry.url,
        health: entry.health,
        hostname: entry.hostname,
        os: entry.os,
        lastSeen: entry.lastSeen,
        summary: entry.summary,
        readiness: entry.readiness,
        assignedEnvironments: entry.assignedEnvironments,
        assignedPartitions: entry.assignedPartitions,
        envoyContext: entry.envoyContext,
      },
    };
  });

  // Live-probe a specific Envoy and update cached health
  app.post("/api/envoys/:id/probe", { preHandler: [requirePermission("envoy.view")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = await registry.probe(id);

    if (!entry) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    return {
      envoy: {
        id: entry.id,
        name: entry.name,
        url: entry.url,
        health: entry.health,
        hostname: entry.hostname,
        os: entry.os,
        lastSeen: entry.lastSeen,
        summary: entry.summary,
        readiness: entry.readiness,
        assignedEnvironments: entry.assignedEnvironments,
        assignedPartitions: entry.assignedPartitions,
        envoyContext: entry.envoyContext,
      },
    };
  });

  // Update an Envoy's configuration
  app.put("/api/envoys/:id", { preHandler: [requirePermission("envoy.configure")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      url?: string;
      assignedEnvironments?: string[];
      assignedPartitions?: string[];
    };

    const existing = registry.get(id);
    const updated = registry.update(id, body);
    if (!updated) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    const actor = (request.user?.email) ?? "anonymous";
    if (body.assignedEnvironments !== undefined && existing) {
      const prev = new Set(existing.assignedEnvironments);
      const next = new Set(body.assignedEnvironments);
      for (const envId of next) {
        if (!prev.has(envId)) telemetry.record({ actor, action: "envoy.connection.added", target: { type: "envoy", id }, details: { connectionType: "environment", targetId: envId } });
      }
      for (const envId of prev) {
        if (!next.has(envId)) telemetry.record({ actor, action: "envoy.connection.removed", target: { type: "envoy", id }, details: { connectionType: "environment", targetId: envId } });
      }
    }
    if (body.assignedPartitions !== undefined && existing) {
      const prev = new Set(existing.assignedPartitions);
      const next = new Set(body.assignedPartitions);
      for (const partId of next) {
        if (!prev.has(partId)) telemetry.record({ actor, action: "envoy.connection.added", target: { type: "envoy", id }, details: { connectionType: "partition", targetId: partId } });
      }
      for (const partId of prev) {
        if (!next.has(partId)) telemetry.record({ actor, action: "envoy.connection.removed", target: { type: "envoy", id }, details: { connectionType: "partition", targetId: partId } });
      }
    }

    return {
      envoy: {
        id: updated.id,
        name: updated.name,
        url: updated.url,
        assignedEnvironments: updated.assignedEnvironments,
        assignedPartitions: updated.assignedPartitions,
      },
    };
  });

  // Deregister an Envoy
  app.delete("/api/envoys/:id", { preHandler: [requirePermission("envoy.configure")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = registry.deregister(id);

    if (!removed) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    return reply.status(204).send();
  });

  // Rotate an Envoy's token
  app.post("/api/envoys/:id/rotate-token", { preHandler: [requirePermission("envoy.configure")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const newToken = registry.rotateToken(id);

    if (!newToken) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    return { token: newToken };
  });

  // Update an Envoy's context — user-provided information injected into LLM planning prompts
  app.put("/api/envoys/:id/context", { preHandler: [requirePermission("envoy.configure")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { context?: string | null };

    const context = body.context ?? null;
    if (context !== null && typeof context !== "string") {
      return reply.status(400).send({ error: "context must be a string or null" });
    }
    if (context !== null && context.length > 50_000) {
      return reply.status(400).send({ error: "context must not exceed 50,000 characters" });
    }

    const success = registry.updateEnvoyContext(id, context);
    if (!success) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "envoy.context.updated", target: { type: "envoy", id }, details: { contextLength: context?.length ?? 0 } });

    return { ok: true };
  });

  // Get accumulated knowledge for an Envoy — system observations from environment scans
  app.get("/api/envoys/:id/knowledge", { preHandler: [requirePermission("envoy.view")] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const entry = registry.get(id);
    if (!entry) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    const envoyDeployments = deployments.list().filter((d) => d.envoyId === id);
    const observations: { id: string; timestamp: string; text: string }[] = [];

    for (const d of envoyDeployments) {
      const entries = debrief.getByOperation(d.id);
      for (const e of entries) {
        if (e.decisionType === "environment-scan") {
          observations.push({ id: e.id, timestamp: e.timestamp.toISOString(), text: e.reasoning || e.decision });
        }
      }
    }

    // Sort newest first, cap at 20
    observations.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return { knowledge: observations.slice(0, 20) };
  });

  // Validate an Envoy token (used by Envoy report endpoint)
  app.post("/api/envoys/validate-token", async (request, reply) => {
    const body = request.body as { token: string };
    if (!body.token) {
      return reply.status(400).send({ error: "token is required" });
    }

    const envoy = registry.validateToken(body.token);
    if (!envoy) {
      return reply.status(401).send({ error: "Invalid token" });
    }

    return {
      valid: true,
      envoyId: envoy.id,
      envoyName: envoy.name,
    };
  });
}
