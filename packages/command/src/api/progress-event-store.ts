/**
 * In-memory store for deployment progress events.
 *
 * Each deployment gets a ring buffer of events (capped at MAX_EVENTS).
 * SSE clients subscribe via addListener / removeListener, and the store
 * pushes new events as they arrive from the envoy's progress callback.
 *
 * Cleanup happens automatically after a deployment completes —
 * the buffer is retained for CLEANUP_DELAY_MS to let late-connecting
 * clients catch up, then purged.
 */

export interface ProgressEvent {
  id?: number;
  deploymentId: string;
  type:
    | "step-started"
    | "step-completed"
    | "step-failed"
    | "rollback-started"
    | "rollback-completed"
    | "deployment-completed";
  stepIndex: number;
  stepDescription: string;
  status: "in_progress" | "completed" | "failed";
  output?: string;
  error?: string;
  timestamp: string;
  overallProgress: number;
}

export type ProgressListener = (event: ProgressEvent) => void;

const MAX_EVENTS = 100;
const CLEANUP_DELAY_MS = 60_000; // 1 minute after completion

export class ProgressEventStore {
  private buffers = new Map<string, ProgressEvent[]>();
  private listeners = new Map<string, Set<ProgressListener>>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private nextEventId = 1;

  /**
   * Push a new event for a deployment. Assigns a sequential ID,
   * stores in the ring buffer, and notifies all subscribed SSE listeners.
   */
  push(event: ProgressEvent): void {
    const { deploymentId } = event;

    // Assign sequential event ID for SSE Last-Event-ID replay
    event.id = this.nextEventId++;

    // Ensure buffer exists
    if (!this.buffers.has(deploymentId)) {
      this.buffers.set(deploymentId, []);
    }

    const buffer = this.buffers.get(deploymentId)!;

    // Ring buffer: drop oldest if at capacity
    if (buffer.length >= MAX_EVENTS) {
      buffer.shift();
    }
    buffer.push(event);

    // Notify listeners
    const listeners = this.listeners.get(deploymentId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Don't let a broken listener stop others
        }
      }
    }

    // Schedule cleanup if deployment completed
    if (event.type === "deployment-completed") {
      this.scheduleCleanup(deploymentId);
    }
  }

  /**
   * Get all buffered events for a deployment (for catch-up on SSE connect).
   */
  getEvents(deploymentId: string): ProgressEvent[] {
    return this.buffers.get(deploymentId) ?? [];
  }

  /**
   * Get buffered events after a given event ID (for reconnect replay).
   * Returns only events with id > afterId.
   */
  getEventsSince(deploymentId: string, afterId: number): ProgressEvent[] {
    const buffer = this.buffers.get(deploymentId) ?? [];
    return buffer.filter((e) => (e.id ?? 0) > afterId);
  }

  /**
   * Subscribe to new events for a deployment.
   */
  addListener(deploymentId: string, listener: ProgressListener): void {
    if (!this.listeners.has(deploymentId)) {
      this.listeners.set(deploymentId, new Set());
    }
    this.listeners.get(deploymentId)!.add(listener);
  }

  /**
   * Unsubscribe from events.
   */
  removeListener(deploymentId: string, listener: ProgressListener): void {
    const set = this.listeners.get(deploymentId);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(deploymentId);
      }
    }
  }

  /**
   * Schedule buffer cleanup after deployment completion.
   * Gives late-connecting clients time to catch up.
   */
  private scheduleCleanup(deploymentId: string): void {
    // Clear any existing timer
    const existing = this.cleanupTimers.get(deploymentId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.buffers.delete(deploymentId);
      this.listeners.delete(deploymentId);
      this.cleanupTimers.delete(deploymentId);
    }, CLEANUP_DELAY_MS);

    this.cleanupTimers.set(deploymentId, timer);
  }

  /**
   * Immediately clean up all data for a deployment (for testing).
   */
  clear(deploymentId: string): void {
    this.buffers.delete(deploymentId);
    this.listeners.delete(deploymentId);
    const timer = this.cleanupTimers.get(deploymentId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(deploymentId);
    }
  }
}
