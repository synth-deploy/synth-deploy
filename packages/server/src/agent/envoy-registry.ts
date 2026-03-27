import crypto from "node:crypto";
import { EnvoyClient } from "./envoy-client.js";
import type { EnvoyHealthResponse } from "./envoy-client.js";
import type { PersistentEnvoyRegistryStore, PersistedEnvoyRegistration } from "@synth-deploy/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvoyRegistration {
  id: string;
  name: string;
  url: string;
  /** Shared secret for authenticating requests between Command and this Envoy */
  token: string;
  /** Environments this Envoy is assigned to (empty = available for any) */
  assignedEnvironments: string[];
  /** Partitions this Envoy is assigned to */
  assignedPartitions: string[];
  registeredAt: string;
  lastHealthCheck: string | null;
  lastHealthStatus: "healthy" | "degraded" | "unreachable" | null;
  /** Cached from last successful health probe */
  cachedHostname: string | null;
  cachedOs: string | null;
  cachedSummary: EnvoyHealthResponse["summary"] | null;
  cachedReadiness: EnvoyHealthResponse["readiness"] | null;
  /** User-provided context about this envoy's environment, injected into LLM planning prompts */
  envoyContext: string | null;
}

export interface EnvoyRegistryEntry extends EnvoyRegistration {
  health: "OK" | "Degraded" | "Unreachable";
  hostname: string | null;
  os: string | null;
  lastSeen: string | null;
  summary: EnvoyHealthResponse["summary"] | null;
  readiness: EnvoyHealthResponse["readiness"] | null;
}

// ---------------------------------------------------------------------------
// Helpers to convert between persisted and domain types
// ---------------------------------------------------------------------------

function fromPersisted(p: PersistedEnvoyRegistration): EnvoyRegistration {
  return {
    id: p.id,
    name: p.name,
    url: p.url,
    token: p.token,
    assignedEnvironments: p.assignedEnvironments,
    assignedPartitions: p.assignedPartitions,
    registeredAt: p.registeredAt,
    lastHealthCheck: p.lastHealthCheck,
    lastHealthStatus: p.lastHealthStatus,
    cachedHostname: p.cachedHostname,
    cachedOs: p.cachedOs,
    cachedSummary: p.cachedSummary as EnvoyHealthResponse["summary"] | null,
    cachedReadiness: p.cachedReadiness as EnvoyHealthResponse["readiness"] | null,
    envoyContext: p.envoyContext,
  };
}

function toPersisted(r: EnvoyRegistration): PersistedEnvoyRegistration {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    token: r.token,
    assignedEnvironments: r.assignedEnvironments,
    assignedPartitions: r.assignedPartitions,
    registeredAt: r.registeredAt,
    lastHealthCheck: r.lastHealthCheck,
    lastHealthStatus: r.lastHealthStatus,
    cachedHostname: r.cachedHostname,
    cachedOs: r.cachedOs,
    cachedSummary: r.cachedSummary,
    cachedReadiness: r.cachedReadiness,
    envoyContext: r.envoyContext,
  };
}

// ---------------------------------------------------------------------------
// EnvoyRegistry — SQLite-backed registry for multiple Envoy instances
// ---------------------------------------------------------------------------

export class EnvoyRegistry {
  constructor(private store?: PersistentEnvoyRegistryStore) {}

  /**
   * Register a new Envoy. Returns the registration with a generated token.
   */
  register(params: {
    name: string;
    url: string;
    assignedEnvironments?: string[];
    assignedPartitions?: string[];
  }): EnvoyRegistration {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("hex");

    const registration: EnvoyRegistration = {
      id,
      name: params.name,
      url: params.url,
      token,
      assignedEnvironments: params.assignedEnvironments ?? [],
      assignedPartitions: params.assignedPartitions ?? [],
      registeredAt: new Date().toISOString(),
      lastHealthCheck: null,
      lastHealthStatus: null,
      cachedHostname: null,
      cachedOs: null,
      cachedSummary: null,
      cachedReadiness: null,
      envoyContext: null,
    };

    this.store?.insert(toPersisted(registration));
    return registration;
  }

