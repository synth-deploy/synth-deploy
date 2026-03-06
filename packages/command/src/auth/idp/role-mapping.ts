import type { IdpUser, RoleMappingRule } from "@synth-deploy/core";

/**
 * Applies role mapping rules to an IdP user's groups.
 * Returns the set of Synth role names that should be assigned.
 *
 * If no mapping rules match any of the user's groups, returns an empty array.
 */
export function applyRoleMappings(
  idpUser: IdpUser,
  rules: RoleMappingRule[],
): string[] {
  const matchedRoles = new Set<string>();

  for (const rule of rules) {
    if (idpUser.groups.includes(rule.idpGroup)) {
      matchedRoles.add(rule.synthRole);
    }
  }

  return [...matchedRoles];
}
