import path from "node:path";
import type {
  PlannedStep,
  SecurityBoundary,
  SecurityBoundaryType,
} from "@synth-deploy/core";
import type { DefaultOperationRegistry } from "./operation-registry.js";

// ---------------------------------------------------------------------------
// Types — validation results
// ---------------------------------------------------------------------------

/**
 * Result of validating a single step against security boundaries.
 */
export interface ValidationResult {
  allowed: boolean;
  step: PlannedStep;
  violatedBoundary?: SecurityBoundary;
  reason?: string;
}

/**
 * Result of validating an entire plan against security boundaries.
 */
export interface PlanValidationResult {
  allowed: boolean;
  results: ValidationResult[];
  violations: ValidationResult[];
}

// ---------------------------------------------------------------------------
// Handler-name to boundary-type mapping
// ---------------------------------------------------------------------------

/**
 * Maps handler names to security boundary types. This is the single source
 * of truth for which handler category maps to which boundary. When the
 * registry is available, classifyAction() uses handler vocabulary directly.
 */
const HANDLER_BOUNDARY_MAP: Record<string, SecurityBoundaryType> = {
  service: "service",
  file: "filesystem",
  config: "filesystem",
  container: "execution",
  process: "execution",
  verify: "network",
};

// ---------------------------------------------------------------------------
// BoundaryValidator — enforces security boundaries on planned steps
// ---------------------------------------------------------------------------

/**
 * Validates planned deployment steps against security boundaries.
 *
 * Security boundaries define what an envoy is allowed to do:
 * - filesystem: which paths can be read/written
 * - service: which services can be managed
 * - network: which hosts/ports can be accessed
 * - credential: which secrets can be used
 * - execution: which commands can be run
 *
 * Every step is validated BEFORE execution begins. If any step
 * violates a boundary, the entire plan is rejected — no partial
 * execution.
 *
 * When constructed with a registry reference, classifyAction() derives
 * its vocabulary from registered handlers instead of a hardcoded list.
 */
export class BoundaryValidator {
  private registry: DefaultOperationRegistry | null;

  constructor(registry?: DefaultOperationRegistry) {
    this.registry = registry ?? null;
  }
  /**
   * Validate a single step against the provided boundaries.
   */
  validateStep(
    step: PlannedStep,
    boundaries: SecurityBoundary[],
  ): ValidationResult {
    // If no boundaries are configured, allow everything.
    // This matches the "correctness first" constraint —
    // boundaries are opt-in, not required.
    if (boundaries.length === 0) {
      return { allowed: true, step };
    }

    // Determine which boundary type this action falls under
    const boundaryType = this.classifyAction(step.action);
    if (!boundaryType) {
      // Unclassifiable actions are denied by default —
      // the system must understand every action it executes
      return {
        allowed: false,
        step,
        reason:
          `Action "${step.action}" could not be classified into a security ` +
          `boundary type. The executor cannot validate this action against ` +
          `configured boundaries. Either register a handler for this action ` +
          `type or add an explicit boundary configuration.`,
      };
    }

    // Find matching boundaries for this type
    const relevantBoundaries = boundaries.filter(
      (b) => b.boundaryType === boundaryType,
    );

    // If no boundaries exist for this type, allow by default.
    // Only configured boundary types are enforced.
    if (relevantBoundaries.length === 0) {
      return { allowed: true, step };
    }

    // Check each relevant boundary
    for (const boundary of relevantBoundaries) {
      const violation = this.checkBoundary(step, boundary);
      if (violation) {
        return {
          allowed: false,
          step,
          violatedBoundary: boundary,
          reason: violation,
        };
      }
    }

    return { allowed: true, step };
  }

