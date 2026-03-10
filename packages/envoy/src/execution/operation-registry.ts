import type { PlannedStep } from "@synth-deploy/core";
import type { Platform } from "./platform.js";

// ---------------------------------------------------------------------------
// Types — handler interface and results
// ---------------------------------------------------------------------------

/**
 * Result of a handler executing an operation.
 */
export interface HandlerResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Result of a handler's dry-run precondition check against real system state.
 * Used to validate plan steps before presenting them to the user.
 */
export interface DryRunResult {
  canExecute: boolean;
  preconditions: Array<{ check: string; passed: boolean; detail: string }>;
  /** State changes this step would produce — fed into subsequent steps' context */
  predictedOutcome?: Record<string, unknown>;
  /** How confident the dry-run is in its prediction */
  fidelity: "deterministic" | "speculative" | "unknown";
  /** Whether the planner can work around this failure */
  recoverable: boolean;
  /** What couldn't be verified */
  unknowns?: string[];
}

/**
 * An operation handler knows how to execute a specific category of
 * deployment actions (service management, file operations, etc.).
 *
 * Each handler:
 * - Declares what actions it can handle via canHandle()
 * - Executes the action against a target
 * - Optionally verifies the action took effect
 */
export interface OperationHandler {
  /** Human-readable name for debrief entries */
  name: string;

  /**
   * The action vocabulary this handler recognizes. These are the keywords
   * that canHandle() matches against — exposed here so the planner can
   * know what actions are available without calling canHandle() on every
   * possible string.
   */
  actionKeywords: readonly string[];

  /**
   * External tool dependencies this handler requires (e.g. "docker",
   * "systemctl"). Empty if the handler uses only Node built-ins.
   */
  toolDependencies: readonly string[];

  /**
   * Return true if this handler can execute the given action on the
   * current platform. The executor calls canHandle on each registered
   * handler until one matches.
   */
  canHandle(action: string, platform: Platform): boolean;

  /**
   * Execute the action against the target with the given parameters.
   * Must not throw — all errors are captured in the HandlerResult.
   */
  execute(
    action: string,
    target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult>;

  /**
   * Optional post-execution verification. If present, the executor
   * calls this after a successful execute() to confirm the action
   * actually took effect.
   */
  verify?(action: string, target: string): Promise<boolean>;

  /**
   * Dry-run precondition check: validates that a planned step can
   * execute against the current system state without actually making
   * changes. Used to ground plan confidence before presenting to users.
   *
   * The predictedOutcomes map contains predicted state changes from
   * preceding steps (e.g., directories that would be created), allowing
   * the handler to account for not-yet-executed earlier steps.
   */
  dryRun(
    step: PlannedStep,
    predictedOutcomes: Map<number, Record<string, unknown>>,
  ): Promise<DryRunResult>;
}

// ---------------------------------------------------------------------------
// DefaultOperationRegistry — resolves actions to handlers
// ---------------------------------------------------------------------------

/**
 * Registry of operation handlers. The executor consults this to find
 * the right handler for each step in a deployment plan.
 *
 * Handlers are matched in registration order — first match wins.
 * This means more specific handlers should be registered before
 * more general ones.
 */
export class DefaultOperationRegistry {
  private handlers: OperationHandler[] = [];

  /**
   * Register a handler. Order matters — first registered handler
   * that can handle an action wins.
   */
  register(handler: OperationHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Find the handler that can execute the given action on the
   * given platform. Returns undefined if no handler matches.
   */
  resolve(action: string, platform: Platform): OperationHandler | undefined {
    return this.handlers.find((h) => h.canHandle(action, platform));
  }

  /**
   * List all registered handlers with their full vocabulary and tool
   * dependencies. Used by the planner to understand what actions the
   * Envoy can execute and what external tools are required.
   */
  listCapabilities(): Array<{
    name: string;
    actionKeywords: readonly string[];
    toolDependencies: readonly string[];
  }> {
    return this.handlers.map((h) => ({
      name: h.name,
      actionKeywords: h.actionKeywords,
      toolDependencies: h.toolDependencies,
    }));
  }

  /**
   * Return the complete action vocabulary across all registered handlers.
   * This is the full set of keywords the Envoy recognizes in action strings.
   */
  allActionKeywords(): string[] {
    const keywords = new Set<string>();
    for (const h of this.handlers) {
      for (const kw of h.actionKeywords) {
        keywords.add(kw);
      }
    }
    return [...keywords];
  }

  /**
   * Return all external tool dependencies across all registered handlers.
   */
  allToolDependencies(): string[] {
    const deps = new Set<string>();
    for (const h of this.handlers) {
      for (const dep of h.toolDependencies) {
        deps.add(dep);
      }
    }
    return [...deps];
  }
}
