import type { FleetDeployment } from "@deploystack/core";

/**
 * In-memory store for FleetDeployment objects.
 * Mirrors the pattern used by other in-memory stores in the codebase.
 */
export class FleetDeploymentStore {
  private deployments = new Map<string, FleetDeployment>();

  /**
   * Create and store a new fleet deployment.
   */
  create(deployment: FleetDeployment): FleetDeployment {
    this.deployments.set(deployment.id, deployment);
    return deployment;
  }

  /**
   * Get a fleet deployment by ID.
   */
  getById(id: string): FleetDeployment | undefined {
    return this.deployments.get(id);
  }

  /**
   * Update an existing fleet deployment.
   */
  update(deployment: FleetDeployment): FleetDeployment {
    deployment.updatedAt = new Date();
    this.deployments.set(deployment.id, deployment);
    return deployment;
  }

  /**
   * List all fleet deployments, most recent first.
   */
  list(): FleetDeployment[] {
    return Array.from(this.deployments.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /**
   * Delete a fleet deployment by ID.
   */
  delete(id: string): boolean {
    return this.deployments.delete(id);
  }
}
