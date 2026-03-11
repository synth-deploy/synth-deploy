import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Blocked patterns — write/mutating operations not permitted during planning
// ---------------------------------------------------------------------------

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Output redirection
  { pattern: /(?:^|[^<])[>]/, reason: "contains > (output redirection)" },
  { pattern: />>/, reason: "contains >> (append redirection)" },
  // Pipe-to-write
  { pattern: /\|\s*tee\b/, reason: "contains | tee (write via pipe)" },
  // File/directory mutation
  { pattern: /\brm\b/, reason: "contains rm (file removal)" },
  { pattern: /\bmv\b/, reason: "contains mv (move/rename)" },
  { pattern: /\bchmod\b/, reason: "contains chmod (permission change)" },
  { pattern: /\bchown\b/, reason: "contains chown (ownership change)" },
  { pattern: /\btouch\b/, reason: "contains touch (file creation)" },
  { pattern: /\bmkdir\b/, reason: "contains mkdir (directory creation)" },
  { pattern: /\brmdir\b/, reason: "contains rmdir (directory removal)" },
  { pattern: /\bln\s/, reason: "contains ln (symlink creation)" },
  // Service/process mutation
  { pattern: /\bsystemctl\s+(start|stop|restart|enable|disable|mask|unmask)\b/, reason: "contains systemctl mutating operation" },
  { pattern: /\bservice\s+\S+\s+(start|stop|restart)\b/, reason: "contains service mutating operation" },
  { pattern: /\bkill\b/, reason: "contains kill (process termination)" },
  { pattern: /\bkillall\b/, reason: "contains killall (process termination)" },
  { pattern: /\bpkill\b/, reason: "contains pkill (process termination)" },
  // Container mutation
  { pattern: /\bdocker\s+(run|rm|stop|start|kill|rmi|create|pull|push|build|exec)\b/, reason: "contains docker mutating operation" },
  { pattern: /\bdocker-compose\s+(up|down|start|stop|restart|pull)\b/, reason: "contains docker-compose mutating operation" },
  // In-place editors
  { pattern: /\bsed\s+(-[^ ]*i|-i)\b/, reason: "contains sed -i (in-place edit)" },
  { pattern: /\bsed\b.*\s-i\b/, reason: "contains sed -i (in-place edit)" },
  // Package managers
  { pattern: /\bapt(?:-get)?\s+(install|remove|upgrade|purge)\b/, reason: "contains apt mutating operation" },
  { pattern: /\byum\s+(install|remove|update|upgrade)\b/, reason: "contains yum mutating operation" },
  { pattern: /\bdnf\s+(install|remove|update|upgrade)\b/, reason: "contains dnf mutating operation" },
  { pattern: /\bbrew\s+(install|uninstall|upgrade|update)\b/, reason: "contains brew mutating operation" },
  { pattern: /\bnpm\s+(install|uninstall|update|ci)\b/, reason: "contains npm mutating operation" },
  { pattern: /\bpip\s+install\b/, reason: "contains pip install" },
  // Downloads
  { pattern: /\bwget\b/, reason: "contains wget (download)" },
  { pattern: /\bcurl\b.*\s-[^ ]*[oO]\b/, reason: "contains curl -o (write to file)" },
  // Privilege escalation
  { pattern: /\bsudo\b/, reason: "contains sudo (privilege escalation)" },
  { pattern: /\bsu\s/, reason: "contains su (user switch)" },
  // Config writes
  { pattern: /\bcp\b/, reason: "contains cp (copy)" },
  { pattern: /\btee\b/, reason: "contains tee (write to file)" },
];

// ---------------------------------------------------------------------------
// ProbeResult
// ---------------------------------------------------------------------------

export interface ProbeResult {
  /** True if blocked by pattern or rbash — no command was executed */
  blocked: boolean;
  /** Human-readable reason the command was blocked, for LLM retry guidance */
  blockedReason?: string;
  /** Combined stdout + stderr from the command */
  output?: string;
  /** Exit code from the command (0 = success) */
  exitCode?: number;
}

// ---------------------------------------------------------------------------
// ProbeExecutor
// ---------------------------------------------------------------------------

