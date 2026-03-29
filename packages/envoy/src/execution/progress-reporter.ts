import type { ExecutionProgressEvent, ProgressCallback } from "./operation-executor.js";

// ---------------------------------------------------------------------------
// Schema translation — maps envoy's per-step events to the format
// the server's ProgressEventSchema expects.
// ---------------------------------------------------------------------------

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
  const ts = event.timestamp instanceof Date
    ? event.timestamp.toISOString()
    : (event.timestamp as string);

  switch (event.type) {
    case "plan-step-started":
      return { deploymentId: event.deploymentId, type: "plan-step-started", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "in_progress", timestamp: ts, overallProgress: event.overallProgress };
    case "plan-step-completed":
      return { deploymentId: event.deploymentId, type: "plan-step-completed", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "completed", timestamp: ts, overallProgress: event.overallProgress };
    case "plan-step-failed":
      return { deploymentId: event.deploymentId, type: "plan-step-failed", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "failed", error: event.error, timestamp: ts, overallProgress: event.overallProgress };
    case "step-output":
      return { deploymentId: event.deploymentId, type: "step-output", stepIndex: event.stepIndex ?? 0, stepDescription: "", status: "in_progress", output: event.output, timestamp: ts, overallProgress: event.overallProgress };
    case "rollback-step-started":
      return { deploymentId: event.deploymentId, type: "rollback-step-started", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "in_progress", timestamp: ts, overallProgress: event.overallProgress };
    case "rollback-step-completed":
      return { deploymentId: event.deploymentId, type: "rollback-step-completed", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "completed", timestamp: ts, overallProgress: event.overallProgress };
    case "rollback-step-failed":
      return { deploymentId: event.deploymentId, type: "rollback-step-failed", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "failed", error: event.error, timestamp: ts, overallProgress: event.overallProgress };
    case "rollback-step-skipped":
      return { deploymentId: event.deploymentId, type: "rollback-step-skipped", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "completed", timestamp: ts, overallProgress: event.overallProgress };
    case "dry-run-step-started":
      return { deploymentId: event.deploymentId, type: "dry-run-step-started", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "in_progress", timestamp: ts, overallProgress: event.overallProgress };
    case "dry-run-step-passed":
      return { deploymentId: event.deploymentId, type: "dry-run-step-passed", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "completed", output: event.output, timestamp: ts, overallProgress: event.overallProgress };
    case "dry-run-step-failed":
      return { deploymentId: event.deploymentId, type: "dry-run-step-failed", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "failed", error: event.error, output: event.output, timestamp: ts, overallProgress: event.overallProgress };
    case "dry-run-step-skipped":
      return { deploymentId: event.deploymentId, type: "dry-run-step-skipped", stepIndex: event.stepIndex ?? 0, stepDescription: event.stepDescription ?? "", status: "completed", timestamp: ts, overallProgress: event.overallProgress };
    case "deployment-completed":
      return { deploymentId: event.deploymentId, type: "deployment-completed", stepIndex: 99, stepDescription: "Done", status: event.status, timestamp: ts, overallProgress: 100 };
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
 * Translates the envoy's per-step event model to the format
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
    if (!translated) return; // unmapped events are skipped

    pendingEvents.push(translated);

    const isTerminal = translated.type === "deployment-completed" || translated.type === "plan-step-failed";
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
