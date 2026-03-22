import { describe, it, expect, vi } from "vitest";
import type { DebriefEntry, Deployment } from "../src/types.js";
import type { LlmClient, LlmCallParams, LlmResult } from "../src/llm-client.js";
import {
  generatePostmortem,
  generatePostmortemAsync,
  buildPostmortemPrompt,
  parseLlmPostmortemResponse,
  POSTMORTEM_SYSTEM_PROMPT,
} from "../src/debrief-reader.js";
import type { LlmPostmortem } from "../src/debrief-reader.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "deploy-1",
    operationId: "op-1",
    partitionId: "partition-1",
    environmentId: "env-staging",
    version: "1.2.3",
    status: "failed",
    variables: { APP_PORT: "3000" },
    debriefEntryIds: ["entry-1", "entry-2", "entry-3"],
    orderId: null,
    createdAt: new Date("2026-03-01T10:00:00Z"),
    completedAt: new Date("2026-03-01T10:05:00Z"),
    failureReason: "Health check failed after deployment",
    ...overrides,
  };
}

function makeEntries(): DebriefEntry[] {
  return [
    {
      id: "entry-1",
      timestamp: new Date("2026-03-01T10:00:00Z"),
      partitionId: "partition-1",
      operationId: "deploy-1",
      agent: "command",
      decisionType: "pipeline-plan",
      decision: "Deploy op-1 v1.2.3 to staging for partition-1",
      reasoning: "Deployment triggered by operator. All preconditions met.",
      context: {
        operationId: "op-1",
        version: "1.2.3",
        environmentName: "staging",
        partitionName: "partition-1",
      },
    },
    {
      id: "entry-2",
      timestamp: new Date("2026-03-01T10:01:00Z"),
      partitionId: "partition-1",
      operationId: "deploy-1",
      agent: "command",
      decisionType: "configuration-resolved",
      decision: "Resolved 5 variables with 0 conflicts",
      reasoning: "All variables resolved without conflicts.",
      context: { variableCount: 5, conflictCount: 0 },
    },
    {
      id: "entry-3",
      timestamp: new Date("2026-03-01T10:03:00Z"),
      partitionId: "partition-1",
      operationId: "deploy-1",
      agent: "command",
      decisionType: "deployment-failure",
      decision: "Deployment failed: health check returned 503 after 3 retries",
      reasoning:
        "The target service returned HTTP 503 on all health check attempts. " +
        "Recommended action: Verify the application is binding to the correct port and dependencies are reachable.",
      context: { step: "preflight-health-check", errorCategory: "service-unavailable" },
    },
  ];
}

function makeSuccessEntries(): DebriefEntry[] {
  return [
    {
      id: "entry-s1",
      timestamp: new Date("2026-03-01T10:00:00Z"),
      partitionId: "partition-1",
      operationId: "deploy-s1",
      agent: "command",
      decisionType: "pipeline-plan",
      decision: "Deploy op-1 v2.0.0 to production",
      reasoning: "Deployment triggered by CI pipeline.",
      context: {
        operationId: "op-1",
        version: "2.0.0",
        environmentName: "production",
        partitionName: "partition-1",
      },
    },
    {
      id: "entry-s2",
      timestamp: new Date("2026-03-01T10:02:00Z"),
      partitionId: "partition-1",
      operationId: "deploy-s1",
      agent: "command",
      decisionType: "deployment-completion",
      decision: "Deployment completed successfully",
      reasoning: "All steps passed. Service healthy after deploy.",
      context: {},
    },
  ];
}

function makeLlmPostmortemJson(): string {
  const postmortem: LlmPostmortem = {
    executiveSummary:
      "Deployment of op-1 v1.2.3 to staging failed because the target service " +
      "returned HTTP 503 on all health check attempts. The root cause was the " +
      "application failing to bind to the configured port.",
    timeline: [
      {
        timestamp: "2026-03-01T10:00:00Z",
        event: "Deployment triggered",
        significance: "Initial deployment trigger; all preconditions met",
      },
      {
        timestamp: "2026-03-01T10:01:00Z",
        event: "Configuration resolved",
        significance: "5 variables resolved without conflicts — no config issues",
      },
      {
        timestamp: "2026-03-01T10:03:00Z",
        event: "Health check failed with HTTP 503",
        significance: "Critical failure — the service was not responding after deployment",
      },
    ],
    rootCause:
      "The application failed to bind to port 3000 in the staging environment, " +
      "causing all health check probes to return 503.",
    contributingFactors: [
      "Port binding issue in the application startup",
      "No pre-deployment connectivity validation",
    ],
    remediationSteps: [
      "Verify APP_PORT variable matches the port the application actually binds to",
      "Check staging environment firewall rules for port 3000",
      "Add a startup readiness probe before the health check runs",
    ],
    lessonsLearned: [
      "Health check failures after deploy often indicate port or network config issues",
      "Pre-deployment checks should validate the target port is accessible",
    ],
  };
  return JSON.stringify(postmortem);
}

