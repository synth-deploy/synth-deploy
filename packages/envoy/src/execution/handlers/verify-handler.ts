import net from "node:net";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import type { PlannedStep } from "@synth-deploy/core";
import type { Platform } from "../platform.js";
import type { OperationHandler, HandlerResult, DryRunResult } from "../operation-registry.js";

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
  readonly actionKeywords = ["verify", "health", "check", "validate", "test"] as const;
  readonly toolDependencies = [] as const;

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

      // Bare word with no path separators → treat as command name, check via `which`/`where`
      if (!target.includes("/") && !target.includes("\\") && !target.includes(".")) {
        return await this.commandCheck(target);
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

  async dryRun(
    step: PlannedStep,
    _predictedOutcomes: Map<number, Record<string, unknown>>,
  ): Promise<DryRunResult> {
    const observations: DryRunResult["observations"] = [];
    const target = step.target;
    const unknowns: string[] = [];

    try {
      // For HTTP targets: basic reachability check (DNS resolve, not full request)
      if (target.startsWith("http://") || target.startsWith("https://")) {
        try {
          const url = new URL(target);
          // Check if hostname resolves — lightweight DNS check
          const dns = await import("node:dns/promises");
          await dns.lookup(url.hostname);
          observations.push({
            name: "target-resolvable",
            passed: true,
            detail: `Hostname "${url.hostname}" resolves — target is reachable for verification`,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          observations.push({
            name: "target-resolvable",
            passed: false,
            detail: `Cannot resolve hostname for "${target}": ${message} — verification will fail`,
          });
        }
      }

      // For port targets (host:port format)
      else if (target.includes(":") && /^\d+$/.test(target.split(":").pop() ?? "")) {
        const parts = target.split(":");
        const port = parseInt(parts.pop() ?? "0", 10);
        const host = parts.join(":") || "localhost";

        observations.push({
          name: "port-format-valid",
          passed: port > 0 && port <= 65535,
          detail: port > 0 && port <= 65535
            ? `Port ${port} on ${host} is a valid target for connectivity check`
            : `Port ${port} is not a valid port number`,
        });
      }

      // Bare word with no path separators → treat as command name, check via `which`/`where`
      else if (!target.includes("/") && !target.includes("\\") && !target.includes(".")) {
        const whichCmd = process.platform === "win32" ? "where" : "which";
        const found = await new Promise<boolean>((resolve) => {
          execFile(whichCmd, [target], { timeout: 5000 }, (error) => resolve(!error));
        });
        observations.push({
          name: "command-installed",
          passed: found,
          detail: found
            ? `Command "${target}" is available on PATH`
            : `Command "${target}" not found on PATH — install it before executing this deployment`,
        });
      }

      // For file targets
      else {
        observations.push({
          name: "verification-target-noted",
          passed: true,
          detail: `Will verify file existence at "${target}" post-deployment`,
        });
      }

      unknowns.push(
        `Verification results cannot be predicted before deployment — this step runs post-deployment`,
      );

      return {
        observations,
        fidelity: "unknown",
        unknowns,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        observations: [
          {
            name: "dry-run-error",
            passed: true,
            detail: `Dry-run connectivity check failed (${message}) — verification will still be attempted post-deployment`,
          },
        ],
        fidelity: "unknown",
        unknowns: [`Could not pre-validate verification target "${target}"`],
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

  private async commandCheck(target: string): Promise<HandlerResult> {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    return new Promise((resolve) => {
      execFile(whichCmd, [target], { timeout: 5000 }, (error, stdout) => {
        if (error) {
          resolve({
            success: false,
            output: "",
            error: `Command "${target}" not found on PATH — install it before running this deployment`,
          });
        } else {
          resolve({
            success: true,
            output: `Command "${target}" is available at ${stdout.trim()}`,
          });
        }
      });
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
