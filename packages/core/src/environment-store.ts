import crypto from "node:crypto";
import type { Environment, EnvironmentId } from "./types.js";

/**
 * In-memory environment store. Same pattern as PartitionStore and ProjectStore —
 * interface designed for later migration to persistent storage.
 */
export class EnvironmentStore {
  private environments: Map<EnvironmentId, Environment> = new Map();

  create(name: string, variables: Record<string, string> = {}): Environment {
    const env: Environment = { id: crypto.randomUUID(), name, variables };
    this.environments.set(env.id, env);
    return env;
  }

  get(id: EnvironmentId): Environment | undefined {
    return this.environments.get(id);
  }

  list(): Environment[] {
    return [...this.environments.values()];
  }

  update(
    id: EnvironmentId,
    updates: { name?: string; variables?: Record<string, string> },
  ): Environment {
    const env = this.environments.get(id);
    if (!env) {
      throw new Error(`Environment not found: ${id}`);
    }
    if (updates.name !== undefined) {
      env.name = updates.name;
    }
    if (updates.variables !== undefined) {
      env.variables = { ...env.variables, ...updates.variables };
    }
    return env;
  }

  delete(id: EnvironmentId): boolean {
    return this.environments.delete(id);
  }
}