/**
 * Create a mock LlmClient that returns a controlled response.
 */
function createMockLlm(
  overrides: {
    isAvailable?: boolean;
    reasonResult?: LlmResult;
    reasonSpy?: ReturnType<typeof vi.fn>;
  } = {},
): LlmClient {
  const defaultResult: LlmResult = {
    ok: true,
    text: makeLlmPostmortemJson(),
    model: "claude-sonnet-4-6",
    responseTimeMs: 1200,
  };

  const reasonSpy =
    overrides.reasonSpy ??
    vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockResolvedValue(
      overrides.reasonResult ?? defaultResult,
    );

  return {
    isAvailable: () => overrides.isAvailable ?? true,
    reason: reasonSpy,
    classify: vi.fn(),
  } as unknown as LlmClient;
}

// ---------------------------------------------------------------------------
// Existing heuristic generatePostmortem — sanity checks
// ---------------------------------------------------------------------------

describe("generatePostmortem — heuristic (existing)", () => {
  it("produces a report from debrief entries and deployment", () => {
    const report = generatePostmortem(makeEntries(), makeDeployment());
    expect(report.summary).toContain("v1.2.3");
    expect(report.summary).toContain("FAILED");
    expect(report.timeline).toHaveLength(3);
    expect(report.failureAnalysis).not.toBeNull();
    expect(report.failureAnalysis!.failedStep).toBe("preflight-health-check");
    expect(report.formatted.length).toBeGreaterThan(0);
  });

  it("produces a report for successful deployments", () => {
    const deployment = makeDeployment({
      id: "deploy-s1",
      status: "succeeded",
      failureReason: null,
      version: "2.0.0",
    });
    const report = generatePostmortem(makeSuccessEntries(), deployment);
    expect(report.summary).toContain("SUCCEEDED");
    expect(report.failureAnalysis).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// generatePostmortemAsync — LLM path
// ---------------------------------------------------------------------------

describe("generatePostmortemAsync — LLM-powered postmortem", () => {
  it("calls LLM with debrief data and returns structured postmortem", async () => {
    const reasonSpy = vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockResolvedValue({
      ok: true,
      text: makeLlmPostmortemJson(),
      model: "claude-sonnet-4-6",
      responseTimeMs: 950,
    });
    const llm = createMockLlm({ reasonSpy });

    const result = await generatePostmortemAsync(
      makeEntries(),
      makeDeployment(),
      llm,
    );

    expect(result.heuristicFallback).toBe(false);
    if (!result.heuristicFallback) {
      expect(result.llmPostmortem.executiveSummary).toContain("op-1 v1.2.3");
      expect(result.llmPostmortem.timeline).toHaveLength(3);
      expect(result.llmPostmortem.rootCause).toContain("port 3000");
      expect(result.llmPostmortem.contributingFactors.length).toBeGreaterThan(0);
      expect(result.llmPostmortem.remediationSteps.length).toBeGreaterThan(0);
      expect(result.llmPostmortem.lessonsLearned.length).toBeGreaterThan(0);
    }

    // LLM was called exactly once
    expect(reasonSpy).toHaveBeenCalledTimes(1);
  });

  it("sends the correct prompt structure to the LLM", async () => {
    const reasonSpy = vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockResolvedValue({
      ok: true,
      text: makeLlmPostmortemJson(),
      model: "claude-sonnet-4-6",
      responseTimeMs: 500,
    });
    const llm = createMockLlm({ reasonSpy });
    const deployment = makeDeployment();

    await generatePostmortemAsync(makeEntries(), deployment, llm);

    const callArgs = reasonSpy.mock.calls[0][0];

    // System prompt is the postmortem analysis prompt
    expect(callArgs.systemPrompt).toBe(POSTMORTEM_SYSTEM_PROMPT);

    // User prompt includes deployment metadata and debrief entries
    expect(callArgs.prompt).toContain("deploy-1");
    expect(callArgs.prompt).toContain("failed");
    expect(callArgs.prompt).toContain("1.2.3");
    expect(callArgs.prompt).toContain("Debrief Trail");
    expect(callArgs.prompt).toContain("PIPELINE-PLAN");
    expect(callArgs.prompt).toContain("DEPLOYMENT-FAILURE");
    expect(callArgs.prompt).toContain("health check returned 503");

    // Prompt summary is descriptive but not the full prompt
    expect(callArgs.promptSummary).toContain("deploy-1");

    // Partition and deployment context are set for debrief recording
    expect(callArgs.partitionId).toBe("partition-1");
    expect(callArgs.operationId).toBe("deploy-1");

    // Max tokens is large enough for a full postmortem
    expect(callArgs.maxTokens).toBe(4096);
  });

  it("includes all debrief entries in the prompt", async () => {
    const reasonSpy = vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockResolvedValue({
      ok: true,
      text: makeLlmPostmortemJson(),
      model: "claude-sonnet-4-6",
      responseTimeMs: 500,
    });
    const llm = createMockLlm({ reasonSpy });
    const entries = makeEntries();

    await generatePostmortemAsync(entries, makeDeployment(), llm);

    const callArgs = reasonSpy.mock.calls[0][0];

    // All three entries appear in the prompt
    expect(callArgs.prompt).toContain("PIPELINE-PLAN");
    expect(callArgs.prompt).toContain("CONFIGURATION-RESOLVED");
    expect(callArgs.prompt).toContain("DEPLOYMENT-FAILURE");
    // Entry reasoning text is included
    expect(callArgs.prompt).toContain("Deployment triggered by operator");
    expect(callArgs.prompt).toContain("All variables resolved without conflicts");
    expect(callArgs.prompt).toContain("HTTP 503 on all health check attempts");
  });

  it("uses llm.reason() (not classify()) for postmortem synthesis", async () => {
    const reasonSpy = vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockResolvedValue({
      ok: true,
      text: makeLlmPostmortemJson(),
      model: "claude-sonnet-4-6",
      responseTimeMs: 500,
    });
    const classifySpy = vi.fn();
    const llm = {
      isAvailable: () => true,
      reason: reasonSpy,
      classify: classifySpy,
    } as unknown as LlmClient;

    await generatePostmortemAsync(makeEntries(), makeDeployment(), llm);

    expect(reasonSpy).toHaveBeenCalledTimes(1);
    expect(classifySpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// generatePostmortemAsync — fallback scenarios
// ---------------------------------------------------------------------------

describe("generatePostmortemAsync — fallback to heuristic", () => {
  it("falls back when no LLM client is provided", async () => {
    const result = await generatePostmortemAsync(
      makeEntries(),
      makeDeployment(),
    );

    expect(result.heuristicFallback).toBe(true);
    if (result.heuristicFallback) {
      expect(result.heuristicReport.summary).toContain("FAILED");
      expect(result.heuristicReport.failureAnalysis).not.toBeNull();
    }
  });

  it("falls back when LLM client is explicitly undefined", async () => {
    const result = await generatePostmortemAsync(
      makeEntries(),
      makeDeployment(),
      undefined,
    );

    expect(result.heuristicFallback).toBe(true);
  });

  it("falls back when LLM returns a non-ok result (API key missing)", async () => {
    const llm = createMockLlm({
      reasonSpy: vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockResolvedValue({
        ok: false,
        fallback: true,
        reason: "LLM not configured — SYNTH_LLM_API_KEY not set",
      }),
    });

    const result = await generatePostmortemAsync(
      makeEntries(),
      makeDeployment(),
      llm,
    );

    expect(result.heuristicFallback).toBe(true);
    if (result.heuristicFallback) {
      expect(result.heuristicReport.summary).toContain("FAILED");
    }
  });

  it("falls back when LLM returns a non-ok result (rate limited)", async () => {
    const llm = createMockLlm({
      reasonSpy: vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockResolvedValue({
        ok: false,
        fallback: true,
        reason: "LLM rate limit exceeded (20 calls/min)",
      }),
    });

    const result = await generatePostmortemAsync(
      makeEntries(),
      makeDeployment(),
      llm,
    );

    expect(result.heuristicFallback).toBe(true);
  });

  it("falls back when LLM throws an unexpected error", async () => {
    const llm = createMockLlm({
      reasonSpy: vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockRejectedValue(
        new Error("Unexpected SDK error"),
      ),
    });

    const result = await generatePostmortemAsync(
      makeEntries(),
      makeDeployment(),
      llm,
    );

    expect(result.heuristicFallback).toBe(true);
    if (result.heuristicFallback) {
      // Heuristic still produces a valid report
      expect(result.heuristicReport.summary).toBeDefined();
      expect(result.heuristicReport.timeline.length).toBeGreaterThan(0);
    }
  });

  it("falls back when LLM response is not valid JSON", async () => {
    const llm = createMockLlm({
      reasonSpy: vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockResolvedValue({
        ok: true,
        text: "This is not valid JSON at all.",
        model: "claude-sonnet-4-6",
        responseTimeMs: 800,
      }),
    });

    const result = await generatePostmortemAsync(
      makeEntries(),
      makeDeployment(),
      llm,
    );

    expect(result.heuristicFallback).toBe(true);
  });

  it("falls back when LLM response JSON is missing required fields", async () => {
    const llm = createMockLlm({
      reasonSpy: vi.fn<(params: LlmCallParams) => Promise<LlmResult>>().mockResolvedValue({
        ok: true,
        text: JSON.stringify({ executiveSummary: "Incomplete response" }),
        model: "claude-sonnet-4-6",
        responseTimeMs: 700,
      }),
    });

    const result = await generatePostmortemAsync(
      makeEntries(),
      makeDeployment(),
      llm,
    );

    expect(result.heuristicFallback).toBe(true);
  });

  it("fallback report matches what generatePostmortem produces directly", async () => {
    const entries = makeEntries();
    const deployment = makeDeployment();

    const directReport = generatePostmortem(entries, deployment);
    const asyncResult = await generatePostmortemAsync(entries, deployment);

    expect(asyncResult.heuristicFallback).toBe(true);
    if (asyncResult.heuristicFallback) {
      expect(asyncResult.heuristicReport.summary).toBe(directReport.summary);
      expect(asyncResult.heuristicReport.outcome).toBe(directReport.outcome);
      expect(asyncResult.heuristicReport.timeline).toEqual(directReport.timeline);
    }
  });
});

// ---------------------------------------------------------------------------
// buildPostmortemPrompt — deterministic prompt construction
// ---------------------------------------------------------------------------

describe("buildPostmortemPrompt — prompt construction", () => {
  it("includes deployment metadata in the prompt", () => {
    const deployment = makeDeployment();
    const prompt = buildPostmortemPrompt(makeEntries(), deployment);

    expect(prompt).toContain("deploy-1");
    expect(prompt).toContain("failed");
    expect(prompt).toContain("1.2.3");
    expect(prompt).toContain("op-1");
    expect(prompt).toContain("env-staging");
    expect(prompt).toContain("partition-1");
    expect(prompt).toContain("2026-03-01");
  });

  it("includes failure reason when present", () => {
    const deployment = makeDeployment({ failureReason: "Connection timeout" });
    const prompt = buildPostmortemPrompt(makeEntries(), deployment);
    expect(prompt).toContain("Connection timeout");
  });

  it("omits failure reason when null", () => {
    const deployment = makeDeployment({
      status: "succeeded",
      failureReason: null,
    });
    const prompt = buildPostmortemPrompt(makeSuccessEntries(), deployment);
    expect(prompt).not.toContain("Failure reason:");
  });

  it("includes all debrief entries in chronological order", () => {
    const entries = makeEntries();
    const prompt = buildPostmortemPrompt(entries, makeDeployment());

    const planIndex = prompt.indexOf("PIPELINE-PLAN");
    const configIndex = prompt.indexOf("CONFIGURATION-RESOLVED");
    const failureIndex = prompt.indexOf("DEPLOYMENT-FAILURE");

    expect(planIndex).toBeLessThan(configIndex);
    expect(configIndex).toBeLessThan(failureIndex);
  });

  it("includes entry decisions and reasoning in the prompt", () => {
    const prompt = buildPostmortemPrompt(makeEntries(), makeDeployment());

    expect(prompt).toContain("Deploy op-1 v1.2.3 to staging for partition-1");
    expect(prompt).toContain("health check returned 503");
    expect(prompt).toContain("Recommended action:");
  });

  it("includes entry context as JSON", () => {
    const prompt = buildPostmortemPrompt(makeEntries(), makeDeployment());
    expect(prompt).toContain('"variableCount":5');
    expect(prompt).toContain('"step":"preflight-health-check"');
  });

  it("produces identical output for same inputs (deterministic)", () => {
    const entries = makeEntries();
    const deployment = makeDeployment();

    const prompt1 = buildPostmortemPrompt(entries, deployment);
    const prompt2 = buildPostmortemPrompt(entries, deployment);

    expect(prompt1).toBe(prompt2);
  });

  it("sorts entries chronologically regardless of input order", () => {
    const entries = makeEntries().reverse(); // reversed input
    const prompt = buildPostmortemPrompt(entries, makeDeployment());

    const planIndex = prompt.indexOf("PIPELINE-PLAN");
    const failureIndex = prompt.indexOf("DEPLOYMENT-FAILURE");
    expect(planIndex).toBeLessThan(failureIndex);
  });
});

// ---------------------------------------------------------------------------
// parseLlmPostmortemResponse — JSON parsing
// ---------------------------------------------------------------------------

describe("parseLlmPostmortemResponse — parsing", () => {
  it("parses a valid LLM postmortem response", () => {
    const result = parseLlmPostmortemResponse(makeLlmPostmortemJson());

    expect(result).not.toBeNull();
    expect(result!.executiveSummary).toContain("op-1 v1.2.3");
    expect(result!.timeline).toHaveLength(3);
    expect(result!.rootCause).toContain("port 3000");
    expect(result!.contributingFactors).toHaveLength(2);
    expect(result!.remediationSteps).toHaveLength(3);
    expect(result!.lessonsLearned).toHaveLength(2);
  });

  it("returns null for invalid JSON", () => {
    expect(parseLlmPostmortemResponse("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseLlmPostmortemResponse("")).toBeNull();
  });

  it("returns null when executiveSummary is missing", () => {
    const partial = {
      timeline: [],
      rootCause: "test",
      contributingFactors: [],
      remediationSteps: [],
      lessonsLearned: [],
    };
    expect(parseLlmPostmortemResponse(JSON.stringify(partial))).toBeNull();
  });

  it("returns null when rootCause is missing", () => {
    const partial = {
      executiveSummary: "test",
      timeline: [],
      contributingFactors: [],
      remediationSteps: [],
      lessonsLearned: [],
    };
    expect(parseLlmPostmortemResponse(JSON.stringify(partial))).toBeNull();
  });

  it("returns null when timeline is not an array", () => {
    const invalid = {
      executiveSummary: "test",
      timeline: "not an array",
      rootCause: "test",
      contributingFactors: [],
      remediationSteps: [],
      lessonsLearned: [],
    };
    expect(parseLlmPostmortemResponse(JSON.stringify(invalid))).toBeNull();
  });

  it("returns null when timeline entries have wrong structure", () => {
    const invalid = {
      executiveSummary: "test",
      timeline: [{ timestamp: "t1", event: "e1" }], // missing significance
      rootCause: "test",
      contributingFactors: [],
      remediationSteps: [],
      lessonsLearned: [],
    };
    expect(parseLlmPostmortemResponse(JSON.stringify(invalid))).toBeNull();
  });

  it("filters out non-string values in array fields", () => {
    const mixed = {
      executiveSummary: "test",
      timeline: [],
      rootCause: "test",
      contributingFactors: ["valid", 42, null, "also valid"],
      remediationSteps: ["step 1", undefined, "step 2"],
      lessonsLearned: [true, "lesson"],
    };
    const result = parseLlmPostmortemResponse(JSON.stringify(mixed));
    expect(result).not.toBeNull();
    expect(result!.contributingFactors).toEqual(["valid", "also valid"]);
    expect(result!.remediationSteps).toEqual(["step 1", "step 2"]);
    expect(result!.lessonsLearned).toEqual(["lesson"]);
  });

  it("handles LLM response with markdown code fences gracefully (returns null)", () => {
    // Some LLMs wrap JSON in code fences despite instructions not to
    const wrapped = "```json\n" + makeLlmPostmortemJson() + "\n```";
    // Our parser expects raw JSON -- this is intentional to detect bad responses
    expect(parseLlmPostmortemResponse(wrapped)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POSTMORTEM_SYSTEM_PROMPT — content validation
// ---------------------------------------------------------------------------

describe("POSTMORTEM_SYSTEM_PROMPT", () => {
  it("instructs the LLM to respond with JSON only", () => {
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("ONLY a JSON object");
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("no markdown");
  });

  it("defines the expected postmortem structure", () => {
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("executiveSummary");
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("timeline");
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("rootCause");
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("contributingFactors");
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("remediationSteps");
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("lessonsLearned");
  });

  it("emphasizes specificity and actionability", () => {
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("Specific");
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("Actionable");
    expect(POSTMORTEM_SYSTEM_PROMPT).toContain("Causal");
  });
});
