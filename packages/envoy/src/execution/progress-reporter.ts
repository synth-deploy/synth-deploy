import type { ExecutionProgressEvent, ProgressCallback } from "./operation-executor.js";

/**
 * Creates a ProgressCallback that POSTs events to a callback URL.
 *
 * Buffers output at 500ms intervals to avoid overwhelming the receiver.
 * On POST failure, buffers events and retries with exponential backoff
 * (capped at 30s). Failures are non-fatal — the synchronous result
 * delivery remains the guaranteed fallback.
 */
export function createCallbackReporter(callbackUrl: string, token?: string): ProgressCallback {
  let pendingEvents: ExecutionProgressEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;
  let backoffMs = 500;
  const MAX_BACKOFF_MS = 30_000;
  const BUFFER_INTERVAL_MS = 500;

  async function sendEvent(event: ExecutionProgressEvent): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const response = await fetch(callbackUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...event,
          timestamp: event.timestamp instanceof Date
            ? event.timestamp.toISOString()
            : event.timestamp,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        backoffMs = 500; // Reset backoff on success
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  async function flush(): Promise<void> {
    if (sending || pendingEvents.length === 0) return;
    sending = true;

    while (pendingEvents.length > 0) {
      const event = pendingEvents[0];
      const ok = await sendEvent(event);

      if (ok) {
        pendingEvents.shift();
      } else {
        // Exponential backoff, capped
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        // Try again on next flush cycle — don't block forever
        break;
      }
    }

    sending = false;
  }

  return (event: ExecutionProgressEvent): void => {
    pendingEvents.push(event);

    // For terminal events, flush immediately
    if (event.type === "deployment-completed" || event.type === "script-failed") {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      void flush();
      return;
    }

    // Buffer at 500ms intervals for non-terminal events
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, BUFFER_INTERVAL_MS);
    }
  };
}
