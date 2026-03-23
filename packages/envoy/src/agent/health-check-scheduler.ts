import type { MonitoringDirective, TriggerStatus, HealthReport } from "@synth-deploy/core";
import type { ProbeExecutor, ProbeResult } from "./probe-executor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthCheckSchedulerOptions {
  /** Callback when a trigger fires — sends health report to server */
  onTriggerFired: (report: HealthReport) => void;
  /** Minimum interval for any directive (floor, milliseconds). Default: 10_000 */
  minIntervalMs?: number;
}

interface ActiveDirective {
  directive: MonitoringDirective;
  timer: ReturnType<typeof setInterval> | null;
  lastFiredAt: number;
  fireCount: number;
  suppressedCount: number;
}

// ---------------------------------------------------------------------------
// HealthCheckScheduler
// ---------------------------------------------------------------------------

/**
 * Manages monitoring directives installed by approved trigger operations.
 * Runs probes on configured intervals using the existing ProbeExecutor,
 * evaluates conditions against results, and reports to the server when
 * thresholds are crossed. Respects cooldown periods.
 */
export class HealthCheckScheduler {
  private readonly _directives = new Map<string, ActiveDirective>();
  private readonly _probeExecutor: ProbeExecutor;
  private readonly _onTriggerFired: (report: HealthReport) => void;
  private readonly _minIntervalMs: number;
  private readonly _envoyId: string;

  constructor(
    probeExecutor: ProbeExecutor,
    envoyId: string,
    opts: HealthCheckSchedulerOptions,
  ) {
    this._probeExecutor = probeExecutor;
    this._envoyId = envoyId;
    this._onTriggerFired = opts.onTriggerFired;
    this._minIntervalMs = opts.minIntervalMs ?? 10_000;
  }

  /** Install a monitoring directive and start its check loop. */
  install(directive: MonitoringDirective): void {
    // Remove existing directive with the same ID (re-install)
    if (this._directives.has(directive.id)) {
      this.remove(directive.id);
    }

    const active: ActiveDirective = {
      directive,
      timer: null,
      lastFiredAt: 0,
      fireCount: 0,
      suppressedCount: 0,
    };

    this._directives.set(directive.id, active);

    if (directive.status === "active") {
      this._startTimer(active);
    }
  }

  /** Remove a monitoring directive and stop its check loop. */
  remove(id: string): void {
    const active = this._directives.get(id);
    if (!active) return;
    this._stopTimer(active);
    this._directives.delete(id);
  }

  /** Pause a monitoring directive (stop checks, keep state). */
  pause(id: string): boolean {
    const active = this._directives.get(id);
    if (!active) return false;
    active.directive.status = "paused";
    this._stopTimer(active);
    return true;
  }

  /** Resume a paused monitoring directive. */
  resume(id: string): boolean {
    const active = this._directives.get(id);
    if (!active || active.directive.status !== "paused") return false;
    active.directive.status = "active";
    this._startTimer(active);
    return true;
  }

  /** Disable a monitoring directive permanently. */
  disable(id: string): boolean {
    const active = this._directives.get(id);
    if (!active) return false;
    active.directive.status = "disabled";
    this._stopTimer(active);
    return true;
  }

  /** Get a single directive's state. */
  get(id: string): { directive: MonitoringDirective; lastFiredAt: number; fireCount: number; suppressedCount: number } | undefined {
    const active = this._directives.get(id);
    if (!active) return undefined;
    return {
      directive: active.directive,
      lastFiredAt: active.lastFiredAt,
      fireCount: active.fireCount,
      suppressedCount: active.suppressedCount,
    };
  }

  /** List all installed directives with their runtime state. */
  list(): Array<{ directive: MonitoringDirective; lastFiredAt: number; fireCount: number; suppressedCount: number }> {
    return Array.from(this._directives.values()).map((a) => ({
      directive: a.directive,
      lastFiredAt: a.lastFiredAt,
      fireCount: a.fireCount,
      suppressedCount: a.suppressedCount,
    }));
  }