  /**
   * Deregister an Envoy by ID.
   */
  deregister(id: string): boolean {
    if (this.store) {
      return this.store.delete(id);
    }
    return false;
  }

  /**
   * List all registered Envoys.
   */
  list(): EnvoyRegistration[] {
    if (this.store) {
      return this.store.list().map(fromPersisted);
    }
    return [];
  }

  /**
   * Update an Envoy's assignment or name.
   */
  update(id: string, updates: {
    name?: string;
    url?: string;
    assignedEnvironments?: string[];
    assignedPartitions?: string[];
  }): EnvoyRegistration | undefined {
    if (!this.store) return undefined;
    const existing = this.store.getById(id);
    if (!existing) return undefined;

    this.store.update(id, {
      name: updates.name,
      url: updates.url,
      assignedEnvironments: updates.assignedEnvironments,
      assignedPartitions: updates.assignedPartitions,
    });

    return fromPersisted(this.store.getById(id)!);
  }

  /**
   * Ensure an envoy at `url` is registered with a specific `token`.
   * If already registered, updates its token. If not, creates a new entry.
   * Used to bootstrap the default envoy from environment variables (SYNTH_ENVOY_TOKEN).
   */
  ensureRegisteredWithToken(params: { name: string; url: string }, token: string): EnvoyRegistration {
    const existing = this.list().find((r) => r.url === params.url);
    if (existing) {
      this.store?.updateToken(existing.id, token);
      return { ...existing, token };
    }

    const id = crypto.randomUUID();
    const registration: EnvoyRegistration = {
      id,
      name: params.name,
      url: params.url,
      token,
      assignedEnvironments: [],
      assignedPartitions: [],
      registeredAt: new Date().toISOString(),
      lastHealthCheck: null,
      lastHealthStatus: null,
      cachedHostname: null,
      cachedOs: null,
      cachedSummary: null,
      cachedReadiness: null,
      envoyContext: null,
    };
    this.store?.insert(toPersisted(registration));
    return registration;
  }

  /**
   * Rotate the token for an Envoy. Returns the new token.
   */
  rotateToken(id: string): string | undefined {
    if (!this.store) return undefined;
    const existing = this.store.getById(id);
    if (!existing) return undefined;

    const newToken = crypto.randomBytes(32).toString("hex");
    this.store.updateToken(id, newToken);
    return newToken;
  }

  /**
   * Validate a token against a registered Envoy.
   */
  validateToken(token: string): EnvoyRegistration | undefined {
    if (!this.store) return undefined;
    const persisted = this.store.getByToken(token);
    return persisted ? fromPersisted(persisted) : undefined;
  }

  /**
   * Update health status for an Envoy (called after probing).
   */
  updateHealth(id: string, status: "healthy" | "degraded" | "unreachable"): void {
    this.store?.updateHealth(id, status, new Date().toISOString());
  }

  /**
   * Update the envoy context for an Envoy.
   */
  updateEnvoyContext(id: string, envoyContext: string | null): boolean {
    if (!this.store) return false;
    const existing = this.store.getById(id);
    if (!existing) return false;
    this.store.updateEnvoyContext(id, envoyContext);
    return true;
  }

  /**
   * Find the best Envoy for a given environment.
   * Priority: assigned + healthy > assigned + degraded > unassigned + healthy > fallback
   */
  findForEnvironment(environmentName: string): EnvoyRegistration | undefined {
    const all = this.list();
    if (all.length === 0) return undefined;

    // Assigned and healthy
    const assignedHealthy = all.find(
      (e) =>
        e.assignedEnvironments.includes(environmentName) &&
        e.lastHealthStatus === "healthy",
    );
    if (assignedHealthy) return assignedHealthy;

    // Assigned (any status)
    const assigned = all.find((e) =>
      e.assignedEnvironments.includes(environmentName),
    );
    if (assigned) return assigned;

    // Unassigned and healthy (available for any environment)
    const unassignedHealthy = all.find(
      (e) =>
        e.assignedEnvironments.length === 0 &&
        e.lastHealthStatus === "healthy",
    );
    if (unassignedHealthy) return unassignedHealthy;

    // Unassigned (any status)
    const unassigned = all.find((e) => e.assignedEnvironments.length === 0);
    if (unassigned) return unassigned;

    // Fallback: any envoy
    return all[0];
  }

