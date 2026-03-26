import type { ExecutionProgressEvent, ProgressCallback } from "./operation-executor.js";

// ---------------------------------------------------------------------------
// Schema translation — maps envoy's script-phase events to the step-based
// format the server's ProgressEventSchema expects.
// ---------------------------------------------------------------------------

const PHASE_STEP: Record<string, { stepIndex: number; stepDescription: string }> = {
  "dry-run":  { stepIndex: 0, stepDescription: "Dry run" },
  "execution": { stepIndex: 1, stepDescription: "Executing" },
  "rollback":  { stepIndex: 2, stepDescription: "Rolling back" },
};

interface ServerProgressEvent {
  deploymentId: string;
  type: string;
  stepIndex: number;
  stepDescription: string;
  status: "in_progress" | "completed" | "failed";
  output?: string;
  error?: string;
  timestamp: string;
  overallProgress: number;
}

function toServerEvent(event: ExecutionProgressEvent): ServerProgressEvent | null {
  const step = PHASE_STEP[event.phase] ?? { stepIndex: 0, stepDescription: event.phase };
  const ts = event.timestamp instanceof Date
    ? event.timestamp.toISOString()
    : (event.timestamp as string);

  switch (event.type) {
    case "script-started":
      return { deploymentId: event.deploymentId, type: "step-started", ...step, status: "in_progress", timestamp: ts, overallProgress: event.overallProgress };
    case "script-completed":
      return { deploymentId: event.deploymentId, type: "step-completed", ...step, status: "completed", output: event.output, timestamp: ts, overallProgress: event.overallProgress };
    case "script-failed":
      return { deploymentId: event.deploymentId, type: "step-failed", ...step, status: "failed", error: event.error, output: event.output, timestamp: ts, overallProgress: event.overallProgress };
    case "rollback-started":
      return { deploymentId: event.deploymentId, type: "rollback-started", ...PHASE_STEP["rollback"], status: "in_progress", timestamp: ts, overallProgress: event.overallProgress };
    case "rollback-completed":
      return { deploymentId: event.deploymentId, type: "rollback-completed", ...PHASE_STEP["rollback"], status: "completed", timestamp: ts, overallProgress: event.overallProgress };
    case "deployment-completed":
      return { deploymentId: event.deploymentId, type: "deployment-completed", stepIndex: 99, stepDescription: "Done", status: event.status, timestamp: ts, overallProgress: 100 };
    case "script-output":
      return null; // stdout lines — not forwarded individually
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// createCallbackReporter
// ---------------------------------------------------------------------------

/**
 * Creates a ProgressCallback that POSTs events to a callback URL.
 *
 * Translates the envoy's script-phase event model to the step-based format
 * the server's ProgressEventSchema expects. Buffers at 500ms intervals.
 * On POST failure, retries with exponential backoff (capped at 30s).
 * Failures are non-fatal — the synchronous result delivery is the fallback.
 */
export function createCallbackReporter(callbackUrl: string, token?: string): ProgressCallback {
  let pendingEvents: ServerProgressEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;
  let backoffMs = 500;
  const MAX_BACKOFF_MS = 30_000;
  const BUFFER_INTERVAL_MS = 500;

  async function sendEvent(event: ServerProgressEvent): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const response = await fetch(callbackUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(event),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        backoffMs = 500;
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
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        break;
      }
    }

    sending = false;
  }

  return (event: ExecutionProgressEvent): void => {
    const translated = toServerEvent(event);
    if (!translated) return; // script-output and unmapped events are skipped

    pendingEvents.push(translated);

    const isTerminal = translated.type === "deployment-completed" || translated.type === "step-failed";
    if (isTerminal) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      void flush();
      return;
    }

    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
      }, BUFFER_INTERVAL_MS);
    }
  };
}
