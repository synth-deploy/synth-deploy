import crypto from "node:crypto";
import type {
  TenantId,
  Tenant,
  Deployment,
  DeploymentId,
  DebriefEntry,
} from "./types.js";
import type { DebriefReader } from "./debrief.js";
import {
  TenantContainer,
  type ScopedDeploymentReader,
  type ScopedDebriefReader,
} from "./tenant-container.js";

// ---------------------------------------------------------------------------
// Backing store interfaces -- what TenantManager wraps
// ---------------------------------------------------------------------------

/**
 * The deployment store interface that TenantManager needs to create
 * scoped views. Matches the existing DeploymentStore shape.
 */
export interface DeploymentStoreReader {
  get(id: DeploymentId): Deployment | undefined;
  list(): Deployment[];
}

// ---------------------------------------------------------------------------
// Scoped store implementations -- the isolation enforcement layer
// ---------------------------------------------------------------------------

/**
 * Wraps a full deployment store and enforces tenant-scoped access.
 * A get() for a deployment belonging to another tenant returns undefined.
 * A list() only returns deployments for the bound tenant.
 */
class TenantScopedDeployments implements ScopedDeploymentReader {
  constructor(
    private tenantId: TenantId,
    private backing: DeploymentStoreReader,
  ) {}

  get(id: DeploymentId): Deployment | undefined {
    const d = this.backing.get(id);
    if (d && d.tenantId !== this.tenantId) return undefined;
    return d;
  }

  list(): Deployment[] {
    return this.backing.list().filter((d) => d.tenantId === this.tenantId);
  }
}

/**
 * Wraps a full debrief reader and enforces tenant-scoped access.
 */
class TenantScopedDebrief implements ScopedDebriefReader {
  constructor(
    private tenantId: TenantId,
    private backing: DebriefReader,
  ) {}

  list(): DebriefEntry[] {
    return this.backing.getByTenant(this.tenantId);
  }
}

// ---------------------------------------------------------------------------
// TenantManager -- the single entry point for tenant lifecycle
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of TenantContainers and wires up scoped store views.
 *
 * Cross-tenant data access is impossible through the container interface:
 * each container only sees deployments and debrief entries belonging to its
 * tenant. Variables are owned copies within each container -- modifying
 * one tenant's variables has zero effect on any other tenant.
 *
 * Usage:
 *   const manager = new TenantManager(deploymentStore, debrief);
 *   const tenantA = manager.createTenant("Acme Corp", { DB_HOST: "acme-db" });
 *   const tenantB = manager.createTenant("Beta Inc", { DB_HOST: "beta-db" });
 *
 *   // tenantA.getDeployments() -- only Acme's deployments
 *   // tenantB.getDebriefEntries() -- only Beta's debrief entries
 *   // tenantA.setVariables({...}) -- no effect on tenantB
 */
export class TenantManager {
  private containers: Map<TenantId, TenantContainer> = new Map();

  constructor(
    private deploymentStore: DeploymentStoreReader,
    private debriefReader: DebriefReader,
  ) {}

  createTenant(
    name: string,
    variables: Record<string, string> = {},
  ): TenantContainer {
    const tenant: Tenant = {
      id: crypto.randomUUID(),
      name,
      variables,
      createdAt: new Date(),
    };

    const container = new TenantContainer(
      tenant,
      new TenantScopedDeployments(tenant.id, this.deploymentStore),
      new TenantScopedDebrief(tenant.id, this.debriefReader),
    );
    this.containers.set(tenant.id, container);
    return container;
  }

  getTenant(id: TenantId): TenantContainer | undefined {
    return this.containers.get(id);
  }

  listTenants(): Array<{ id: TenantId; name: string }> {
    return [...this.containers.values()].map((c) => ({
      id: c.id,
      name: c.name,
    }));
  }

  get size(): number {
    return this.containers.size;
  }
}
