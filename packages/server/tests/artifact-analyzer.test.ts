import { describe, it, expect, vi, beforeEach } from "vitest";
import { DecisionDebrief } from "@synth-deploy/core";
import { ArtifactAnalyzer, createArtifactAnalyzer, detectArtifactType } from "../src/artifact-analyzer.js";
import type { ArtifactInput } from "../src/artifact-analyzer.js";
import type { LlmClient } from "@synth-deploy/core";

// ---------------------------------------------------------------------------
// Mock LLM client
// ---------------------------------------------------------------------------

function createMockLlm(opts: { available?: boolean; response?: string } = {}): LlmClient {
  const available = opts.available ?? true;
  const response = opts.response ?? "{}";

  return {
    isAvailable: () => available,
    reason: vi.fn().mockResolvedValue(
      available
        ? { ok: true, text: response, model: "test-model", responseTimeMs: 100 }
        : { ok: false, fallback: true, reason: "LLM not configured" },
    ),
    classify: vi.fn().mockResolvedValue({ ok: false, fallback: true, reason: "not used" }),
    healthCheck: vi.fn().mockResolvedValue({ configured: false, healthy: false }),
    getLastHealthStatus: vi.fn().mockReturnValue(null),
  } as unknown as LlmClient;
}

function makeArtifact(overrides: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    name: "test-artifact",
    source: "test-registry",
    ...overrides,
  };
}

function bufferFrom(text: string): Buffer {
  return Buffer.from(text, "utf-8");
}

// ---------------------------------------------------------------------------
// Type detection
// ---------------------------------------------------------------------------

