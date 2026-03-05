import type { UserId, RoleId, Permission, UserRole, Role } from "./types.js";
import type { IUserRoleStore, IRoleStore } from "./store-interfaces.js";

/**
 * In-memory user-role assignment store.
 * Requires a reference to the role store to resolve roles and permissions.
 */
export class UserRoleStore implements IUserRoleStore {
  private assignments = new Map<string, UserRole>(); // key = `${userId}:${roleId}`
  private roleStore: IRoleStore;

  constructor(roleStore: IRoleStore) {
    this.roleStore = roleStore;
  }

  private key(userId: UserId, roleId: RoleId): string {
    return `${userId}:${roleId}`;
  }

  assign(userId: UserId, roleId: RoleId, assignedBy: UserId): UserRole {
    const role = this.roleStore.getById(roleId);
    if (!role) throw new Error(`Role not found: ${roleId}`);
    const assignment: UserRole = {
      userId,
      roleId,
      assignedAt: new Date(),
      assignedBy,
    };
    this.assignments.set(this.key(userId, roleId), assignment);
    return structuredClone(assignment);
  }

  getUserRoles(userId: UserId): Role[] {
    const roles: Role[] = [];
    for (const [, assignment] of this.assignments) {
      if (assignment.userId === userId) {
        const role = this.roleStore.getById(assignment.roleId);
        if (role) roles.push(role);
      }
    }
    return roles;
  }

  getUserPermissions(userId: UserId): Permission[] {
    const roles = this.getUserRoles(userId);
    const permissionSet = new Set<Permission>();
    for (const role of roles) {
      for (const perm of role.permissions) {
        permissionSet.add(perm);
      }
    }
    return [...permissionSet];
  }

  removeRole(userId: UserId, roleId: RoleId): void {
    this.assignments.delete(this.key(userId, roleId));
  }

  setRoles(userId: UserId, roleIds: RoleId[], assignedBy: UserId): void {
    // Remove all existing assignments for this user
    for (const [key, assignment] of this.assignments) {
      if (assignment.userId === userId) {
        this.assignments.delete(key);
      }
    }
    // Assign new roles
    for (const roleId of roleIds) {
      this.assign(userId, roleId, assignedBy);
    }
  }
}
