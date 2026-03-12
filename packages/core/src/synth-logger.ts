import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// SynthLogger — generic rotating file-based logger
// ---------------------------------------------------------------------------

/**
 * A simple rotating file logger for Synth services. Each log entry is
 * timestamped and formatted for readability. Logs rotate at 5MB to prevent
 * unbounded growth. Errors in the logger itself are silently swallowed —
 * logging must never crash the system.
 */
export class SynthLogger {
  private logPath: string;
  private maxBytes = 5 * 1024 * 1024; // 5MB

  constructor(baseDir: string, name: string) {
    const logDir = path.join(baseDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    this.logPath = path.join(logDir, `${name}.log`);
  }

  /** Log an informational entry. */
  log(label: string, data?: unknown): void {
    this.write(label, data);
  }

  /** Log a warning entry — label is prefixed with "WARN". */
  warn(label: string, data?: unknown): void {
    this.write(`WARN ${label}`, data);
  }

  /** Log an error entry — label is prefixed with "ERROR". */
  error(label: string, data?: unknown): void {
    this.write(`ERROR ${label}`, data);
  }

  private write(label: string, data?: unknown): void {
    this.rotate();
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
