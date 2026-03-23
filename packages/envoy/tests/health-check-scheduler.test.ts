import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthCheckScheduler } from "../src/agent/health-check-scheduler.js";
import type { MonitoringDirective, HealthReport } from "@synth-deploy/core";

// ---------------------------------------------------------------------------
// Minimal ProbeExecutor stub
// ---------------------------------------------------------------------------

function makeProbeExecutor(results: Record<string, { output: string; exitCode: number }>) {
  return {
    execute: vi.fn(async (command: string) => {
      const result = results[command];
      if (!result) return { blocked: false, output: "(no output)", exitCode: 1 };
      return { blocked: false, output: result.output, exitCode: result.exitCode };
    }),
    clearCache: vi.fn(),
  } as any;
}

function makeDirective(overrides: Partial<MonitoringDirective> = {}): MonitoringDirective {
  return {
    id: "dir-1",
    operationId: "op-1",
    probes: [
      { command: "df -h / | awk 'NR==2{print $5}' | tr -d '%'", label: "disk_usage", parseAs: "numeric" },
    ],
    intervalMs: 60_000,
    cooldownMs: 300_000,
    condition: "disk_usage > 85",
    responseIntent: "Run log cleanup",
    responseType: "maintain",
    environmentId: "env-1",
    partitionId: "part-1",
    status: "active",
    ...overrides,
  };
}

