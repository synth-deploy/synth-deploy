import type { SecurityBoundary, EnvoyId } from "./types.js";

/**
 * In-memory security boundary store. Keyed by envoyId — each envoy can have
 * multiple boundaries of different types.
 * Interface designed for later migration to persistent storage.
 */
export class SecurityBoundaryStore {
  private boundaries: Map<EnvoyId, SecurityBoundary[]> = new Map();

  set(envoyId: EnvoyId, boundaries: SecurityBoundary[]): void {
    this.boundaries.set(envoyId, structuredClone(boundaries));
  }

  get(envoyId: EnvoyId): SecurityBoundary[] {
    const boundaries = this.boundaries.get(envoyId);
    return boundaries ? structuredClone(boundaries) : [];
  }

  delete(envoyId: EnvoyId): void {
    this.boundaries.delete(envoyId);
  }
}