  /** Stop all timers (for graceful shutdown). */
  shutdown(): void {
    for (const active of this._directives.values()) {
      this._stopTimer(active);
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _startTimer(active: ActiveDirective): void {
    if (active.timer) return;
    const interval = Math.max(active.directive.intervalMs, this._minIntervalMs);
    active.timer = setInterval(() => this._runCheck(active), interval);
    // Also run an initial check immediately
    this._runCheck(active);
  }

  private _stopTimer(active: ActiveDirective): void {
    if (active.timer) {
      clearInterval(active.timer);
      active.timer = null;
    }
  }

  private async _runCheck(active: ActiveDirective): Promise<void> {
    if (active.directive.status !== "active") return;

    const { directive } = active;

    // Execute all probes
    const probeResults: Array<{
      label: string;
      command: string;
      output: string;
      exitCode?: number;
      parsedValue?: number;
    }> = [];

    for (const probe of directive.probes) {
      let result: ProbeResult;
      try {
        result = await this._probeExecutor.execute(probe.command);
      } catch {
        // Probe execution error — skip this check cycle
        continue;
      }

      if (result.blocked) continue;

      const entry: typeof probeResults[number] = {
        label: probe.label,
        command: probe.command,
        output: result.output ?? "",
        exitCode: result.exitCode,
      };

      if (probe.parseAs === "numeric") {
        const num = parseFloat(result.output ?? "");
        if (!isNaN(num)) entry.parsedValue = num;
      } else if (probe.parseAs === "exitCode") {
        entry.parsedValue = result.exitCode;
      }

      probeResults.push(entry);
    }

    if (probeResults.length === 0) return;

    // Evaluate condition
    const fired = this._evaluateCondition(directive.condition, probeResults);
    if (!fired) return;

    // Cooldown check
    const now = Date.now();
    if (active.lastFiredAt > 0 && (now - active.lastFiredAt) < directive.cooldownMs) {
      active.suppressedCount++;
      return;
    }

    // Fire!
    active.lastFiredAt = now;
    active.fireCount++;

    const report: HealthReport = {
      directiveId: directive.id,
      triggerOperationId: directive.operationId,
      envoyId: this._envoyId,
      probeResults,
      summary: `Trigger condition met: ${directive.condition}`,
      detectedAt: new Date(now),
      environmentId: directive.environmentId,
      partitionId: directive.partitionId,
    };

    try {
      this._onTriggerFired(report);
    } catch {
      // Fire-and-forget — don't let reporting errors crash the scheduler
    }
  }

  /**
   * Evaluate a condition string against probe results.
   *
   * Supported condition formats:
   * - `{label} > {threshold}` — numeric comparison (>, <, >=, <=, ==, !=)
   * - `{label} contains {substring}` — string match
   * - `exitCode != 0` — exit code check
   * - `any failed` — any probe returned non-zero exit code
   *
   * The condition is evaluated left-to-right. Multiple conditions
   * can be joined with `&&` (all must pass) or `||` (any must pass).
   */
  _evaluateCondition(
    condition: string,
    probeResults: Array<{ label: string; output: string; exitCode?: number; parsedValue?: number }>,
  ): boolean {
    // Handle OR clauses
    if (condition.includes("||")) {
      return condition.split("||").some((clause) =>
        this._evaluateCondition(clause.trim(), probeResults),
      );
    }

    // Handle AND clauses
    if (condition.includes("&&")) {
      return condition.split("&&").every((clause) =>
        this._evaluateCondition(clause.trim(), probeResults),
      );
    }

    // Special: "any failed"
    if (condition.trim().toLowerCase() === "any failed") {
      return probeResults.some((r) => r.exitCode !== undefined && r.exitCode !== 0);
    }

    // "contains" check: {label} contains {substring}
    const containsMatch = condition.match(/^(.+?)\s+contains\s+(.+)$/i);
    if (containsMatch) {
      const [, labelPart, substring] = containsMatch;
      const label = labelPart.trim();
      const probe = probeResults.find((r) => r.label.toLowerCase() === label.toLowerCase());
      if (!probe) return false;
      return probe.output.includes(substring.trim().replace(/^["']|["']$/g, ""));
    }

    // Numeric comparison: {label} {op} {threshold}
    const comparisonMatch = condition.match(/^(.+?)\s*(>=|<=|!=|==|>|<)\s*(.+)$/);
    if (comparisonMatch) {
      const [, labelPart, op, thresholdPart] = comparisonMatch;
      const label = labelPart.trim();
      const threshold = parseFloat(thresholdPart.trim());
      if (isNaN(threshold)) return false;

      const probe = probeResults.find((r) => r.label.toLowerCase() === label.toLowerCase());
      if (!probe || probe.parsedValue === undefined) return false;

      const val = probe.parsedValue;
      switch (op) {
        case ">": return val > threshold;
        case "<": return val < threshold;
        case ">=": return val >= threshold;
        case "<=": return val <= threshold;
        case "==": return val === threshold;
        case "!=": return val !== threshold;
        default: return false;
      }
    }

    return false;
  }
}
