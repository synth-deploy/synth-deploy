import crypto from "node:crypto";
import { EnvoyClient } from "./envoy-client.js";
import type { EnvoyHealthResponse } from "./envoy-client.js";

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
  registeredAt: string;
  lastHealthCheck: string | null;
  lastHealthStatus: "healthy" | "degraded" | "unreachable" | null;
}

export interface EnvoyRegistryEntry extends EnvoyRegistration {
  health: "OK" | "Degraded" | "Unreachable";
  hostname: string | null;
  lastSeen: string | null;
  summary: EnvoyHealthResponse["summary"] | null;
  readiness: EnvoyHealthResponse["readiness"] | null;
}

// ---------------------------------------------------------------------------
// EnvoyRegistry — in-memory registry for multiple Envoy instances
// ---------------------------------------------------------------------------

export class EnvoyRegistry {
  private envoys = new Map<string, EnvoyRegistration>();

  /**
   * Register a new Envoy. Returns the registration with a generated token.
   */
  register(params: {
    name: string;
    url: string;
    assignedEnvironments?: string[];
  }): EnvoyRegistration {
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("hex");

    const registration: EnvoyRegistration = {
      id,
      name: params.name,
      url: params.url,
      token,
      assignedEnvironments: params.assignedEnvironments ?? [],
      registeredAt: new Date().toISOString(),
      lastHealthCheck: null,
      lastHealthStatus: null,
    };

    this.envoys.set(id, registration);
    return registration;
  }

  /**
   * Deregister an Envoy by ID.
   */
  deregister(id: string): boolean {
    return this.envoys.delete(id);
  }

  /**
   * List all registered Envoys.
   */
  list(): EnvoyRegistration[] {
    return Array.from(this.envoys.values());
  }

  /**
   * Update an Envoy's assignment or name.
   */
  update(id: string, updates: {
    name?: string;
    url?: string;
    assignedEnvironments?: string[];
  }): EnvoyRegistration | undefined {
    const existing = this.envoys.get(id);
    if (!existing) return undefined;

    if (updates.name !== undefined) existing.name = updates.name;
    if (updates.url !== undefined) existing.url = updates.url;
    if (updates.assignedEnvironments !== undefined) {
      existing.assignedEnvironments = updates.assignedEnvironments;
    }

    return existing;
  }

  /**
   * Rotate the token for an Envoy. Returns the new token.
   */
  rotateToken(id: string): string | undefined {
    const existing = this.envoys.get(id);
    if (!existing) return undefined;

    existing.token = crypto.randomBytes(32).toString("hex");
    return existing.token;
  }

  /**
   * Validate a token against a registered Envoy.
   */
  validateToken(token: string): EnvoyRegistration | undefined {
    for (const envoy of this.envoys.values()) {
      if (envoy.token === token) return envoy;
    }
    return undefined;
  }

  /**
   * Update health status for an Envoy (called after probing).
   */
  updateHealth(id: string, status: "healthy" | "degraded" | "unreachable"): void {
    const existing = this.envoys.get(id);
    if (existing) {
      existing.lastHealthCheck = new Date().toISOString();
      existing.lastHealthStatus = status;
    }
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
    const reg = this.envoys.get(id);
    if (!reg) return undefined;
    const healthMap: Record<string, "OK" | "Degraded" | "Unreachable"> = {
      healthy: "OK",
      degraded: "Degraded",
      unreachable: "Unreachable",
    };
    return {
      ...reg,
      health: healthMap[reg.lastHealthStatus ?? "unreachable"] ?? "Unreachable",
      hostname: null,
      lastSeen: reg.lastHealthCheck,
      summary: null,
      readiness: null,
    };
  }

  /**
   * Return all cached registry entries without probing (instant).
   */
  listEntries(): EnvoyRegistryEntry[] {
    return Array.from(this.envoys.values()).map((reg) => this.get(reg.id)!);
  }

  /**
   * Probe an Envoy's health and update its registry entry.
   */
  async probe(id: string): Promise<EnvoyRegistryEntry | undefined> {
    const registration = this.envoys.get(id);
    if (!registration) return undefined;

    const client = new EnvoyClient(registration.url, 5000);
    try {
      const health = await client.checkHealth();
      const status = health.status === "healthy" ? "healthy" : "degraded";
      this.updateHealth(id, status);

      return {
        ...registration,
        health: status === "healthy" ? "OK" : "Degraded",
        hostname: health.hostname,
        lastSeen: health.timestamp,
        summary: health.summary,
        readiness: health.readiness,
      };
    } catch {
      this.updateHealth(id, "unreachable");
      return {
        ...registration,
        health: "Unreachable",
        hostname: null,
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
    for (const envoy of this.envoys.values()) {
      const entry = await this.probe(envoy.id);
      if (entry) entries.push(entry);
    }
    return entries;
  }
}
