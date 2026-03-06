import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { LlmClient, LlmResult, LlmCallParams } from "@synth-deploy/core";
import { DiagnosticInvestigator } from "../src/agent/diagnostic-investigator.js";
import type { DeploymentInstruction } from "../src/agent/envoy-agent.js";
import { LocalStateStore } from "../src/state/local-state.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "envoy-diag-llm-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function makeInstruction(
  overrides: Partial<DeploymentInstruction> = {},
): DeploymentInstruction {
  return {
    deploymentId: `deploy-${Date.now()}`,
    partitionId: "partition-1",
    environmentId: "env-prod",
    operationId: "web-app",
    version: "2.0.0",
    variables: {
      APP_ENV: "production",
      LOG_LEVEL: "warn",
      DB_HOST: "db-prod.internal:5432",
      CACHE_HOST: "redis-prod.internal:6379",
    },
    environmentName: "production",
    partitionName: "Acme Corp",
    ...overrides,
  };
}

/**
 * Create a mock LlmClient that returns controlled responses.
 */
function createMockLlm(overrides: {
  isAvailable?: boolean;
  classifyResult?: LlmResult;
  reasonResult?: LlmResult;
} = {}): LlmClient & {
  classifyCalls: LlmCallParams[];
  reasonCalls: LlmCallParams[];
} {
  const classifyCalls: LlmCallParams[] = [];
  const reasonCalls: LlmCallParams[] = [];

  return {
    classifyCalls,
    reasonCalls,
    isAvailable: vi.fn(() => overrides.isAvailable ?? true),
    classify: vi.fn(async (params: LlmCallParams): Promise<LlmResult> => {
      classifyCalls.push(params);
      return overrides.classifyResult ?? { ok: false, fallback: true, reason: "mock: no result configured" };
    }),
    reason: vi.fn(async (params: LlmCallParams): Promise<LlmResult> => {
      reasonCalls.push(params);
      return overrides.reasonResult ?? { ok: false, fallback: true, reason: "mock: no result configured" };
    }),
  };
}

/**
 * Set up a workspace with logs but no regex-matchable patterns.
 * This is the scenario where LLM fallback should kick in.
 */
function setupCleanLogsWorkspace(
  workspacePath: string,
  logContent: string,
): void {
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "logs"), { recursive: true });

  // Write all expected artifacts
  fs.writeFileSync(path.join(workspacePath, "manifest.json"), "{}");
  fs.writeFileSync(path.join(workspacePath, "variables.env"), "APP_ENV=production");
  fs.writeFileSync(path.join(workspacePath, "VERSION"), "2.0.0");
  fs.writeFileSync(path.join(workspacePath, "STATUS"), "FAILED");

  // Logs that won't match any regex pattern
  fs.writeFileSync(path.join(workspacePath, "logs", "service.log"), logContent);
}

/**
 * Set up a workspace with logs that DO match regex patterns.
 */