  /**
   * Return cached registry entry without probing (instant).
   */
  get(id: string): EnvoyRegistryEntry | undefined {
    if (!this.store) return undefined;
    const persisted = this.store.getById(id);
    if (!persisted) return undefined;
    const reg = fromPersisted(persisted);
    const healthMap: Record<string, "OK" | "Degraded" | "Unreachable"> = {
      healthy: "OK",
      degraded: "Degraded",
      unreachable: "Unreachable",
    };
    return {
      ...reg,
      health: healthMap[reg.lastHealthStatus ?? "unreachable"] ?? "Unreachable",
      hostname: reg.cachedHostname,
      os: reg.cachedOs,
      lastSeen: reg.lastHealthCheck,
      summary: reg.cachedSummary,
      readiness: reg.cachedReadiness,
    };
  }

  /**
   * Return all cached registry entries without probing (instant).
   */
  listEntries(): EnvoyRegistryEntry[] {
    return this.list().map((reg) => {
      const healthMap: Record<string, "OK" | "Degraded" | "Unreachable"> = {
        healthy: "OK",
        degraded: "Degraded",
        unreachable: "Unreachable",
      };
      return {
        ...reg,
        health: healthMap[reg.lastHealthStatus ?? "unreachable"] ?? "Unreachable",
        hostname: reg.cachedHostname,
        os: reg.cachedOs,
        lastSeen: reg.lastHealthCheck,
        summary: reg.cachedSummary,
        readiness: reg.cachedReadiness,
      };
    });
  }

  /**
   * Probe an Envoy's health and update its registry entry.
   */
  async probe(id: string): Promise<EnvoyRegistryEntry | undefined> {
    if (!this.store) return undefined;
    const persisted = this.store.getById(id);
    if (!persisted) return undefined;
    const registration = fromPersisted(persisted);

    const client = new EnvoyClient(registration.url, 5000);
    try {
      const health = await client.checkHealth();
      const status = health.status === "healthy" ? "healthy" : "degraded";
      const timestamp = new Date().toISOString();

      this.store.updateCachedProbe(id, {
        lastHealthCheck: timestamp,
        lastHealthStatus: status,
        cachedHostname: health.hostname,
        cachedOs: health.os ?? null,
        cachedSummary: health.summary,
        cachedReadiness: health.readiness,
      });

      return {
        ...registration,
        lastHealthCheck: timestamp,
        lastHealthStatus: status,
        cachedHostname: health.hostname,
        cachedOs: health.os ?? null,
        cachedSummary: health.summary,
        cachedReadiness: health.readiness,
        health: status === "healthy" ? "OK" : "Degraded",
        hostname: health.hostname,
        os: health.os ?? null,
        lastSeen: health.timestamp,
        summary: health.summary,
        readiness: health.readiness,
      };
    } catch {
      const timestamp = new Date().toISOString();
      this.store.updateCachedProbe(id, {
        lastHealthCheck: timestamp,
        lastHealthStatus: "unreachable",
        cachedHostname: null,
        cachedOs: null,
        cachedSummary: null,
        cachedReadiness: null,
      });
      return {
        ...registration,
        lastHealthCheck: timestamp,
        lastHealthStatus: "unreachable",
        cachedHostname: null,
        cachedOs: null,
        cachedSummary: null,
        cachedReadiness: null,
        health: "Unreachable",
        hostname: null,
        os: null,
        lastSeen: null,
        summary: null,
        readiness: null,
      };
    }
  }

  /**
   * Probe all registered Envoys and return their status.
   */
  async probeAll(): Promise<EnvoyRegistryEntry[]> {
    const entries: EnvoyRegistryEntry[] = [];
    for (const envoy of this.list()) {
      const entry = await this.probe(envoy.id);
      if (entry) entries.push(entry);
    }
    return entries;
  }
}
