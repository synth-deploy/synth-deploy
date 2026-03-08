import type { ApiKey, ApiKeyId, UserId } from "./types.js";
import type { IApiKeyStore } from "./store-interfaces.js";

/**
 * In-memory API key store. Returns deep clones to prevent external mutation.
 */
export class ApiKeyStore implements IApiKeyStore {
  private keys = new Map<ApiKeyId, ApiKey>();

  create(key: ApiKey): ApiKey {
    this.keys.set(key.id, structuredClone(key));
    return structuredClone(key);
  }

  getById(id: ApiKeyId): ApiKey | undefined {
    const key = this.keys.get(id);
    return key ? structuredClone(key) : undefined;
  }

  listByUserId(userId: UserId): ApiKey[] {
    const result: ApiKey[] = [];
    for (const key of this.keys.values()) {
      if (key.userId === userId) {
        result.push(structuredClone(key));
      }
    }
    return result;
  }

  updateLastUsed(id: ApiKeyId, at: Date): void {
    const key = this.keys.get(id);
    if (key) {
      key.lastUsedAt = at;
    }
  }

  revoke(id: ApiKeyId): void {
    const key = this.keys.get(id);
    if (key) {
      key.revokedAt = new Date();
    }
  }

  updateHash(id: ApiKeyId, keyHash: string, keyPrefix: string, keySuffix: string): void {
    const key = this.keys.get(id);
    if (key) {
      key.keyHash = keyHash;
      key.keyPrefix = keyPrefix;
      key.keySuffix = keySuffix;
    }
  }

  delete(id: ApiKeyId): void {
    this.keys.delete(id);
  }
}