function setupRegexMatchWorkspace(workspacePath: string): void {
  fs.mkdirSync(workspacePath, { recursive: true });
  fs.mkdirSync(path.join(workspacePath, "logs"), { recursive: true });

  fs.writeFileSync(path.join(workspacePath, "manifest.json"), "{}");
  fs.writeFileSync(path.join(workspacePath, "variables.env"), "APP_ENV=production");
  fs.writeFileSync(path.join(workspacePath, "VERSION"), "2.0.0");
  fs.writeFileSync(path.join(workspacePath, "STATUS"), "FAILED");

  // Log content that WILL match regex (port conflict)
  fs.writeFileSync(
    path.join(workspacePath, "logs", "service.log"),
    [
      "2024-01-15T10:00:00Z Starting web-app v2.0.0",
      "2024-01-15T10:00:01Z Initializing database connection",
      "2024-01-15T10:00:02Z Error: listen EADDRINUSE: address already in use port 8080",
      "2024-01-15T10:00:02Z [FATAL] Cannot bind to port 8080",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiagnosticInvestigator — LLM-Enhanced Log Scanning", () => {
  let tmpDir: string;
  let state: LocalStateStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    state = new LocalStateStore();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  // -----------------------------------------------------------------------
  // scanLogsAsync — LLM used when regex finds nothing
  // -----------------------------------------------------------------------

  it("uses LLM when regex finds nothing", async () => {
    const llmResponse: LlmResult = {
      ok: true,
      text: JSON.stringify([
        {
          logFile: "logs/service.log",
          failureType: "service-crash",
          detail: "Application failed to initialize config module — missing required REDIS_URL environment variable",
          line: "Config validation error: REDIS_URL is required but not set",
        },
      ]),
      model: "claude-haiku-4-5-20251001",
      responseTimeMs: 200,
    };

    const mockLlm = createMockLlm({
      isAvailable: true,
      classifyResult: llmResponse,
    });

    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    // Logs with no regex-matchable patterns
    setupCleanLogsWorkspace(workspacePath, [
      "2024-01-15T10:00:00Z Starting web-app v2.0.0",
      "2024-01-15T10:00:01Z Loading configuration from environment",
      "2024-01-15T10:00:02Z Config validation error: REDIS_URL is required but not set",
      "2024-01-15T10:00:02Z Shutting down due to configuration failure",
    ].join("\n"));

    const evidence: import("../src/agent/diagnostic-investigator.js").DiagnosticEvidence[] = [];
    const findings = await investigator.scanLogsAsync(workspacePath, evidence, instruction);

    // LLM should have been called
    expect(mockLlm.classifyCalls.length).toBe(1);
    expect(mockLlm.classifyCalls[0].promptSummary).toContain("Log pattern analysis");
    expect(mockLlm.classifyCalls[0].partitionId).toBe(instruction.partitionId);
    expect(mockLlm.classifyCalls[0].deploymentId).toBe(instruction.deploymentId);

    // Should have parsed LLM response into findings
    expect(findings.length).toBe(1);
    expect(findings[0].failureType).toBe("service-crash");
    expect(findings[0].detail).toContain("REDIS_URL");

    // Should have added LLM evidence
    const llmEvidence = evidence.find((e) => e.source === "llm-log-analysis");
    expect(llmEvidence).toBeDefined();
    expect(llmEvidence!.finding).toContain("1 pattern(s)");
  });

  // -----------------------------------------------------------------------
  // scanLogsAsync — skips LLM when regex has findings
  // -----------------------------------------------------------------------

  it("skips LLM when regex has findings", async () => {
    const mockLlm = createMockLlm({ isAvailable: true });
    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    // Logs that WILL match regex patterns
    setupRegexMatchWorkspace(workspacePath);

    const evidence: import("../src/agent/diagnostic-investigator.js").DiagnosticEvidence[] = [];
    const findings = await investigator.scanLogsAsync(workspacePath, evidence, instruction);

    // LLM should NOT have been called
    expect(mockLlm.classifyCalls.length).toBe(0);

    // Regex findings should still be present
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.failureType === "service-crash")).toBe(true);
  });

  // -----------------------------------------------------------------------
  // scanLogsAsync — fallback on LLM error
  // -----------------------------------------------------------------------

  it("falls back to empty findings on LLM error", async () => {
    const mockLlm = createMockLlm({
      isAvailable: true,
      classifyResult: { ok: false, fallback: true, reason: "LLM rate limit exceeded" },
    });

    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    setupCleanLogsWorkspace(workspacePath, [
      "2024-01-15T10:00:00Z Starting web-app v2.0.0",
      "2024-01-15T10:00:01Z Something went wrong but no regex matches",
    ].join("\n"));

    const evidence: import("../src/agent/diagnostic-investigator.js").DiagnosticEvidence[] = [];
    const findings = await investigator.scanLogsAsync(workspacePath, evidence, instruction);

    // LLM was called but failed
    expect(mockLlm.classifyCalls.length).toBe(1);

    // Should return empty findings (graceful fallback)
    expect(findings.length).toBe(0);

    // No LLM evidence should be added
    const llmEvidence = evidence.find((e) => e.source === "llm-log-analysis");
    expect(llmEvidence).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // scanLogsAsync — no LLM configured
  // -----------------------------------------------------------------------

  it("returns regex-only findings when no LLM is configured", async () => {
    const investigator = new DiagnosticInvestigator(state); // no LLM
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    setupCleanLogsWorkspace(workspacePath, [
      "2024-01-15T10:00:00Z Starting web-app v2.0.0",
      "2024-01-15T10:00:01Z Something went wrong but no regex matches",
    ].join("\n"));

    const evidence: import("../src/agent/diagnostic-investigator.js").DiagnosticEvidence[] = [];
    const findings = await investigator.scanLogsAsync(workspacePath, evidence, instruction);

    // No LLM means empty findings when regex finds nothing
    expect(findings.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // scanLogsAsync — LLM available but not configured (isAvailable=false)
  // -----------------------------------------------------------------------

  it("skips LLM call when LLM reports unavailable", async () => {
    const mockLlm = createMockLlm({ isAvailable: false });
    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    setupCleanLogsWorkspace(workspacePath, [
      "2024-01-15T10:00:00Z Starting web-app",
      "2024-01-15T10:00:01Z Unknown error occurred",
    ].join("\n"));

    const evidence: import("../src/agent/diagnostic-investigator.js").DiagnosticEvidence[] = [];
    const findings = await investigator.scanLogsAsync(workspacePath, evidence, instruction);

    expect(mockLlm.classifyCalls.length).toBe(0);
    expect(findings.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // scanLogsAsync — LLM returns invalid JSON
  // -----------------------------------------------------------------------

  it("falls back gracefully when LLM returns invalid JSON", async () => {
    const mockLlm = createMockLlm({
      isAvailable: true,
      classifyResult: {
        ok: true,
        text: "I found some issues but here is no valid JSON",
        model: "claude-haiku-4-5-20251001",
        responseTimeMs: 150,
      },
    });

    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    setupCleanLogsWorkspace(workspacePath, [
      "2024-01-15T10:00:00Z Starting web-app",
      "2024-01-15T10:00:01Z Some unusual error pattern",
    ].join("\n"));

    const evidence: import("../src/agent/diagnostic-investigator.js").DiagnosticEvidence[] = [];
    const findings = await investigator.scanLogsAsync(workspacePath, evidence, instruction);

    // LLM was called
    expect(mockLlm.classifyCalls.length).toBe(1);

    // But invalid response means empty findings
    expect(findings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildReportAsync tests
// ---------------------------------------------------------------------------

describe("DiagnosticInvestigator — LLM-Enhanced Report Generation", () => {
  let tmpDir: string;
  let state: LocalStateStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    state = new LocalStateStore();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  // -----------------------------------------------------------------------
  // buildReportAsync — sends evidence to LLM
  // -----------------------------------------------------------------------

  it("sends failure type and evidence to LLM for report generation", async () => {
    const llmReportResponse: LlmResult = {
      ok: true,
      text: JSON.stringify({
        summary: "web-app v2.0.0 crashed on production because REDIS_URL is not set in the environment variables.",
        rootCause:
          "The service configuration validation requires REDIS_URL but it was not included " +
          "in the deployment variables. The variable was likely removed in a recent configuration change.",
        recommendation:
          "Add REDIS_URL to the deployment variables: `REDIS_URL=redis://redis-prod.internal:6379/0`. " +
          "Verify the variable is set with `echo $REDIS_URL` after deployment.",
        traditionalComparison:
          "Traditional agent: 'Deployment failed. Service exited with non-zero status.' " +
          "No mention of the missing REDIS_URL variable or how to fix it.",
      }),
      model: "claude-sonnet-4-6",
      responseTimeMs: 800,
    };

    const mockLlm = createMockLlm({
      isAvailable: true,
      reasonResult: llmReportResponse,
    });

    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    setupCleanLogsWorkspace(workspacePath, [
      "2024-01-15T10:00:00Z Starting web-app v2.0.0",
      "2024-01-15T10:00:01Z Config validation error: REDIS_URL is required",
    ].join("\n"));

    const report = await investigator.investigateAsync(workspacePath, instruction);

    // LLM reason() should have been called for report generation
    expect(mockLlm.reasonCalls.length).toBe(1);
    expect(mockLlm.reasonCalls[0].promptSummary).toContain("Diagnostic report generation");
    expect(mockLlm.reasonCalls[0].partitionId).toBe(instruction.partitionId);
    expect(mockLlm.reasonCalls[0].deploymentId).toBe(instruction.deploymentId);

    // Report should contain LLM-generated content
    expect(report.summary).toContain("REDIS_URL");
    expect(report.recommendation).toContain("REDIS_URL");

    // Failure type and evidence should remain deterministic
    expect(typeof report.failureType).toBe("string");
    expect(Array.isArray(report.evidence)).toBe(true);
    expect(report.evidence.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // buildReportAsync — fallback on LLM error
  // -----------------------------------------------------------------------

  it("falls back to template report on LLM error", async () => {
    const mockLlm = createMockLlm({
      isAvailable: true,
      reasonResult: { ok: false, fallback: true, reason: "LLM call failed: network error" },
    });

    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    // Set up workspace with regex-matchable port conflict
    setupRegexMatchWorkspace(workspacePath);

    const report = await investigator.investigateAsync(workspacePath, instruction);

    // LLM was called for report but failed
    expect(mockLlm.reasonCalls.length).toBe(1);

    // Should fall back to deterministic template report
    expect(report.failureType).toBe("service-crash");
    expect(report.summary).toContain("web-app");
    expect(report.summary.toLowerCase()).toContain("port");
    expect(report.rootCause).toBeTruthy();
    expect(report.recommendation).toBeTruthy();
    expect(report.evidence.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // buildReportAsync — no LLM configured
  // -----------------------------------------------------------------------

  it("returns template report when no LLM configured", async () => {
    const investigator = new DiagnosticInvestigator(state); // no LLM
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    setupRegexMatchWorkspace(workspacePath);

    const report = await investigator.investigateAsync(workspacePath, instruction);

    // Report should be the deterministic template
    expect(report.failureType).toBe("service-crash");
    expect(report.summary).toContain("web-app");
    expect(report.evidence.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // buildReportAsync — LLM returns invalid JSON
  // -----------------------------------------------------------------------

  it("falls back to template report when LLM returns invalid JSON", async () => {
    const mockLlm = createMockLlm({
      isAvailable: true,
      reasonResult: {
        ok: true,
        text: "Here is my analysis of the failure... (no JSON)",
        model: "claude-sonnet-4-6",
        responseTimeMs: 500,
      },
    });

    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    setupRegexMatchWorkspace(workspacePath);

    const report = await investigator.investigateAsync(workspacePath, instruction);

    // LLM was called
    expect(mockLlm.reasonCalls.length).toBe(1);

    // Should fall back to template report
    expect(report.failureType).toBe("service-crash");
    expect(report.summary).toContain("web-app");
  });

  // -----------------------------------------------------------------------
  // Classification stays deterministic
  // -----------------------------------------------------------------------

  it("classification remains deterministic regardless of LLM", async () => {
    const mockLlm = createMockLlm({
      isAvailable: true,
      reasonResult: {
        ok: true,
        text: JSON.stringify({
          summary: "LLM says this is a dependency issue",
          rootCause: "LLM root cause",
          recommendation: "LLM recommendation",
          traditionalComparison: "LLM comparison",
        }),
        model: "claude-sonnet-4-6",
        responseTimeMs: 400,
      },
    });

    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    // Set up a service-crash scenario (port conflict)
    setupRegexMatchWorkspace(workspacePath);

    const report = await investigator.investigateAsync(workspacePath, instruction);

    // Even though LLM might suggest differently, failureType is deterministic
    expect(report.failureType).toBe("service-crash");
  });

  // -----------------------------------------------------------------------
  // Evidence collection stays deterministic
  // -----------------------------------------------------------------------

  it("evidence collection remains deterministic regardless of LLM", async () => {
    const mockLlm = createMockLlm({
      isAvailable: true,
      reasonResult: {
        ok: true,
        text: JSON.stringify({
          summary: "LLM summary",
          rootCause: "LLM root cause",
          recommendation: "LLM recommendation",
          traditionalComparison: "LLM comparison",
        }),
        model: "claude-sonnet-4-6",
        responseTimeMs: 400,
      },
    });

    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const investigatorNoLlm = new DiagnosticInvestigator(state);
    const instruction = makeInstruction();

    // Create two identical workspaces
    const workspace1 = path.join(tmpDir, "workspace1");
    const workspace2 = path.join(tmpDir, "workspace2");
    setupRegexMatchWorkspace(workspace1);
    setupRegexMatchWorkspace(workspace2);

    const reportWithLlm = await investigator.investigateAsync(workspace1, instruction);
    const reportWithoutLlm = investigatorNoLlm.investigate(workspace2, instruction);

    // Evidence should be the same regardless of LLM
    expect(reportWithLlm.evidence.length).toBe(reportWithoutLlm.evidence.length);
    for (let i = 0; i < reportWithLlm.evidence.length; i++) {
      expect(reportWithLlm.evidence[i].source).toBe(reportWithoutLlm.evidence[i].source);
      expect(reportWithLlm.evidence[i].finding).toBe(reportWithoutLlm.evidence[i].finding);
    }
  });
});

// ---------------------------------------------------------------------------
// Existing deterministic behavior preserved
// ---------------------------------------------------------------------------

describe("DiagnosticInvestigator — Existing Behavior Preserved", () => {
  let tmpDir: string;
  let state: LocalStateStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    state = new LocalStateStore();
  });

  afterEach(() => {
    cleanDir(tmpDir);
  });

  it("investigate() still works as pure deterministic fallback", () => {
    const investigator = new DiagnosticInvestigator(state);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    setupRegexMatchWorkspace(workspacePath);

    // Synchronous investigate() should work unchanged
    const report = investigator.investigate(workspacePath, instruction);

    expect(report.failureType).toBe("service-crash");
    expect(report.summary).toContain("web-app");
    expect(report.evidence.length).toBeGreaterThan(0);
    expect(report.recommendation).toBeTruthy();
    expect(report.rootCause).toBeTruthy();
  });

  it("investigate() works with LLM constructor arg but stays synchronous", () => {
    const mockLlm = createMockLlm({ isAvailable: true });
    const investigator = new DiagnosticInvestigator(state, mockLlm);
    const instruction = makeInstruction();
    const workspacePath = path.join(tmpDir, "workspace");

    setupRegexMatchWorkspace(workspacePath);

    // Synchronous method should not call LLM
    const report = investigator.investigate(workspacePath, instruction);

    expect(mockLlm.classifyCalls.length).toBe(0);
    expect(mockLlm.reasonCalls.length).toBe(0);
    expect(report.failureType).toBe("service-crash");
  });
});
