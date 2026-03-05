import type { IdpProvider } from "./types.js";
import type { IIdpProviderStore } from "./store-interfaces.js";

/**
 * In-memory IdP provider store. Returns deep clones to prevent external mutation.
 */
export class IdpProviderStore implements IIdpProviderStore {
  private providers = new Map<string, IdpProvider>();

  create(provider: IdpProvider): IdpProvider {
    if (this.providers.has(provider.id)) {
      throw new Error(`IdP provider already exists: ${provider.id}`);
    }
    this.providers.set(provider.id, structuredClone(provider));
    return structuredClone(provider);
  }

  getById(id: string): IdpProvider | undefined {
    const provider = this.providers.get(id);
    return provider ? structuredClone(provider) : undefined;
  }

  list(): IdpProvider[] {
    return [...this.providers.values()].map((p) => structuredClone(p));
  }

  update(id: string, updates: Partial<Pick<IdpProvider, "name" | "enabled" | "config" | "updatedAt">>): IdpProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`IdP provider not found: ${id}`);
    if (updates.name !== undefined) provider.name = updates.name;
    if (updates.enabled !== undefined) provider.enabled = updates.enabled;
    if (updates.config !== undefined) provider.config = updates.config;
    if (updates.updatedAt !== undefined) provider.updatedAt = updates.updatedAt;
    return structuredClone(provider);
  }

  delete(id: string): void {
    this.providers.delete(id);
  }

  /** In-memory store has no at-rest encryption — always returns false. */
  hasEncryptionKey(): boolean {
    return false;
  }
}
