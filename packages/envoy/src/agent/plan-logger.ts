import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// PlanLogger — structured file-based logging for the planning loop
// ---------------------------------------------------------------------------

/**
 * Writes structured planning logs to a file so debugging doesn't require
 * copying from the terminal. Each planning request gets a header with
 * timestamp and request ID; each event is timestamped and indented for
 * readability.
 *
 * Logs rotate at 5MB to prevent unbounded growth.
 */
export class PlanLogger {
  private logPath: string;
  private maxBytes = 5 * 1024 * 1024; // 5MB

  constructor(baseDir: string) {
    const logDir = path.join(baseDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, "planning.log");
  }

  /** Start a new planning request block */
  startRequest(requestId: string, artifact: string, version: string, environment: string): void {
    this.rotate();
    const header =
      `\n${"=".repeat(80)}\n` +
      `PLAN REQUEST ${requestId}  ${new Date().toISOString()}\n` +
      `  artifact: ${artifact}  version: ${version}  env: ${environment}\n` +
      `${"=".repeat(80)}\n`;
    this.append(header);
  }

  /** Log an event within the current request */
  log(label: string, data?: unknown): void {
    const ts = new Date().toISOString();
    let line = `[${ts}] ${label}`;
    if (data !== undefined) {
      if (typeof data === "string") {
        line += `: ${data}`;
      } else {
        try {
          line += `:\n${JSON.stringify(data, null, 2)}`;
        } catch {
          line += `: ${String(data)}`;
        }
      }
    }
    this.append(line + "\n");
  }

  /** Log the full plan steps for debugging */
  logPlanSteps(label: string, steps: Array<{ action: string; target: string; description: string; params?: unknown }>): void {
    const lines = steps.map(
      (s, i) => `  [${i}] action="${s.action}" target="${s.target}" desc="${s.description}"${s.params ? ` params=${JSON.stringify(s.params)}` : ""}`,
    );
    this.append(`[${new Date().toISOString()}] ${label}:\n${lines.join("\n")}\n`);
  }

  /** Log dry-run results with observations */
  logDryRun(
    attempt: number,
    results: Array<{
      stepIndex: number;
      stepDesc: string;
      handler: string | null;
      observations: Array<{ name: string; passed: boolean; detail: string }>;
      predictedOutcome?: Record<string, unknown>;
    }>,
  ): void {
    const lines: string[] = [`[${new Date().toISOString()}] DRY-RUN attempt ${attempt}:`];
    for (const r of results) {
      lines.push(`  Step ${r.stepIndex}: "${r.stepDesc}" (handler: ${r.handler ?? "NONE"})`);
      for (const o of r.observations) {
        lines.push(`    ${o.passed ? "PASS" : "FAIL"} [${o.name}] ${o.detail}`);
      }
      if (r.predictedOutcome) {
        lines.push(`    → predicted: ${JSON.stringify(r.predictedOutcome)}`);
      }
    }
    this.append(lines.join("\n") + "\n");
  }

  private append(text: string): void {
    try {
      fs.appendFileSync(this.logPath, text);
    } catch {
      // Logging should never crash the system
    }
  }

  private rotate(): void {
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size > this.maxBytes) {
        const rotated = this.logPath + ".1";
        try { fs.unlinkSync(rotated); } catch { /* ignore */ }
        fs.renameSync(this.logPath, rotated);
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
  }
}