/**
 * Executes read-only shell probes for the LLM planning phase.
 *
 * Safety is layered:
 * 1. Pattern rejection — blocks commands matching known write/mutating patterns
 * 2. Restricted bash (rbash) — prevents output redirection at shell level
 *
 * When blocked, returns a structured reason the LLM can act on and retry.
 */
export class ProbeExecutor {
  private readonly _timeoutMs: number;
  private readonly _maxOutputBytes: number;

  constructor(opts: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
    this._timeoutMs = opts.timeoutMs ?? 10_000;
    this._maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024;
  }

  async execute(command: string): Promise<ProbeResult> {
    // -----------------------------------------------------------------------
    // Layer 1: Pattern rejection
    // -----------------------------------------------------------------------
    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return {
          blocked: true,
          blockedReason:
            `Command blocked: ${reason} is not permitted during the planning phase. ` +
            `Try a read-only equivalent (e.g. ls, stat, cat, which, ps, df, id, uname).`,
        };
      }
    }

    // -----------------------------------------------------------------------
    // Layer 2: Execute in restricted bash (rbash)
    // -----------------------------------------------------------------------
    try {
      const { stdout, stderr } = await execFileAsync(
        "bash",
        ["--restricted", "-c", command],
        {
          timeout: this._timeoutMs,
          maxBuffer: this._maxOutputBytes,
          env: { ...process.env },
        },
      );

      const output = [stdout, stderr ? `[stderr: ${stderr.trim()}]` : ""]
        .filter(Boolean)
        .join("\n")
        .trim();

      return { blocked: false, output: output || "(no output)", exitCode: 0 };
    } catch (err: unknown) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
        signal?: string;
      };

      // rbash rejection — shell reports "restricted" in stderr
      const stderr = e.stderr ?? "";
      if (
        typeof e.code === "string" && e.code === "ENOENT" &&
        (command.startsWith("bash") || command === "bash")
      ) {
        return {
          blocked: true,
          blockedReason:
            "bash is not available on this system. Cannot execute probe. " +
            "You may need to rely on the static environment context provided above.",
        };
      }

      if (
        stderr.includes("restricted") ||
        stderr.includes("cannot") && stderr.includes("bash")
      ) {
        return {
          blocked: true,
          blockedReason:
            `Command blocked by restricted shell: ${stderr.trim()}. ` +
            `Try a read-only equivalent.`,
        };
      }

      if (e.killed || e.signal === "SIGTERM") {
        return {
          blocked: true,
          blockedReason: `Probe timed out after ${this._timeoutMs}ms. Try a simpler or faster command.`,
        };
      }

      // bash not found — fall back to direct execution without rbash
      if (typeof e.code === "string" && e.code === "ENOENT") {
        return this._executeDirect(command);
      }

      // Non-zero exit is fine — command ran, just failed (e.g. "which foo" → exit 1)
      const output = [e.stdout ?? "", stderr ? `[stderr: ${stderr.trim()}]` : ""]
        .filter(Boolean)
        .join("\n")
        .trim();

      return {
        blocked: false,
        output: output || "(no output)",
        exitCode: typeof e.code === "number" ? e.code : 1,
      };
    }
  }

  /**
   * Fallback executor used when bash is not available.
   * Pattern rejection is the sole safety layer in this path.
   */
  private async _executeDirect(command: string): Promise<ProbeResult> {
    // Split command into binary + args (naive, sufficient for read-only probes)
    const parts = command.trim().split(/\s+/);
    const bin = parts[0];
    const args = parts.slice(1);

    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: this._timeoutMs,
        maxBuffer: this._maxOutputBytes,
        env: { ...process.env },
      });

      const output = [stdout, stderr ? `[stderr: ${stderr.trim()}]` : ""]
        .filter(Boolean)
        .join("\n")
        .trim();

      return { blocked: false, output: output || "(no output)", exitCode: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number | string };
      const output = [e.stdout ?? "", e.stderr ? `[stderr: ${(e.stderr as string).trim()}]` : ""]
        .filter(Boolean)
        .join("\n")
        .trim();

      return {
        blocked: false,
        output: output || "(no output)",
        exitCode: typeof e.code === "number" ? e.code : 1,
      };
    }
  }
}
