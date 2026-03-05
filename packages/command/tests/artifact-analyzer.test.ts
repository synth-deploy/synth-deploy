import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DecisionDebrief } from "@deploystack/core";
import { ArtifactAnalyzer, createArtifactAnalyzer } from "../src/artifact-analyzer.js";
import type { ArtifactInput } from "../src/artifact-analyzer.js";
import type { LlmClient } from "@deploystack/core";

// ---------------------------------------------------------------------------
// Mock LLM client
// ---------------------------------------------------------------------------

function createMockLlm(opts: { available?: boolean; response?: string } = {}): LlmClient {
  const available = opts.available ?? false;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Deterministic extraction tests
// ---------------------------------------------------------------------------

describe("ArtifactAnalyzer — deterministic extraction", () => {
  let debrief: DecisionDebrief;
  let analyzer: ArtifactAnalyzer;

  beforeEach(() => {
    debrief = new DecisionDebrief();
    analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: false }),
      debrief,
    });
  });

  it("extracts Dockerfile metadata", async () => {
    const dockerfile = `FROM node:20-alpine
EXPOSE 3000 8080
ENV APP_ENV=production
ENV LOG_LEVEL debug
ENTRYPOINT ["node", "server.js"]
`;
    const result = await analyzer.analyze(
      makeArtifact({ name: "Dockerfile", content: bufferFrom(dockerfile) }),
    );

    expect(result.analysis.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.analysis.dependencies).toContain("base-image:node:20-alpine");
    expect(result.analysis.configurationExpectations["EXPOSED_PORTS"]).toBe("3000, 8080");
    expect(result.analysis.configurationExpectations["APP_ENV"]).toBe("production");
    expect(result.analysis.configurationExpectations["LOG_LEVEL"]).toBe("debug");
    expect(result.analysis.summary).toContain("Container image");
    expect(result.analysis.summary).toContain("Entrypoint");
    expect(result.analysis.deploymentIntent).toBe("Container deployment");
    expect(result.method).toBe("deterministic");
  });

  it("extracts Helm Chart.yaml metadata", async () => {
    const chartYaml = `apiVersion: v2
name: my-service
version: 1.2.3
appVersion: "2.0.0"
description: My awesome service
`;
    const result = await analyzer.analyze(
      makeArtifact({ name: "Chart.yaml", content: bufferFrom(chartYaml) }),
    );

    expect(result.analysis.summary).toContain("my-service");
    expect(result.analysis.summary).toContain("1.2.3");
    expect(result.analysis.configurationExpectations["appVersion"]).toBe('"2.0.0"');
    expect(result.analysis.deploymentIntent).toBe("Kubernetes Helm deployment");
    expect(result.analysis.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("extracts package.json metadata", async () => {
    const packageJson = JSON.stringify({
      name: "@myorg/api-server",
      version: "3.1.0",
      scripts: { start: "node dist/index.js", build: "tsc", test: "vitest" },
      dependencies: { express: "^4.18.0", pg: "^8.11.0" },
      devDependencies: { typescript: "^5.0.0" },
      engines: { node: ">=20" },
    });

    const result = await analyzer.analyze(
      makeArtifact({ name: "package.json", content: bufferFrom(packageJson) }),
    );

    expect(result.analysis.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.analysis.dependencies).toContain("npm:express");
    expect(result.analysis.dependencies).toContain("npm:pg");
    expect(result.analysis.dependencies).toContain("npm-dev:typescript");
    expect(result.analysis.configurationExpectations["node"]).toBe(">=20");
    expect(result.analysis.deploymentIntent).toContain("Node.js");
    expect(result.analysis.summary).toContain("@myorg/api-server");
  });

  it("extracts Makefile targets", async () => {
    const makefile = `BINARY=myapp
VERSION?=1.0.0

build:
\tgo build -o $(BINARY)

test:
\tgo test ./...

deploy:
\trsync -a $(BINARY) prod:/usr/local/bin/

clean:
\trm -f $(BINARY)
`;
    const result = await analyzer.analyze(
      makeArtifact({ name: "Makefile", content: bufferFrom(makefile) }),
    );

    expect(result.analysis.summary).toContain("build");
    expect(result.analysis.summary).toContain("deploy");
    expect(result.analysis.configurationExpectations["BINARY"]).toBe("myapp");
    expect(result.analysis.configurationExpectations["VERSION"]).toBe("1.0.0");
    expect(result.analysis.deploymentIntent).toBe("Makefile-driven deployment");
  });

  it("handles Helm values.yaml", async () => {
    const values = `replicaCount: 3
image: myapp:latest
port: 8080
`;
    const result = await analyzer.analyze(
      makeArtifact({ name: "values.yaml", content: bufferFrom(values) }),
    );

    expect(result.analysis.configurationExpectations["replicaCount"]).toBe("3");
    expect(result.analysis.configurationExpectations["image"]).toBe("myapp:latest");
    expect(result.analysis.deploymentIntent).toContain("Helm");
  });

  it("handles composite archives with metadata", async () => {
    const result = await analyzer.analyze(
      makeArtifact({
        name: "deploy-bundle.zip",
        metadata: { entries: "Dockerfile,app.js,package.json", size: "2.4 MB" },
      }),
    );

    expect(result.analysis.summary).toContain("ZIP");
    expect(result.analysis.summary).toContain("Dockerfile");
    expect(result.analysis.summary).toContain("package.json");
    expect(result.analysis.deploymentIntent).toContain("Container");
    expect(result.analysis.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("handles unknown artifacts with low confidence", async () => {
    const result = await analyzer.analyze(
      makeArtifact({
        name: "mystery-blob.dat",
        content: bufferFrom("binary data here"),
        metadata: { size: "512 KB" },
      }),
    );

    expect(result.analysis.confidence).toBeLessThan(0.5);
    expect(result.analysis.summary).toContain("mystery-blob.dat");
    expect(result.method).toBe("fallback");
  });

  it("handles invalid package.json gracefully", async () => {
    const result = await analyzer.analyze(
      makeArtifact({
        name: "package.json",
        content: bufferFrom("not json at all{{{"),
      }),
    );

    expect(result.analysis.summary).toContain("invalid JSON");
    expect(result.analysis.confidence).toBeLessThan(0.5);
  });

  it("records debrief entry for every analysis", async () => {
    await analyzer.analyze(
      makeArtifact({
        name: "Dockerfile",
        content: bufferFrom("FROM alpine\nEXPOSE 80"),
      }),
    );

    const entries = debrief.getByType("artifact-analysis");
    expect(entries.length).toBe(1);
    expect(entries[0].decision).toContain("Dockerfile");
    expect(entries[0].decision).toContain("dockerfile");
    expect(entries[0].reasoning).toContain("Deterministic extraction succeeded");
    expect(entries[0].context).toHaveProperty("confidence");
    expect(entries[0].context).toHaveProperty("method", "deterministic");
    expect(entries[0].context).toHaveProperty("artifactType", "dockerfile");
  });
});

// ---------------------------------------------------------------------------
// LLM enhancement tests
// ---------------------------------------------------------------------------

describe("ArtifactAnalyzer — LLM enhancement", () => {
  it("merges LLM enhancement with deterministic extraction", async () => {
    const debrief = new DecisionDebrief();
    const llmResponse = JSON.stringify({
      summary: "Enhanced: Production-ready Node.js API server with PostgreSQL dependency",
      dependencies: ["npm:express", "system:postgresql-15"],
      configurationExpectations: { DATABASE_URL: "PostgreSQL connection string required" },
      deploymentIntent: "Containerized Node.js API deployment",
      confidence: 0.92,
    });

    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: true, response: llmResponse }),
      debrief,
    });

    const packageJson = JSON.stringify({
      name: "api-server",
      version: "1.0.0",
      scripts: { start: "node index.js" },
      dependencies: { express: "^4.18.0", pg: "^8.11.0" },
    });

    const result = await analyzer.analyze(
      makeArtifact({ name: "package.json", content: bufferFrom(packageJson) }),
    );

    expect(result.method).toBe("llm-enhanced");
    // LLM summary should override
    expect(result.analysis.summary).toContain("Enhanced");
    // Dependencies should be merged and deduplicated
    expect(result.analysis.dependencies).toContain("npm:express");
    expect(result.analysis.dependencies).toContain("system:postgresql-15");
    // LLM config expectations merged
    expect(result.analysis.configurationExpectations["DATABASE_URL"]).toBeDefined();
    // LLM confidence should be used when higher
    expect(result.analysis.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("falls back to deterministic when LLM returns invalid JSON", async () => {
    const debrief = new DecisionDebrief();
    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: true, response: "I cannot produce valid JSON right now." }),
      debrief,
    });

    const result = await analyzer.analyze(
      makeArtifact({
        name: "Dockerfile",
        content: bufferFrom("FROM python:3.12\nEXPOSE 8000"),
      }),
    );

    expect(result.method).toBe("deterministic");
    expect(result.analysis.dependencies).toContain("base-image:python:3.12");
  });

  it("uses deterministic only when LLM is unavailable", async () => {
    const debrief = new DecisionDebrief();
    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: false }),
      debrief,
    });

    const result = await analyzer.analyze(
      makeArtifact({
        name: "package.json",
        content: bufferFrom(JSON.stringify({ name: "test", version: "1.0.0" })),
      }),
    );

    expect(result.method).toBe("deterministic");
  });

  it("handles LLM response wrapped in markdown code blocks", async () => {
    const debrief = new DecisionDebrief();
    const wrappedResponse = `Here is the analysis:

\`\`\`json
{
  "summary": "A Python web service",
  "dependencies": ["pip:flask"],
  "configurationExpectations": {},
  "deploymentIntent": "Python WSGI deployment",
  "confidence": 0.8
}
\`\`\``;

    const analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: true, response: wrappedResponse }),
      debrief,
    });

    const result = await analyzer.analyze(
      makeArtifact({ name: "unknown-app.tar.gz", metadata: { size: "5 MB" } }),
    );

    expect(result.method).toBe("llm-enhanced");
    expect(result.analysis.summary).toContain("Python web service");
  });
});

