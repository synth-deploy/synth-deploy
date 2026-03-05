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
   * List all registered handlers and the platforms they support.
   * Useful for diagnostics and debrief entries.
   */
  listCapabilities(): Array<{ name: string }> {
    return this.handlers.map((h) => ({ name: h.name }));
  }
}
