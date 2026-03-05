import net from "node:net";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import type { Platform } from "../platform.js";
import type { OperationHandler, HandlerResult } from "../operation-registry.js";

// ---------------------------------------------------------------------------
// VerifyHandler — health checks and verification operations
// ---------------------------------------------------------------------------

/**
 * Handles verification and health check operations:
 * - HTTP health checks (fetch)
 * - TCP port checks (net.connect)
 * - File existence checks
 * - Process running checks
 *
 * Matches actions containing: verify, health, check, validate, test
 */
export class VerifyHandler implements OperationHandler {
  readonly name = "verify";

  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 10_000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  canHandle(action: string, _platform: Platform): boolean {
    const lower = action.toLowerCase();
    return (
      lower.includes("verify") ||
      lower.includes("health") ||
      lower.includes("check") ||
      lower.includes("validate") ||
      lower.includes("test")
    );
  }

  async execute(
    action: string,
    target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const lower = action.toLowerCase();
    const timeoutMs = (params.timeoutMs as number) ?? this.defaultTimeoutMs;

    try {
      // HTTP health check
      if (lower.includes("http") || lower.includes("health") || target.startsWith("http")) {
        return await this.httpCheck(target, timeoutMs, params);
      }

      // Port check
      if (lower.includes("port") || lower.includes("connect")) {
        return await this.portCheck(target, timeoutMs);
      }

      // File existence check
      if (lower.includes("file") || lower.includes("exists")) {
        return await this.fileCheck(target);
      }

      // Process check
      if (lower.includes("process") || lower.includes("pid") || lower.includes("running")) {
        return await this.processCheck(target);
      }

      // Default: try HTTP if target looks like a URL, otherwise file check
      if (target.startsWith("http://") || target.startsWith("https://")) {
        return await this.httpCheck(target, timeoutMs, params);
      }

      if (target.includes(":") && /^\d+$/.test(target.split(":").pop() ?? "")) {
        return await this.portCheck(target, timeoutMs);
      }

      return await this.fileCheck(target);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: "",
        error: `Verification "${action}" on "${target}" failed: ${message}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Check implementations
  // -------------------------------------------------------------------------

  private async httpCheck(
    url: string,
    timeoutMs: number,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const expectedStatus = (params.expectedStatus as number) ?? 200;
    const retries = (params.retries as number) ?? 3;
    const retryDelayMs = (params.retryDelayMs as number) ?? 1000;

    let lastError: string | undefined;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (response.status === expectedStatus) {
          return {
            success: true,
            output:
              `HTTP health check passed: ${url} returned ${response.status} ` +
              `(expected ${expectedStatus}) on attempt ${attempt}`,
          };
        }

        lastError =
          `HTTP ${response.status} (expected ${expectedStatus}) ` +
          `on attempt ${attempt}/${retries}`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = `Attempt ${attempt}/${retries}: ${message}`;
      }

      // Wait before retry (unless this was the last attempt)
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    return {
      success: false,
      output: "",
      error: `HTTP health check failed after ${retries} attempts: ${lastError}`,
    };
  }

  private async portCheck(target: string, timeoutMs: number): Promise<HandlerResult> {
    // Parse host:port from target
    const parts = target.split(":");
    const port = parseInt(parts.pop() ?? "0", 10);
    const host = parts.join(":") || "localhost";

    if (!port || port <= 0 || port > 65535) {
      return {
        success: false,
        output: "",
        error: `Invalid port in target "${target}". Expected format: host:port or just :port`,
      };
    }

    return new Promise((resolve) => {
      const socket = new net.Socket();
      let resolved = false;

      const done = (success: boolean, message: string) => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        resolve({
          success,
          output: success ? message : "",
          error: success ? undefined : message,
        });
      };

      socket.setTimeout(timeoutMs);
      socket.on("connect", () => done(true, `Port ${port} on ${host} is accepting connections`));
      socket.on("timeout", () => done(false, `Port ${port} on ${host} timed out after ${timeoutMs}ms`));
      socket.on("error", (err) => done(false, `Port ${port} on ${host}: ${err.message}`));

      socket.connect(port, host);
    });
  }

  private async fileCheck(target: string): Promise<HandlerResult> {
    try {
      const stat = await fs.stat(target);
      return {
        success: true,
        output:
          `File exists: ${target} ` +
          `(${stat.isDirectory() ? "directory" : "file"}, ` +
          `${stat.size} bytes, modified ${stat.mtime.toISOString()})`,
      };
    } catch {
      return {
        success: false,
        output: "",
        error: `File not found: ${target}`,
      };
    }
  }

  private async processCheck(target: string): Promise<HandlerResult> {
    // target is either a PID or a process name
    const pid = parseInt(target, 10);

    if (!isNaN(pid)) {
      // Check by PID
      try {
        process.kill(pid, 0); // Signal 0 just checks if process exists
        return {
          success: true,
          output: `Process ${pid} is running`,
        };
      } catch {
        return {
          success: false,
          output: "",
          error: `Process ${pid} is not running`,
        };
      }
    }

    // Check by name using pgrep
    return new Promise((resolve) => {
      execFile("pgrep", ["-f", target], { timeout: 5000 }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve({
            success: false,
            output: "",
            error: `No running process matching "${target}"`,
          });
        } else {
          const pids = stdout.trim().split("\n");
          resolve({
            success: true,
            output: `Process "${target}" is running (PID(s): ${pids.join(", ")})`,
          });
        }
      });
    });
  }
}