// ---------------------------------------------------------------------------
// Type detection tests
// ---------------------------------------------------------------------------

describe("ArtifactAnalyzer — type detection", () => {
  let analyzer: ArtifactAnalyzer;

  beforeEach(() => {
    analyzer = createArtifactAnalyzer({
      llm: createMockLlm({ available: false }),
      debrief: new DecisionDebrief(),
    });
  });

  it("detects Dockerfile by name", async () => {
    const result = await analyzer.analyze(
      makeArtifact({ name: "Dockerfile", content: bufferFrom("FROM alpine") }),
    );
    expect(result.analysis.deploymentIntent).toContain("Container");
  });

  it("detects package.json by name", async () => {
    const result = await analyzer.analyze(
      makeArtifact({
        name: "package.json",
        content: bufferFrom(JSON.stringify({ name: "x", version: "1.0.0" })),
      }),
    );
    expect(result.analysis.summary).toContain("Node.js");
  });

  it("uses explicit type when provided", async () => {
    const result = await analyzer.analyze(
      makeArtifact({
        name: "build-config",
        type: "dockerfile",
        content: bufferFrom("FROM ubuntu:22.04"),
      }),
    );
    expect(result.analysis.summary).toContain("Container image");
  });

  it("detects tarball by extension", async () => {
    const result = await analyzer.analyze(
      makeArtifact({
        name: "release-v2.tar.gz",
        metadata: { entries: "Makefile,README.md,bin/app", size: "10 MB" },
      }),
    );
    expect(result.analysis.summary).toContain("Tarball");
    expect(result.analysis.summary).toContain("Makefile");
  });
});

// ---------------------------------------------------------------------------
// Factory test
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