describe("detectArtifactType", () => {
  it("detects Dockerfile by name", () => {
    expect(detectArtifactType(makeArtifact({ name: "Dockerfile" }))).toBe("dockerfile");
  });

  it("detects Chart.yaml", () => {
    expect(detectArtifactType(makeArtifact({ name: "Chart.yaml" }))).toBe("helm-chart");
  });

  it("detects values.yaml", () => {
    expect(detectArtifactType(makeArtifact({ name: "values.yaml" }))).toBe("helm-values");
  });

  it("detects package.json", () => {
    expect(detectArtifactType(makeArtifact({ name: "package.json" }))).toBe("node-package");
  });

  it("detects Makefile", () => {
    expect(detectArtifactType(makeArtifact({ name: "Makefile" }))).toBe("makefile");
  });

  it("detects .tgz", () => {
    expect(detectArtifactType(makeArtifact({ name: "app-1.0.0.tgz" }))).toBe("tarball");
  });

  it("detects .tar", () => {
    expect(detectArtifactType(makeArtifact({ name: "image.tar" }))).toBe("tarball");
  });

  it("detects .zip", () => {
    expect(detectArtifactType(makeArtifact({ name: "deploy.zip" }))).toBe("zip");
  });

  it("detects .nupkg", () => {
    expect(detectArtifactType(makeArtifact({ name: "MyService.1.0.0.nupkg" }))).toBe("nupkg");
  });

  it("detects .jar", () => {
    expect(detectArtifactType(makeArtifact({ name: "app.jar" }))).toBe("java-archive");
  });

  it("respects explicit type override", () => {
    expect(detectArtifactType(makeArtifact({ name: "build-config", type: "dockerfile" }))).toBe("dockerfile");
  });

  it("returns unknown for unrecognized files", () => {
    expect(detectArtifactType(makeArtifact({ name: "mystery.dat" }))).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// LLM analysis
// ---------------------------------------------------------------------------

describe("ArtifactAnalyzer — LLM analysis", () => {
  it("returns llm method when LLM produces valid analysis", async () => {
    const llmResponse = JSON.stringify({
      summary: "A Node.js API server with PostgreSQL dependency",
      dependencies: ["npm:express", "system:postgresql-15"],
      configurationExpectations: { DATABASE_URL: "PostgreSQL connection string", PORT: "HTTP port" },
      deploymentIntent: "Containerized Node.js API deployment",
      confidence: 0.92,
    });

    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: true, response: llmResponse }),
      debrief: new DecisionDebrief(),
    });

    const result = await analyzer.analyze(
      makeArtifact({ name: "package.json", content: bufferFrom('{"name":"api","version":"1.0.0"}') }),
    );

    expect(result.method).toBe("llm");
    expect(result.analysis.summary).toContain("Node.js API server");
    expect(result.analysis.dependencies).toContain("npm:express");
    expect(result.analysis.dependencies).toContain("system:postgresql-15");
    expect(result.analysis.configurationExpectations["DATABASE_URL"]).toBeDefined();
    expect(result.analysis.confidence).toBe(0.92);
  });

  it("handles LLM response wrapped in markdown code blocks", async () => {
    const wrappedResponse = `Here is the analysis:\n\n\`\`\`json\n{\n  "summary": "A Python web service",\n  "dependencies": ["pip:flask"],\n  "configurationExpectations": {},\n  "deploymentIntent": "Python WSGI deployment",\n  "confidence": 0.8\n}\n\`\`\``;

    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: true, response: wrappedResponse }),
      debrief: new DecisionDebrief(),
    });

    const result = await analyzer.analyze(makeArtifact({ name: "app.tar.gz" }));

    expect(result.method).toBe("llm");
    expect(result.analysis.summary).toContain("Python web service");
  });

  it("passes artifact content and type to the LLM", async () => {
    const llmResponse = JSON.stringify({
      summary: "Container image",
      dependencies: [],
      configurationExpectations: {},
      deploymentIntent: "Container deployment",
      confidence: 0.9,
    });

    const mockLlm = createMockLlm({ available: true, response: llmResponse });
    const analyzer = createArtifactAnalyzer({ llm: mockLlm, debrief: new DecisionDebrief() });

    const content = "FROM node:20-alpine\nEXPOSE 3000\n";
    await analyzer.analyze(makeArtifact({ name: "Dockerfile", content: bufferFrom(content) }));

    const reasonCall = (mockLlm.reason as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(reasonCall.prompt).toContain("Dockerfile");
    expect(reasonCall.prompt).toContain("dockerfile");
    expect(reasonCall.prompt).toContain("FROM node:20-alpine");
  });

  it("records a debrief entry for every analysis", async () => {
    const debrief = new DecisionDebrief();
    const llmResponse = JSON.stringify({
      summary: "A service",
      dependencies: [],
      configurationExpectations: {},
      confidence: 0.7,
    });

    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: true, response: llmResponse }),
      debrief,
    });

    await analyzer.analyze(makeArtifact({ name: "Dockerfile", content: bufferFrom("FROM alpine") }));

    const entries = debrief.getByType("artifact-analysis");
    expect(entries.length).toBe(1);
    expect(entries[0].decision).toContain("Dockerfile");
    expect(entries[0].context).toHaveProperty("method", "llm");
  });
});

// ---------------------------------------------------------------------------
// LLM unavailable
// ---------------------------------------------------------------------------

describe("ArtifactAnalyzer — LLM unavailable", () => {
  it("returns unavailable method when LLM is not configured", async () => {
    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: false }),
      debrief: new DecisionDebrief(),
    });

    const result = await analyzer.analyze(makeArtifact({ name: "Dockerfile" }));

    expect(result.method).toBe("unavailable");
    expect(result.analysis.confidence).toBe(0);
    expect(result.analysis.summary).toContain("LLM is required");
  });

  it("returns unavailable when LLM returns invalid JSON", async () => {
    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: true, response: "I cannot produce valid JSON right now." }),
      debrief: new DecisionDebrief(),
    });

    const result = await analyzer.analyze(makeArtifact({ name: "Dockerfile" }));

    expect(result.method).toBe("unavailable");
    expect(result.analysis.confidence).toBe(0);
  });

  it("records a debrief entry even when unavailable", async () => {
    const debrief = new DecisionDebrief();
    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: false }),
      debrief,
    });

    await analyzer.analyze(makeArtifact({ name: "app.zip" }));

    const entries = debrief.getByType("artifact-analysis");
    expect(entries.length).toBe(1);
    expect(entries[0].context).toHaveProperty("method", "unavailable");
  });
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe("createArtifactAnalyzer", () => {
  it("returns an ArtifactAnalyzer instance", () => {
    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm(),
      debrief: new DecisionDebrief(),
    });
    expect(analyzer).toBeInstanceOf(ArtifactAnalyzer);
  });
});
