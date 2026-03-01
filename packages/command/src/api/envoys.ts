import type { FastifyInstance } from "fastify";
import type { ISettingsStore } from "@deploystack/core";
import { EnvoyClient } from "../agent/envoy-client.js";
import type { EnvoyHealthResponse } from "../agent/envoy-client.js";

export interface EnvoyRegistryEntry {
  id: string;
  url: string;
  health: "OK" | "Degraded" | "Unreachable";
  hostname: string | null;
  lastSeen: string | null;
  summary: EnvoyHealthResponse["summary"] | null;
  readiness: EnvoyHealthResponse["readiness"] | null;
}

async function probeEnvoy(
  id: string,
  url: string,
  client: EnvoyClient,
): Promise<EnvoyRegistryEntry> {
  try {
    const health = await client.checkHealth();
    return {
      id,
      url,
      health: health.status === "healthy" ? "OK" : "Degraded",
      hostname: health.hostname,
      lastSeen: health.timestamp,
      summary: health.summary,
      readiness: health.readiness,
    };
  } catch {
    return {
      id,
      url,
      health: "Unreachable",
      hostname: null,
      lastSeen: null,
      summary: null,
      readiness: null,
    };
  }
}

export function registerEnvoyRoutes(
  app: FastifyInstance,
  settings: ISettingsStore,
): void {
  app.get("/api/envoys", async () => {
    const envoyConfig = settings.get().envoy;
    if (!envoyConfig?.url) {
      return { envoys: [] };
    }
    const client = new EnvoyClient(envoyConfig.url, envoyConfig.timeoutMs);
    const entry = await probeEnvoy("default", envoyConfig.url, client);
    return { envoys: [entry] };
  });

  app.get("/api/envoys/:id/health", async (request, reply) => {
    const { id } = request.params as { id: string };
    const envoyConfig = settings.get().envoy;
    if (!envoyConfig?.url || id !== "default") {
      return reply.status(404).send({ error: "Envoy not found" });
    }
    const client = new EnvoyClient(envoyConfig.url, envoyConfig.timeoutMs);
    const entry = await probeEnvoy(id, envoyConfig.url, client);
    return { envoy: entry };
  });
}
