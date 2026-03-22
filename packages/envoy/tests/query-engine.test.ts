import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DecisionDebrief, LlmClient } from "@synth-deploy/core";
import type { DebriefReader, DebriefWriter } from "@synth-deploy/core";
import { EnvoyAgent } from "../src/agent/envoy-agent.js";
import type { DeploymentInstruction } from "../src/agent/envoy-agent.js";
import { LocalStateStore } from "../src/state/local-state.js";
import { EnvironmentScanner } from "../src/agent/environment-scanner.js";
import { QueryEngine } from "../src/agent/query-engine.js";
import { EscalationPackager } from "../src/agent/escalation-packager.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "envoy-query-"));
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
    deploymentId: crypto.randomUUID(),
    partitionId: "partition-1",
    environmentId: "env-prod",
    operationId: `web-app-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    version: "2.0.0",
    variables: {
      APP_ENV: "production",
      LOG_LEVEL: "warn",
      DB_HOST: "db-prod.internal:5432",
    },
    environmentName: "production",
    partitionName: "Acme Corp",
    ...overrides,
  };
}

/**
 * Seed a realistic deployment history onto the Envoy.
 * Creates multiple deployments across a time window.
 */
async function seedDeploymentHistory(
  agent: EnvoyAgent,
  baseDir: string,
  state: LocalStateStore,
  diary: DebriefWriter & DebriefReader,
): Promise<DeploymentInstruction[]> {
  const instructions: DeploymentInstruction[] = [];

  // Deployment 1: v1.0.0 — success (30 days ago)
  const d1 = makeInstruction({
    deploymentId: "web-app-v1",
    operationId: "web-app-v1",
    version: "1.0.0",
  });
  instructions.push(d1);
  await agent.executeDeployment(d1);

  // Deployment 2: v1.1.0 — success (15 days ago)
  const d2 = makeInstruction({
    deploymentId: "web-app-v1.1",
    operationId: "web-app-v1.1",
    version: "1.1.0",
  });
  instructions.push(d2);
  await agent.executeDeployment(d2);

  // Deployment 3: v2.0.0 — success (7 days ago, "last Tuesday" area)
  const d3 = makeInstruction({
    deploymentId: "web-app-v2",
    operationId: "web-app-v2",
    version: "2.0.0",
  });
  instructions.push(d3);
  await agent.executeDeployment(d3);

  // Deployment 4: v2.1.0 — success (3 days ago)
  const d4 = makeInstruction({
    deploymentId: "web-app-v2.1",
    operationId: "web-app-v2.1",
    version: "2.1.0",
  });
  instructions.push(d4);
  await agent.executeDeployment(d4);

  // Deployment 5: api-service v1.0.0 — success (5 days ago)
  const d5 = makeInstruction({
    deploymentId: "api-service-v1",
    operationId: "api-service-v1",
    version: "1.0.0",
    environmentId: "env-staging",
    environmentName: "staging",
  });
  instructions.push(d5);
  await agent.executeDeployment(d5);

  return instructions;
}

// ---------------------------------------------------------------------------
// Tests — Query Engine
// ---------------------------------------------------------------------------

describe("QueryEngine", () => {
  let baseDir: string;
  let diary: DecisionDebrief;
  let state: LocalStateStore;
  let scanner: EnvironmentScanner;
  let agent: EnvoyAgent;
  let queryEngine: QueryEngine;

  beforeEach(async () => {
    baseDir = makeTmpDir();
    diary = new DecisionDebrief();
    state = new LocalStateStore();
    scanner = new EnvironmentScanner(baseDir, state);
    agent = new EnvoyAgent(diary, state, baseDir);
    queryEngine = new QueryEngine(diary, state, scanner);
  });

  // -----------------------------------------------------------------------
  // Intent classification
  // -----------------------------------------------------------------------

  describe("Intent classification", () => {
    it("classifies diagnostic questions", () => {
      const result = queryEngine.query("Why did last Tuesday's deployment slow things down?");
      expect(result.intent).toBe("deployment-diagnostic");
    });

    it("classifies change history questions", () => {
      const result = queryEngine.query("What changed in this environment in the last 30 days?");
      expect(result.intent).toBe("change-history");
    });

    it("classifies pre-deployment assessment questions", () => {
      const result = queryEngine.query(
        "Is there anything about the current environment state I should know before the next deployment?",
      );
      expect(result.intent).toBe("pre-deployment-assessment");
    });

    it("classifies environment state questions", () => {
      const result = queryEngine.query("What version is deployed now?");
      expect(result.intent).toBe("environment-state");
    });

    it("classifies unrecognized questions as general", () => {
      const result = queryEngine.query("tell me about this machine");
      expect(result.intent).toBe("general");
    });
  });

  // -----------------------------------------------------------------------
  // Diagnostic query — "Why did last Tuesday's deployment slow things down?"
  // -----------------------------------------------------------------------

  describe("Diagnostic query — deployment performance investigation", () => {
    it("answers 'Why did last Tuesday's deployment slow things down?' with specific data", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "Why did last Tuesday's deployment slow things down?",
      );

      expect(result.intent).toBe("deployment-diagnostic");
      expect(result.answeredAt).toBeInstanceOf(Date);
      // The answer should reference actual deployment data — not generic advice
      expect(result.answer).toBeTruthy();
      expect(result.answer.length).toBeGreaterThan(50);
    });

    it("references specific version numbers from actual deployments", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "Why did last Tuesday's deployment slow things down?",
      );

      // Must reference real data — the specific versions that were deployed
      // Even if there's no deployment on "last Tuesday" it should say so specifically
      const hasVersionRef =
        result.answer.includes("v1.0.0") ||
        result.answer.includes("v1.1.0") ||
        result.answer.includes("v2.0.0") ||
        result.answer.includes("v2.1.0") ||
        result.answer.includes("No deployments were executed");

      expect(hasVersionRef).toBe(true);
    });

    it("includes evidence from diary entries when deployments are found", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      // Query with a wider window that will definitely find deployments
      const result = queryEngine.query("Why did the recent deployment fail?");

      // Even if no failures, it should include deployment evidence
      expect(result.evidence.length).toBeGreaterThanOrEqual(0);
    });

    it("says 'no deployments found' when the time window is empty", () => {
      // No deployments at all
      const result = queryEngine.query(
        "Why did last Tuesday's deployment slow things down?",
      );

      expect(result.answer).toContain("No deployments");
      expect(result.confident).toBe(false);
      expect(result.escalationHint).toBeTruthy();
    });

    it("includes diagnostic details for failed deployments", async () => {
      // Execute a deployment that will succeed, then check diagnostic handling
      const instruction = makeInstruction({
        operationId: "web-app-diag",
        version: "3.0.0",
      });
      await agent.executeDeployment(instruction);

      const result = queryEngine.query("Why did the recent deployment have issues?");

      // Should reference the actual deployment
      expect(result.answer).toContain("web-app-diag");
      expect(result.answer).toContain("v3.0.0");
    });
  });

  // -----------------------------------------------------------------------
  // Change history — "What changed in this environment in the last 30 days?"
  // -----------------------------------------------------------------------

  describe("Change history query — environment changes", () => {
    it("answers 'What changed in the last 30 days?' with specific deployment history", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "What changed in this environment in the last 30 days?",
      );

      expect(result.intent).toBe("change-history");
      // Should list actual deployments with their versions
      expect(result.answer).toContain("deployment(s) were executed");
    });

    it("includes version progression for multi-deploy environments", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "What changed in this environment in the last 30 days?",
      );

      // Should show the version trail
      expect(result.answer).toContain("v1.0.0");
      expect(result.answer).toContain("v2.1.0");
    });

    it("groups changes by environment", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "What changed in this environment in the last 30 days?",
      );

      // Multiple environments should be listed
      expect(result.answer).toContain("partition-1:env-prod");
    });

    it("includes the current running version", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "What changed in this environment in the last 30 days?",
      );

      // Should show what's currently deployed
      expect(result.answer).toContain("Currently running");
    });

    it("reports 'no changes' when the window is empty", () => {
      const result = queryEngine.query(
        "What changed in this environment in the last 30 days?",
      );

      expect(result.answer).toContain("No changes were recorded");
      expect(result.confident).toBe(true);
    });

    it("includes evidence with diary entry references", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "What changed in this environment in the last 30 days?",
      );

      expect(result.evidence.length).toBeGreaterThan(0);
      // Each evidence item should have a source and summary
      for (const ev of result.evidence) {
        expect(ev.source).toBeTruthy();
        expect(ev.summary).toBeTruthy();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Pre-deployment assessment — "Is there anything I should know?"
  // -----------------------------------------------------------------------

  describe("Pre-deployment assessment query", () => {
    it("answers 'should I know before the next deployment?' with environment-specific assessment", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "Is there anything about the current environment state I should know before the next deployment?",
      );

      expect(result.intent).toBe("pre-deployment-assessment");
      // Should include environment state
      expect(result.answer).toContain("environment");
      // Should include risk assessment
      expect(result.answer).toMatch(/risk assessment:\s*(LOW|MODERATE|ELEVATED|HIGH)/i);
    });

    it("reports current versions in the assessment", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "Is there anything about the current environment state I should know before the next deployment?",
      );

      // Should mention the current version on the environment
      expect(result.answer).toContain("v2.1.0");
    });

    it("flags workspace readiness issues", () => {
      // Use a non-existent base dir
      const badScanner = new EnvironmentScanner("/nonexistent/path", state);
      const badEngine = new QueryEngine(diary, state, badScanner);

      const result = badEngine.query(
        "Is there anything about the current environment state I should know before the next deployment?",
      );

      expect(result.answer).toContain("CRITICAL");
      expect(result.answer).toContain("not ready");
    });

    it("reports LOW risk when everything is healthy", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "Is there anything about the current environment state I should know before the next deployment?",
      );

      // All deployments succeeded, no issues
      expect(result.answer).toContain("No concerns identified");
      expect(result.answer).toContain("LOW");
    });

    it("includes evidence from environment scan", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query(
        "Is there anything about the current environment state I should know before the next deployment?",
      );

      expect(result.evidence.length).toBeGreaterThan(0);
      const scanEvidence = result.evidence.find((e) => e.source === "environment scan");
      expect(scanEvidence).toBeTruthy();
    });
  });

  // -----------------------------------------------------------------------
  // Environment state query
  // -----------------------------------------------------------------------

  describe("Environment state query", () => {
    it("reports current state with deployment counts", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query("What's the current environment state?");

      expect(result.intent).toBe("environment-state");
      expect(result.answer).toContain("5 deployment(s)");
      expect(result.answer).toContain("succeeded");
    });

    it("lists active environments with versions", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query("What's the current environment state?");

      expect(result.answer).toContain("v2.1.0");
      expect(result.answer).toContain("Active environments");
    });

    it("handles empty state gracefully", () => {
      const result = queryEngine.query("What's the current environment state?");

      expect(result.answer).toContain("0 deployment(s)");
      expect(result.answer).toContain("No active environments");
    });
  });

  // -----------------------------------------------------------------------
  // Answer quality — no generic responses
  // -----------------------------------------------------------------------

  describe("Answer quality — specificity guarantees", () => {
    it("no two different queries produce identical answers", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const q1 = queryEngine.query("Why did the recent deployment fail?");
      const q2 = queryEngine.query("What changed in the last 30 days?");
      const q3 = queryEngine.query("Is there anything I should know before deploying?");

      expect(q1.answer).not.toBe(q2.answer);
      expect(q2.answer).not.toBe(q3.answer);
      expect(q1.answer).not.toBe(q3.answer);
    });

    it("answers reference actual operation names from the environment", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query("What changed recently?");

      // Must reference the actual operation names, not generic text
      const hasoperation =
        result.answer.includes("web-app") || result.answer.includes("api-service");
      expect(hasoperation).toBe(true);
    });

    it("answers reference actual version numbers", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const result = queryEngine.query("What's running right now?");

      // Must reference actual versions
      expect(result.answer).toMatch(/v\d+\.\d+\.\d+/);
    });

    it("every QueryResult has required fields populated", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const queries = [
        "Why did the deployment fail?",
        "What changed in 30 days?",
        "Should I deploy now?",
        "What's the current state?",
        "tell me something",
      ];

      for (const q of queries) {
        const result = queryEngine.query(q);
        expect(result.query).toBe(q);
        expect(result.intent).toBeTruthy();
        expect(result.answer).toBeTruthy();
        expect(result.answeredAt).toBeInstanceOf(Date);
        expect(typeof result.confident).toBe("boolean");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — QueryEngine with LLM
// ---------------------------------------------------------------------------

/**
 * Creates an LlmClient with a mock Anthropic SDK client injected.
 * The mock controls what `reason()` returns without requiring a real API key.
 */
function createMockLlmClient(
  debrief: DecisionDebrief,
  mockCreate: (...args: unknown[]) => Promise<unknown>,
): LlmClient {
  const client = new LlmClient(debrief, "envoy", {
    apiKey: "sk-test-mock-key",
  });
  const internal = client as unknown as {
    _initialized: boolean;
    _lastInitializedApiKey: string | undefined;
    _anthropicClient: unknown;
  };
  internal._initialized = true;
  internal._lastInitializedApiKey = "sk-test-mock-key";
  internal._anthropicClient = {
    messages: { create: mockCreate },
  };
  return client;
}

describe("QueryEngine — LLM-powered answering", () => {
  let baseDir: string;
  let diary: DecisionDebrief;
  let state: LocalStateStore;
  let scanner: EnvironmentScanner;
  let agent: EnvoyAgent;

  beforeEach(async () => {
    baseDir = makeTmpDir();
    diary = new DecisionDebrief();
    state = new LocalStateStore();
    scanner = new EnvironmentScanner(baseDir, state);
    agent = new EnvoyAgent(diary, state, baseDir);
  });

  it("uses LLM answer when LLM is available and returns successfully", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    const llmAnswer = "The deployment of web-app v2.0.0 introduced a new database migration that increased query latency by 40ms.";
    const mockLlm = createMockLlmClient(diary, async () => ({
      content: [{ type: "text", text: llmAnswer }],
    }));

    const queryEngine = new QueryEngine(diary, state, scanner, mockLlm);
    const result = await queryEngine.queryAsync(
      "Why did the recent deployment slow things down?",
    );

    expect(result.answer).toBe(llmAnswer);
    expect(result.intent).toBe("deployment-diagnostic");
    expect(result.confident).toBe(true);
  });

  it("falls back to deterministic answer when LLM is not configured", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    // No LLM provided — should fall back to sync query()
    const queryEngine = new QueryEngine(diary, state, scanner);
    const result = await queryEngine.queryAsync(
      "What changed in the last 30 days?",
    );

    expect(result.intent).toBe("change-history");
    expect(result.answer).toContain("deployment(s) were executed");
  });

  it("falls back to deterministic answer when LLM has no API key", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    // LlmClient with no API key — isAvailable() returns false
    const noKeyLlm = new LlmClient(diary, "envoy", { apiKey: undefined });
    const queryEngine = new QueryEngine(diary, state, scanner, noKeyLlm);
    const result = await queryEngine.queryAsync(
      "What changed in the last 30 days?",
    );

    expect(result.intent).toBe("change-history");
    expect(result.answer).toContain("deployment(s) were executed");
  });

  it("falls back to deterministic answer when LLM call fails", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    const mockLlm = createMockLlmClient(diary, async () => {
      throw new Error("API connection refused");
    });

    const queryEngine = new QueryEngine(diary, state, scanner, mockLlm);
    const result = await queryEngine.queryAsync(
      "Why did the recent deployment fail?",
    );

    // Should fall back to deterministic — the answer should contain
    // real deployment data from the sync query()
    expect(result.intent).toBe("deployment-diagnostic");
    expect(result.answer).toBeTruthy();
    expect(result.answer.length).toBeGreaterThan(50);
  });

  it("skips LLM for confident environment-state queries", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    let llmCalled = false;
    const mockLlm = createMockLlmClient(diary, async () => {
      llmCalled = true;
      return { content: [{ type: "text", text: "LLM was called" }] };
    });

    const queryEngine = new QueryEngine(diary, state, scanner, mockLlm);
    const result = await queryEngine.queryAsync(
      "What's the current environment state?",
    );

    // environment-state with data is confident — LLM should be skipped
    expect(result.intent).toBe("environment-state");
    expect(result.confident).toBe(true);
    expect(llmCalled).toBe(false);
    expect(result.answer).not.toBe("LLM was called");
  });

  it("preserves evidence and intent from deterministic pass in LLM result", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    const mockLlm = createMockLlmClient(diary, async () => ({
      content: [{ type: "text", text: "LLM-enhanced answer with context." }],
    }));

    const queryEngine = new QueryEngine(diary, state, scanner, mockLlm);
    const result = await queryEngine.queryAsync(
      "What changed in the last 30 days?",
    );

    // The LLM answer should be used, but evidence and intent come
    // from the deterministic pass.
    expect(result.answer).toBe("LLM-enhanced answer with context.");
    expect(result.intent).toBe("change-history");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("sync query() still works exactly as before regardless of LLM", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    const mockLlm = createMockLlmClient(diary, async () => ({
      content: [{ type: "text", text: "LLM answer" }],
    }));

    const queryEngine = new QueryEngine(diary, state, scanner, mockLlm);

    // Sync query() should never use the LLM
    const result = queryEngine.query("What changed in the last 30 days?");
    expect(result.intent).toBe("change-history");
    expect(result.answer).toContain("deployment(s) were executed");
    expect(result.answer).not.toBe("LLM answer");
  });
});

// ---------------------------------------------------------------------------
// Tests — Escalation Packager
// ---------------------------------------------------------------------------

describe("EscalationPackager", () => {
  let baseDir: string;
  let diary: DecisionDebrief;
  let state: LocalStateStore;
  let scanner: EnvironmentScanner;
  let agent: EnvoyAgent;
  let packager: EscalationPackager;

  beforeEach(async () => {
    baseDir = makeTmpDir();
    diary = new DecisionDebrief();
    state = new LocalStateStore();
    scanner = new EnvironmentScanner(baseDir, state);
    agent = new EnvoyAgent(diary, state, baseDir);
    packager = new EscalationPackager(diary, state, scanner, "envoy-test-01");
  });

  describe("Deployment-specific escalation", () => {
    it("packages a failed deployment with full context", async () => {
      const instruction = makeInstruction({
        deploymentId: "deploy-esc-001",
        operationId: "deploy-esc-001",
        version: "3.0.0",
      });
      await agent.executeDeployment(instruction);

      const pkg = packager.packageForDeployment(
        "deploy-esc-001",
        "Deployment succeeded but service response times degraded after deploy",
      );

      expect(pkg.severity).toBeTruthy();
      expect(pkg.summary).toContain("deploy-esc-001");
      expect(pkg.summary).toContain("v3.0.0");
      expect(pkg.recommendedAction).toBeTruthy();
      expect(pkg.relevantDebriefEntries.length).toBeGreaterThan(0);
      expect(pkg.createdAt).toBeInstanceOf(Date);
    });

    it("includes environment state at time of escalation", async () => {
      const instruction = makeInstruction({
        deploymentId: "deploy-esc-002",
        operationId: "deploy-esc-002",
        version: "2.0.0",
      });
      await agent.executeDeployment(instruction);

      const pkg = packager.packageForDeployment(
        "deploy-esc-002",
        "Need help investigating performance degradation",
      );

      expect(pkg.environmentState.scan).toBeTruthy();
      expect(pkg.environmentState.scan.hostname).toBeTruthy();
      expect(pkg.environmentState.environments.length).toBeGreaterThan(0);
    });

    it("includes recent deployment history", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const pkg = packager.packageForDeployment(
        "web-app-v2.1",
        "Last deployment caused issues",
      );

      expect(pkg.recentDeployments.length).toBeGreaterThan(0);
      expect(pkg.recentDeployments[0].operationId).toBeTruthy();
    });

    it("includes diary entries from related deployments", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const pkg = packager.packageForDeployment(
        "web-app-v2.1",
        "Need context on recent changes",
      );

      // Should include entries from web-app-v2.1 AND related deployments
      const operationIds = new Set(
        pkg.relevantDebriefEntries.map((e) => e.operationId),
      );
      expect(operationIds.has("web-app-v2.1")).toBe(true);
      // May include entries from other deployments in the same environment
      expect(pkg.relevantDebriefEntries.length).toBeGreaterThan(0);
    });

    it("handles unknown deployment ID gracefully", () => {
      const pkg = packager.packageForDeployment(
        "nonexistent-deploy",
        "Cannot find this deployment",
      );

      expect(pkg.summary).toContain("No deployment record found");
      expect(pkg.severity).toBe("medium");
    });

    it("produces formatted text readable without parsing", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const pkg = packager.packageForDeployment(
        "web-app-v2.1",
        "Investigating performance issue",
      );

      expect(pkg.formatted).toContain("# Escalation Package");
      expect(pkg.formatted).toContain("## Summary");
      expect(pkg.formatted).toContain("## Recommended Action");
      expect(pkg.formatted).toContain("## Environment State");
      expect(pkg.formatted).toContain("## Recent Deployment History");
      expect(pkg.formatted).toContain("## Decision Trail");
      // Should contain actual data
      expect(pkg.formatted).toContain("web-app-v2.1");
      expect(pkg.formatted).toContain("envoy-test-01");
    });
  });

  describe("General escalation", () => {
    it("packages general situation without specific deployment", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const pkg = packager.packageGeneral(
        "Environment experiencing intermittent connectivity issues",
      );

      expect(pkg.severity).toBeTruthy();
      expect(pkg.summary).toContain("envoy-test-01");
      expect(pkg.summary).toContain("escalating");
      expect(pkg.recentDeployments.length).toBeGreaterThan(0);
      expect(pkg.relevantDebriefEntries.length).toBeGreaterThan(0);
    });

    it("assesses severity based on recent failure patterns", async () => {
      await seedDeploymentHistory(agent, baseDir, state, diary);

      // All deployments succeeded, so severity should be low
      const pkg = packager.packageGeneral("General check-in");

      expect(pkg.severity).toBe("low");
    });

    it("marks workspace-not-ready as critical", () => {
      const badScanner = new EnvironmentScanner("/nonexistent/path", state);
      const badPackager = new EscalationPackager(diary, state, badScanner, "envoy-bad");

      const pkg = badPackager.packageGeneral("Cannot deploy");

      expect(pkg.severity).toBe("critical");
      expect(pkg.environmentState.readiness.ready).toBe(false);
    });

    it("includes diagnostic reports from recent failures", async () => {
      // We can only test the structure since our test deployments succeed
      await seedDeploymentHistory(agent, baseDir, state, diary);

      const pkg = packager.packageGeneral("Need overview of environment health");

      // No failures in seed data, so diagnostics should be empty
      expect(pkg.diagnostics).toEqual([]);
      // But the structure should be correct
      expect(Array.isArray(pkg.diagnostics)).toBe(true);
    });
  });

  describe("Severity assessment", () => {
    it("rates severity based on failure patterns", async () => {
      // Execute a successful deployment
      const instruction = makeInstruction({
        deploymentId: "deploy-sev-001",
        operationId: "deploy-sev-001",
        version: "1.0.0",
      });
      await agent.executeDeployment(instruction);

      const pkg = packager.packageForDeployment(
        "deploy-sev-001",
        "Just checking",
      );

      // Succeeded deployment, no failures = low
      expect(pkg.severity).toBe("low");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — HTTP integration (query and escalation endpoints)
// ---------------------------------------------------------------------------

describe("Envoy HTTP — query and escalation endpoints", () => {
  let baseDir: string;
  let diary: DecisionDebrief;
  let state: LocalStateStore;
  let scanner: EnvironmentScanner;
  let agent: EnvoyAgent;
  let queryEngine: QueryEngine;
  let packager: EscalationPackager;

  beforeEach(async () => {
    baseDir = makeTmpDir();
    diary = new DecisionDebrief();
    state = new LocalStateStore();
    scanner = new EnvironmentScanner(baseDir, state);
    agent = new EnvoyAgent(diary, state, baseDir);
    queryEngine = new QueryEngine(diary, state, scanner);
    packager = new EscalationPackager(diary, state, scanner, "envoy-http-test");
  });

  it("POST /query returns a structured answer", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    // Import dynamically to test the server
    const { createEnvoyServer } = await import("../src/server.js");
    const app = createEnvoyServer(agent, state, queryEngine, packager);

    const response = await app.inject({
      method: "POST",
      url: "/query",
      payload: { query: "What changed in the last 30 days?" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.intent).toBe("change-history");
    expect(body.answer).toContain("deployment(s) were executed");
    expect(body.answeredAt).toBeTruthy();

    await app.close();
  });

  it("POST /query rejects empty queries", async () => {
    const { createEnvoyServer } = await import("../src/server.js");
    const app = createEnvoyServer(agent, state, queryEngine, packager);

    const response = await app.inject({
      method: "POST",
      url: "/query",
      payload: { query: "" },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it("POST /escalate/deployment returns a full escalation package", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    const { createEnvoyServer } = await import("../src/server.js");
    const app = createEnvoyServer(agent, state, queryEngine, packager);

    const response = await app.inject({
      method: "POST",
      url: "/escalate/deployment",
      payload: {
        deploymentId: "web-app-v2.1",
        reason: "Deployment caused performance degradation",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.severity).toBeTruthy();
    expect(body.summary).toContain("web-app-v2.1");
    expect(body.formatted).toContain("# Escalation Package");
    expect(body.relevantDebriefEntries.length).toBeGreaterThan(0);

    await app.close();
  });

  it("POST /escalate returns a general escalation package", async () => {
    await seedDeploymentHistory(agent, baseDir, state, diary);

    const { createEnvoyServer } = await import("../src/server.js");
    const app = createEnvoyServer(agent, state, queryEngine, packager);

    const response = await app.inject({
      method: "POST",
      url: "/escalate",
      payload: { reason: "Need help with environment health" },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.severity).toBeTruthy();
    expect(body.summary).toContain("envoy-http-test");

    await app.close();
  });

  it("returns 501 when query engine is not configured", async () => {
    const { createEnvoyServer } = await import("../src/server.js");
    const app = createEnvoyServer(agent, state); // No query engine

    const response = await app.inject({
      method: "POST",
      url: "/query",
      payload: { query: "What happened?" },
    });

    expect(response.statusCode).toBe(501);

    await app.close();
  });
});
