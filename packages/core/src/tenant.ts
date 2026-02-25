import crypto from "node:crypto";
import type { Tenant, TenantId } from "./types.js";

/**
 * In-memory tenant store. Enforces isolation by partitioning all access by tenantId.
 * The interface is designed so the backing store can move to containers/databases
 * without changing consuming code.
 */
export class TenantStore {
  private tenants: Map<TenantId, Tenant> = new Map();

  create(name: string, variables: Record<string, string> = {}): Tenant {
    const tenant: Tenant = {
      id: crypto.randomUUID(),
      name,
      variables,
      createdAt: new Date(),
    };
    this.tenants.set(tenant.id, tenant);
    return tenant;
  }

  get(id: TenantId): Tenant | undefined {
    return this.tenants.get(id);
  }

  list(): Tenant[] {
    return [...this.tenants.values()];
  }

  setVariables(id: TenantId, variables: Record<string, string>): Tenant {
    const tenant = this.tenants.get(id);
    if (!tenant) {
      throw new Error(`Tenant not found: ${id}`);
    }
    tenant.variables = { ...tenant.variables, ...variables };
    return tenant;
  }

  update(id: TenantId, updates: { name?: string }): Tenant {
    const tenant = this.tenants.get(id);
    if (!tenant) {
      throw new Error(`Tenant not found: ${id}`);
    }
    if (updates.name !== undefined) {
      tenant.name = updates.name;
    }
    return tenant;
  }

  delete(id: TenantId): boolean {
    return this.tenants.delete(id);
  }
}
