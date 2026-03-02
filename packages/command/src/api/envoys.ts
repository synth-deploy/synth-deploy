import type { FastifyInstance } from "fastify";
import type { ISettingsStore } from "@deploystack/core";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";

export function registerEnvoyRoutes(
  app: FastifyInstance,
  settings: ISettingsStore,
  registry: EnvoyRegistry,
): void {
  // List all registered Envoys with live health probing
  app.get("/api/envoys", async () => {
    const entries = await registry.probeAll();

    // Also include the legacy settings-based default envoy if no registry entries
    if (entries.length === 0) {
      const envoyConfig = settings.get().envoy;
      if (envoyConfig?.url) {
        const legacy = registry.register({
          name: "default",
          url: envoyConfig.url,
        });
        const probed = await registry.probe(legacy.id);
        if (probed) entries.push(probed);
      }
    }

    return {
      envoys: entries.map((e) => ({
        id: e.id,
        name: e.name,
        url: e.url,
        health: e.health,
        hostname: e.hostname,
        lastSeen: e.lastSeen,
        summary: e.summary,
        readiness: e.readiness,
        assignedEnvironments: e.assignedEnvironments,
      })),
    };
  });

  // Register a new Envoy
  app.post("/api/envoys", async (request, reply) => {
    const body = request.body as {
      name: string;
      url: string;
      assignedEnvironments?: string[];
    };

    if (!body.name || !body.url) {
      return reply.status(400).send({ error: "name and url are required" });
    }

    const registration = registry.register({
      name: body.name,
      url: body.url,
      assignedEnvironments: body.assignedEnvironments,
    });

    // Probe health immediately after registration
    const entry = await registry.probe(registration.id);

    return reply.status(201).send({
      envoy: {
        id: registration.id,
        name: registration.name,
        url: registration.url,
        token: registration.token,
        assignedEnvironments: registration.assignedEnvironments,
        registeredAt: registration.registeredAt,
        health: entry?.health ?? "Unreachable",
      },
    });
  });

  // Get a specific Envoy's health
  app.get("/api/envoys/:id/health", async (request, reply) => {
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
        lastSeen: entry.lastSeen,
        summary: entry.summary,
        readiness: entry.readiness,
        assignedEnvironments: entry.assignedEnvironments,
      },
    };
  });

  // Update an Envoy's configuration
  app.put("/api/envoys/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      url?: string;
      assignedEnvironments?: string[];
    };

    const updated = registry.update(id, body);
    if (!updated) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    return {
      envoy: {
        id: updated.id,
        name: updated.name,
        url: updated.url,
        assignedEnvironments: updated.assignedEnvironments,
      },
    };
  });

  // Deregister an Envoy
  app.delete("/api/envoys/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = registry.deregister(id);

    if (!removed) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    return reply.status(204).send();
  });

  // Rotate an Envoy's token
  app.post("/api/envoys/:id/rotate-token", async (request, reply) => {
    const { id } = request.params as { id: string };
    const newToken = registry.rotateToken(id);

    if (!newToken) {
      return reply.status(404).send({ error: "Envoy not found" });
    }

    return { token: newToken };
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
