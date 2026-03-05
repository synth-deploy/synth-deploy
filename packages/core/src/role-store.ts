import type { Role, RoleId, Permission } from "./types.js";
import type { IRoleStore } from "./store-interfaces.js";

/**
 * In-memory role store. Returns deep clones to prevent external mutation.
 */
export class RoleStore implements IRoleStore {
  private roles = new Map<RoleId, Role>();

  create(role: Role): Role {
    if (this.roles.has(role.id)) {
      throw new Error(`Role already exists: ${role.id}`);
    }
    if (this.getByName(role.name)) {
      throw new Error(`Role name already in use: ${role.name}`);
    }
    this.roles.set(role.id, structuredClone(role));
    return structuredClone(role);
  }

  getById(id: RoleId): Role | undefined {
    const role = this.roles.get(id);
    return role ? structuredClone(role) : undefined;
  }

  getByName(name: string): Role | undefined {
    for (const role of this.roles.values()) {
      if (role.name === name) return structuredClone(role);
    }
    return undefined;
  }

  list(): Role[] {
    return [...this.roles.values()].map((r) => structuredClone(r));
  }

  update(id: RoleId, updates: Partial<Pick<Role, "name" | "permissions">>): Role {
    const role = this.roles.get(id);
    if (!role) throw new Error(`Role not found: ${id}`);
    if (updates.name !== undefined) {
      const existing = this.getByName(updates.name);
      if (existing && existing.id !== id) {
        throw new Error(`Role name already in use: ${updates.name}`);
      }
      role.name = updates.name;
    }
    if (updates.permissions !== undefined) role.permissions = updates.permissions;
    return structuredClone(role);
  }

  delete(id: RoleId): void {
    this.roles.delete(id);
  }
}
