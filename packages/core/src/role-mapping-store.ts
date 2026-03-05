import type { RoleMappingRule } from "./types.js";
import type { IRoleMappingStore } from "./store-interfaces.js";

/**
 * In-memory role mapping store. Returns deep clones to prevent external mutation.
 */
export class RoleMappingStore implements IRoleMappingStore {
  private rules = new Map<string, RoleMappingRule>();

  create(rule: RoleMappingRule): RoleMappingRule {
    if (this.rules.has(rule.id)) {
      throw new Error(`Role mapping rule already exists: ${rule.id}`);
    }
    this.rules.set(rule.id, structuredClone(rule));
    return structuredClone(rule);
  }

  getById(id: string): RoleMappingRule | undefined {
    const rule = this.rules.get(id);
    return rule ? structuredClone(rule) : undefined;
  }

  listByProvider(providerId: string): RoleMappingRule[] {
    return [...this.rules.values()]
      .filter((r) => r.providerId === providerId)
      .map((r) => structuredClone(r));
  }

  delete(id: string): void {
    this.rules.delete(id);
  }
}