  /**
   * Validate all steps in a plan. Returns detailed results for each step.
   * If any step is denied, the entire plan is considered invalid.
   */
  validatePlan(
    steps: PlannedStep[],
    boundaries: SecurityBoundary[],
  ): PlanValidationResult {
    const results = steps.map((step) => this.validateStep(step, boundaries));
    const violations = results.filter((r) => !r.allowed);

    return {
      allowed: violations.length === 0,
      results,
      violations,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: action classification and boundary checking
  // -------------------------------------------------------------------------

  /**
   * Classify an action string into a security boundary type.
   *
   * When a registry is available, this derives the classification from
   * registered handler vocabularies — no duplicated keyword lists.
   * Falls back to a static mapping when no registry is configured.
   *
   * Returns undefined if the action doesn't match any known type.
   */
  private classifyAction(action: string | undefined): SecurityBoundaryType | undefined {
    if (!action) return undefined;
    const lower = action.toLowerCase();

    // When registry is available, match against handler vocabularies
    if (this.registry) {
      const capabilities = this.registry.listCapabilities();
      for (const cap of capabilities) {
        const matches = cap.actionKeywords.some((kw) => lower.includes(kw));
        if (matches) {
          const boundaryType = HANDLER_BOUNDARY_MAP[cap.name];
          if (boundaryType) return boundaryType;
        }
      }
      return undefined;
    }

    // Fallback: static classification (used when no registry is provided,
    // e.g. in standalone validation scenarios)

    // Service actions
    if (
      lower.includes("start") ||
      lower.includes("stop") ||
      lower.includes("restart") ||
      lower.includes("service") ||
      lower.includes("reload")
    ) {
      return "service";
    }

    // Filesystem actions
    if (
      lower.includes("copy") ||
      lower.includes("move") ||
      lower.includes("backup") ||
      lower.includes("permission") ||
      lower.includes("symlink") ||
      lower.includes("file") ||
      lower.includes("write") ||
      lower.includes("read") ||
      lower.includes("mkdir") ||
      lower.includes("delete") ||
      lower.includes("config") ||
      lower.includes("template") ||
      lower.includes("substitute") ||
      lower.includes("transform")
    ) {
      return "filesystem";
    }

    // Network actions
    if (
      lower.includes("health") ||
      lower.includes("check") ||
      lower.includes("verify") ||
      lower.includes("validate") ||
      lower.includes("port") ||
      lower.includes("http") ||
      lower.includes("connect") ||
      lower.includes("test")
    ) {
      return "network";
    }

    // Execution actions
    if (
      lower.includes("run") ||
      lower.includes("execute") ||
      lower.includes("command") ||
      lower.includes("script") ||
      lower.includes("docker") ||
      lower.includes("container") ||
      lower.includes("compose") ||
      lower.includes("pull") ||
      lower.includes("image")
    ) {
      return "execution";
    }

    return undefined;
  }

  /**
   * Check a step against a specific boundary.
   * Returns a violation reason string, or undefined if allowed.
   */
  private checkBoundary(
    step: PlannedStep,
    boundary: SecurityBoundary,
  ): string | undefined {
    const config = boundary.config;

    switch (boundary.boundaryType) {
      case "filesystem": {
        // Filesystem boundaries define allowed paths.
        // We resolve both the target and allowed paths to prevent
        // path traversal attacks (e.g., /allowed/../etc/shadow).
        const allowedPaths = config.allowedPaths as string[] | undefined;
        if (allowedPaths && allowedPaths.length > 0) {
          const resolvedTarget = path.resolve(step.target);
          const inAllowedPath = allowedPaths.some((p) => {
            const resolvedAllowed = path.resolve(p);
            // Use trailing separator to prevent prefix attacks:
            // e.g., /app-secret should not match allowed path /app
            const prefix = resolvedAllowed.endsWith(path.sep)
              ? resolvedAllowed
              : resolvedAllowed + path.sep;
            return resolvedTarget === resolvedAllowed || resolvedTarget.startsWith(prefix);
          });
          if (!inAllowedPath) {
            return (
              `Step targets "${step.target}" (resolved: ${path.resolve(step.target)}) which is outside the allowed ` +
              `filesystem paths: ${allowedPaths.join(", ")}. This boundary ` +
              `restricts file operations to specific directories to prevent ` +
              `unintended modifications to the host system.`
            );
          }
        }
        return undefined;
      }

      case "service": {
        // Service boundaries define allowed service names
        const allowedServices = config.allowedServices as string[] | undefined;
        if (allowedServices && allowedServices.length > 0) {
          const target = step.target;
          if (!allowedServices.includes(target)) {
            return (
              `Step targets service "${target}" which is not in the allowed ` +
              `service list: ${allowedServices.join(", ")}. This boundary ` +
              `restricts which system services the envoy can manage.`
            );
          }
        }
        return undefined;
      }

      case "network": {
        // Network boundaries define allowed hosts/ports
        const allowedHosts = config.allowedHosts as string[] | undefined;
        if (allowedHosts && allowedHosts.length > 0) {
          const target = step.target;
          const inAllowedHost = allowedHosts.some(
            (h) => target.includes(h),
          );
          if (!inAllowedHost) {
            return (
              `Step targets "${target}" which is not in the allowed ` +
              `network hosts: ${allowedHosts.join(", ")}. This boundary ` +
              `restricts which network endpoints the envoy can access.`
            );
          }
        }
        return undefined;
      }

      case "execution": {
        // Execution boundaries define allowed commands
        const allowedCommands = config.allowedCommands as string[] | undefined;
        if (allowedCommands && allowedCommands.length > 0) {
          const action = step.action.toLowerCase();
          const target = step.target.toLowerCase();
          const inAllowedCommand = allowedCommands.some(
            (c) => action.includes(c.toLowerCase()) || target.includes(c.toLowerCase()),
          );
          if (!inAllowedCommand) {
            return (
              `Step action "${step.action}" targeting "${step.target}" does ` +
              `not match any allowed execution commands: ${allowedCommands.join(", ")}. ` +
              `This boundary restricts which commands the envoy can execute.`
            );
          }
        }
        return undefined;
      }

      case "credential": {
        // Credential boundaries define which secrets can be accessed
        const allowedCredentials = config.allowedCredentials as string[] | undefined;
        if (allowedCredentials && allowedCredentials.length > 0) {
          const target = step.target;
          if (!allowedCredentials.includes(target)) {
            return (
              `Step accesses credential "${target}" which is not in the ` +
              `allowed credentials: ${allowedCredentials.join(", ")}. This ` +
              `boundary restricts which secrets the envoy can use.`
            );
          }
        }
        return undefined;
      }
    }

    return undefined;
  }
}
