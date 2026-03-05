import type { User, UserId } from "./types.js";
import type { IUserStore } from "./store-interfaces.js";

/**
 * In-memory user store. Returns deep clones to prevent external mutation.
 */
export class UserStore implements IUserStore {
  private users = new Map<UserId, User>();

  create(user: User): User {
    if (this.users.has(user.id)) {
      throw new Error(`User already exists: ${user.id}`);
    }
    if (this.getByEmail(user.email)) {
      throw new Error(`Email already in use: ${user.email}`);
    }
    this.users.set(user.id, structuredClone(user));
    return structuredClone(user);
  }

  getById(id: UserId): User | undefined {
    const user = this.users.get(id);
    return user ? structuredClone(user) : undefined;
  }

  getByEmail(email: string): User | undefined {
    for (const user of this.users.values()) {
      if (user.email === email) return structuredClone(user);
    }
    return undefined;
  }

  getByExternalId(externalId: string, provider: string): User | undefined {
    for (const user of this.users.values()) {
      if (user.externalId === externalId && user.authSource === provider) {
        return structuredClone(user);
      }
    }
    return undefined;
  }

  list(): User[] {
    return [...this.users.values()].map((u) => structuredClone(u));
  }

  update(id: UserId, updates: Partial<Pick<User, "email" | "name" | "passwordHash" | "authSource" | "externalId" | "updatedAt">>): User {
    const user = this.users.get(id);
    if (!user) throw new Error(`User not found: ${id}`);
    if (updates.email !== undefined) {
      const existing = this.getByEmail(updates.email);
      if (existing && existing.id !== id) {
        throw new Error(`Email already in use: ${updates.email}`);
      }
      user.email = updates.email;
    }
    if (updates.name !== undefined) user.name = updates.name;
    if (updates.passwordHash !== undefined) user.passwordHash = updates.passwordHash;
    if (updates.authSource !== undefined) user.authSource = updates.authSource;
    if (updates.externalId !== undefined) user.externalId = updates.externalId;
    if (updates.updatedAt !== undefined) user.updatedAt = updates.updatedAt;
    return structuredClone(user);
  }

  delete(id: UserId): void {
    this.users.delete(id);
  }

  count(): number {
    return this.users.size;
  }
}
