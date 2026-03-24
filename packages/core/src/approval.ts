import type { OperationType, ApprovalMode, AppSettings, EnvironmentId } from "./types.js";
import { DEFAULT_APPROVAL_DEFAULTS } from "./types.js";

/**
 * Resolves the effective approval mode for a given operation type and optional environment.
 *
 * Resolution order:
 * 1. Check environment override (if environmentId is provided and resolves to a known name)
 * 2. Fall back to the per-operation-type default
 * 3. Fall back to hardcoded defaults if settings are missing
 *
 * @param operationType - The operation type (deploy, query, investigate, etc.)
 * @param environmentId - Optional environment ID for the operation
 * @param settings - Current app settings
 * @param environmentLookup - Function to resolve environmentId to environment name
 * @returns 'auto' or 'required'
 */
export function resolveApprovalMode(
  operationType: OperationType,
  environmentId: EnvironmentId | undefined,
  settings: AppSettings,
  environmentLookup?: (id: EnvironmentId) => string | undefined,
): ApprovalMode {
  const defaults = settings.approvalDefaults ?? DEFAULT_APPROVAL_DEFAULTS;

  // Check for environment-specific override
  if (environmentId && defaults.environmentOverrides && environmentLookup) {
    const envName = environmentLookup(environmentId);
    if (envName) {
      const envOverrides = defaults.environmentOverrides[envName];
      if (envOverrides && operationType in envOverrides) {
        return envOverrides[operationType]!;
      }
    }
  }

  // Fall back to the per-type default
  const typeDefault = defaults[operationType as keyof Omit<typeof defaults, "environmentOverrides">];
  if (typeDefault === "auto" || typeDefault === "required") {
    return typeDefault;
  }

  // Fallback for unknown operation types — require approval
  return "required";
}