describe("HealthCheckScheduler", () => {
  let scheduler: HealthCheckScheduler;
  let firedReports: HealthReport[];

  beforeEach(() => {
    vi.useFakeTimers();
    firedReports = [];
  });

  afterEach(() => {
    scheduler?.shutdown();
    vi.useRealTimers();
  });

  it("installs and lists directives", () => {
    const probe = makeProbeExecutor({});
    scheduler = new HealthCheckScheduler(probe, "envoy-test", {
      onTriggerFired: (r) => firedReports.push(r),
      minIntervalMs: 100,
    });

    const directive = makeDirective();
    scheduler.install(directive);

    const list = scheduler.list();
    expect(list).toHaveLength(1);
    expect(list[0].directive.id).toBe("dir-1");
  });

  it("fires when condition is met", async () => {
    const probe = makeProbeExecutor({
      "df -h / | awk 'NR==2{print $5}' | tr -d '%'": { output: "92", exitCode: 0 },
    });
    scheduler = new HealthCheckScheduler(probe, "envoy-test", {
      onTriggerFired: (r) => firedReports.push(r),
      minIntervalMs: 100,
    });

    scheduler.install(makeDirective({ intervalMs: 100, cooldownMs: 0 }));

    // The initial check runs immediately on install — wait for async probes
    await vi.advanceTimersByTimeAsync(50);

    expect(firedReports).toHaveLength(1);
    expect(firedReports[0].summary).toContain("disk_usage > 85");
    expect(firedReports[0].envoyId).toBe("envoy-test");
    expect(firedReports[0].probeResults[0].parsedValue).toBe(92);
  });

  it("does NOT fire when condition is not met", async () => {
    const probe = makeProbeExecutor({
      "df -h / | awk 'NR==2{print $5}' | tr -d '%'": { output: "42", exitCode: 0 },
    });
    scheduler = new HealthCheckScheduler(probe, "envoy-test", {
      onTriggerFired: (r) => firedReports.push(r),
      minIntervalMs: 100,
    });

    scheduler.install(makeDirective({ intervalMs: 100, cooldownMs: 0 }));
    await vi.advanceTimersByTimeAsync(50);

    expect(firedReports).toHaveLength(0);
  });

  it("respects cooldown", async () => {
    const probe = makeProbeExecutor({
      "df -h / | awk 'NR==2{print $5}' | tr -d '%'": { output: "92", exitCode: 0 },
    });
    scheduler = new HealthCheckScheduler(probe, "envoy-test", {
      onTriggerFired: (r) => firedReports.push(r),
      minIntervalMs: 100,
    });

    scheduler.install(makeDirective({ intervalMs: 200, cooldownMs: 5000 }));

    // First check fires
    await vi.advanceTimersByTimeAsync(50);
    expect(firedReports).toHaveLength(1);

    // Second check within cooldown — should be suppressed
    await vi.advanceTimersByTimeAsync(250);
    expect(firedReports).toHaveLength(1);

    const state = scheduler.get("dir-1")!;
    expect(state.suppressedCount).toBe(1);
  });

  it("pauses and resumes", async () => {
    const probe = makeProbeExecutor({
      "df -h / | awk 'NR==2{print $5}' | tr -d '%'": { output: "92", exitCode: 0 },
    });
    scheduler = new HealthCheckScheduler(probe, "envoy-test", {
      onTriggerFired: (r) => firedReports.push(r),
      minIntervalMs: 100,
    });

    scheduler.install(makeDirective({ intervalMs: 200, cooldownMs: 0 }));
    await vi.advanceTimersByTimeAsync(50);
    expect(firedReports).toHaveLength(1);

    // Pause — no more firings
    scheduler.pause("dir-1");
    await vi.advanceTimersByTimeAsync(500);
    expect(firedReports).toHaveLength(1);

    // Resume — should fire again
    scheduler.resume("dir-1");
    await vi.advanceTimersByTimeAsync(50);
    expect(firedReports).toHaveLength(2);
  });

  it("removes directives", () => {
    const probe = makeProbeExecutor({});
    scheduler = new HealthCheckScheduler(probe, "envoy-test", {
      onTriggerFired: (r) => firedReports.push(r),
      minIntervalMs: 100,
    });

    scheduler.install(makeDirective());
    expect(scheduler.list()).toHaveLength(1);

    scheduler.remove("dir-1");
    expect(scheduler.list()).toHaveLength(0);
  });

  describe("condition evaluation", () => {
    let probe: ReturnType<typeof makeProbeExecutor>;

    beforeEach(() => {
      probe = makeProbeExecutor({});
      scheduler = new HealthCheckScheduler(probe, "envoy-test", {
        onTriggerFired: (r) => firedReports.push(r),
        minIntervalMs: 100,
      });
    });

    const testProbeResults = [
      { label: "disk_usage", command: "df", output: "92", exitCode: 0, parsedValue: 92 },
      { label: "memory", command: "free", output: "75", exitCode: 0, parsedValue: 75 },
    ];

    it("evaluates > correctly", () => {
      expect(scheduler._evaluateCondition("disk_usage > 85", testProbeResults)).toBe(true);
      expect(scheduler._evaluateCondition("disk_usage > 95", testProbeResults)).toBe(false);
    });

    it("evaluates < correctly", () => {
      expect(scheduler._evaluateCondition("memory < 80", testProbeResults)).toBe(true);
      expect(scheduler._evaluateCondition("memory < 70", testProbeResults)).toBe(false);
    });

    it("evaluates == correctly", () => {
      expect(scheduler._evaluateCondition("disk_usage == 92", testProbeResults)).toBe(true);
      expect(scheduler._evaluateCondition("disk_usage == 91", testProbeResults)).toBe(false);
    });

    it("evaluates != correctly", () => {
      expect(scheduler._evaluateCondition("disk_usage != 91", testProbeResults)).toBe(true);
      expect(scheduler._evaluateCondition("disk_usage != 92", testProbeResults)).toBe(false);
    });

    it("evaluates && (AND)", () => {
      expect(scheduler._evaluateCondition("disk_usage > 85 && memory < 80", testProbeResults)).toBe(true);
      expect(scheduler._evaluateCondition("disk_usage > 95 && memory < 80", testProbeResults)).toBe(false);
    });

    it("evaluates || (OR)", () => {
      expect(scheduler._evaluateCondition("disk_usage > 95 || memory < 80", testProbeResults)).toBe(true);
      expect(scheduler._evaluateCondition("disk_usage > 95 || memory > 80", testProbeResults)).toBe(false);
    });

    it("evaluates 'any failed'", () => {
      expect(scheduler._evaluateCondition("any failed", [
        { label: "check", command: "echo", output: "", exitCode: 1 },
      ])).toBe(true);
      expect(scheduler._evaluateCondition("any failed", testProbeResults)).toBe(false);
    });

    it("evaluates 'contains'", () => {
      expect(scheduler._evaluateCondition("disk_usage contains 9", [
        { label: "disk_usage", command: "df", output: "92%", exitCode: 0 },
      ])).toBe(true);
    });
  });
});
