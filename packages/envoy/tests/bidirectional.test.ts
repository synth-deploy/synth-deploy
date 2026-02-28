import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief } from "@deploystack/core";
import type { DebriefEntry, DebriefWriter } from "@deploystack/core";
import { EnvoyAgent } from "../src/agent/envoy-agent.js";
import type { DeploymentInstruction } from "../src/agent/envoy-agent.js";
import { LocalStateStore } from "../src/state/local-state.js";
import { CommandReporter } from "../src/agent/command-reporter.js";
import { createEnvoyServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "envoy-bidir-"));
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
    projectId: "web-app",
    version: "2.0.0",
    variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    environmentName: "production",
    partitionName: "Acme Corp",
    ...overrides,
  };
}

/**
 * Creates a minimal mock Server that accepts Envoy reports.
 * Returns the Fastify instance and a list of received reports.
 */
function createMockServer(): {
  app: FastifyInstance;
  receivedReports: any[];
  serverDiary: DecisionDebrief;
} {
  const app = Fastify({ logger: false });
  const receivedReports: any[] = [];
  const serverDiary = new DecisionDebrief();

  app.post("/api/envoy/report", async (request, reply) => {
    const report = request.body as any;
    receivedReports.push(report);

    // Ingest diary entries into the Server diary — same as the real endpoint
    for (const entry of report.debriefEntries) {
      serverDiary.record({
        partitionId: entry.partitionId,
        deploymentId: entry.deploymentId,
        agent: entry.agent,
        decisionType: entry.decisionType,
        decision: entry.decision,
        reasoning: entry.reasoning,
        context: {
          ...entry.context,
          _envoyReport: {
            envoyId: report.envoyId,
            originalEntryId: entry.id,
            originalTimestamp: entry.timestamp,
          },
        },
      });
    }

    return reply.status(200).send({
      accepted: true,
      deploymentId: report.deploymentId,
      entriesIngested: report.debriefEntries.length,
    });
  });

  return { app, receivedReports, serverDiary };
}

// ---------------------------------------------------------------------------
// Test Suite: Diary Entries in Deployment Result
// ---------------------------------------------------------------------------

describe("DeploymentResult carries full diary entries", () => {
  let baseDir: string;
  let diary: DecisionDebrief;
  let state: LocalStateStore;
  let agent: EnvoyAgent;

  beforeEach(() => {
    baseDir = makeTmpDir();
    fs.mkdirSync(path.join(baseDir, "deployments"), { recursive: true });
    diary = new DecisionDebrief();
    state = new LocalStateStore();
    agent = new EnvoyAgent(diary, state, baseDir);
  });

  afterEach(() => {
    cleanDir(baseDir);
  });

  it("result includes debriefEntries array with full entry objects", async () => {
    const result = await agent.executeDeployment(
      makeInstruction({ deploymentId: "entries-test" }),
    );

    expect(result.debriefEntries).toBeDefined();
    expect(result.debriefEntries.length).toBe(result.debriefEntryIds.length);
    expect(result.debriefEntries.length).toBeGreaterThanOrEqual(5);

    // Each entry has all required fields
    for (const entry of result.debriefEntries) {
      expect(entry.id).toBeDefined();
      expect(entry.timestamp).toBeInstanceOf(Date);
      expect(entry.agent).toBe("envoy");
      expect(entry.deploymentId).toBe("entries-test");
      expect(entry.decision.length).toBeGreaterThan(0);
      expect(entry.reasoning.length).toBeGreaterThan(0);
    }
  });

  it("debriefEntries and debriefEntryIds are in sync", async () => {
    const result = await agent.executeDeployment(
      makeInstruction({ deploymentId: "sync-test" }),
    );

    const entryIds = result.debriefEntries.map((e) => e.id);
    expect(entryIds).toEqual(result.debriefEntryIds);
  });

  it("debriefEntries cover all pipeline decision types", async () => {
    const result = await agent.executeDeployment(
      makeInstruction({ deploymentId: "types-test" }),
    );

    const types = result.debriefEntries.map((e) => e.decisionType);
    expect(types).toContain("pipeline-plan");
    expect(types).toContain("environment-scan");
    expect(types).toContain("deployment-execution");
    expect(types).toContain("deployment-verification");
    expect(types).toContain("deployment-completion");
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Envoy→Server Reporting
// ---------------------------------------------------------------------------

describe("Envoy→Server bidirectional communication", () => {
  let baseDir: string;
  let envoyDiary: DecisionDebrief;
  let state: LocalStateStore;
  let mockServer: ReturnType<typeof createMockServer>;
  let serverAddress: string;

  beforeEach(async () => {
    baseDir = makeTmpDir();
    fs.mkdirSync(path.join(baseDir, "deployments"), { recursive: true });
    envoyDiary = new DecisionDebrief();
    state = new LocalStateStore();

    // Start mock Server
    mockServer = createMockServer();
    await mockServer.app.ready();
    await mockServer.app.listen({ port: 0, host: "127.0.0.1" });
    const addr = mockServer.app.server.address();
    if (typeof addr === "object" && addr) {
      serverAddress = `http://127.0.0.1:${addr.port}`;
    }
  });

  afterEach(async () => {
    await mockServer.app.close();
    cleanDir(baseDir);
  });

  it("Envoy pushes deployment result to the Server", async () => {
    const reporter = new CommandReporter(
      serverAddress,
      "envoy-test-01",
    );
    const agent = new EnvoyAgent(
      envoyDiary,
      state,
      baseDir,
      reporter,
    );

    const result = await agent.executeDeployment(
      makeInstruction({ deploymentId: "push-test" }),
    );

    // Wait briefly for the async report to land
    await new Promise((r) => setTimeout(r, 100));

    expect(mockServer.receivedReports.length).toBe(1);
    const report = mockServer.receivedReports[0];
    expect(report.type).toBe("deployment-result");
    expect(report.envoyId).toBe("envoy-test-01");
    expect(report.deploymentId).toBe("push-test");
    expect(report.success).toBe(true);
    expect(report.debriefEntries.length).toBeGreaterThanOrEqual(5);
  });

  it("Server diary receives Envoy's diary entries", async () => {
    const reporter = new CommandReporter(
      serverAddress,
      "envoy-test-02",
    );
    const agent = new EnvoyAgent(
      envoyDiary,
      state,
      baseDir,
      reporter,
    );

    await agent.executeDeployment(
      makeInstruction({ deploymentId: "ingest-test" }),
    );

    await new Promise((r) => setTimeout(r, 100));

    // Server diary now has the Envoy's entries
    const serverEntries =
      mockServer.serverDiary.getByDeployment("ingest-test");
    expect(serverEntries.length).toBeGreaterThanOrEqual(5);

    // All entries are tagged as envoy agent
    expect(serverEntries.every((e) => e.agent === "envoy")).toBe(true);

    // All entries carry traceability back to the Envoy
    for (const entry of serverEntries) {
      const meta = entry.context._envoyReport as any;
      expect(meta).toBeDefined();
      expect(meta.envoyId).toBe("envoy-test-02");
      expect(meta.originalEntryId).toBeDefined();
      expect(meta.originalTimestamp).toBeDefined();
    }
  });

  it("Server diary has decision types from Envoy pipeline", async () => {
    const reporter = new CommandReporter(
      serverAddress,
      "envoy-test-03",
    );
    const agent = new EnvoyAgent(
      envoyDiary,
      state,
      baseDir,
      reporter,
    );

    await agent.executeDeployment(
      makeInstruction({ deploymentId: "types-test" }),
    );

    await new Promise((r) => setTimeout(r, 100));

    const serverEntries =
      mockServer.serverDiary.getByDeployment("types-test");
    const types = serverEntries.map((e) => e.decisionType);

    expect(types).toContain("pipeline-plan");
    expect(types).toContain("environment-scan");
    expect(types).toContain("deployment-execution");
    expect(types).toContain("deployment-verification");
    expect(types).toContain("deployment-completion");
  });

  it("combined Server + Envoy diary tells unified story", async () => {
    const reporter = new CommandReporter(
      serverAddress,
      "envoy-test-04",
    );
    const agent = new EnvoyAgent(
      envoyDiary,
      state,
      baseDir,
      reporter,
    );

    const deploymentId = "unified-story";

    // Simulate Server's orchestration decisions
    mockServer.serverDiary.record({
      partitionId: "partition-1",
      deploymentId,
      agent: "server",
      decisionType: "pipeline-plan",
      decision: "Planned deployment pipeline",
      reasoning:
        "Server orchestrating web-app v2.0.0 to production for Acme Corp",
      context: {},
    });

    mockServer.serverDiary.record({
      partitionId: "partition-1",
      deploymentId,
      agent: "server",
      decisionType: "configuration-resolved",
      decision: "Configuration accepted — 2 variables, no conflicts",
      reasoning: "Standard precedence applied",
      context: {},
    });

    mockServer.serverDiary.record({
      partitionId: "partition-1",
      deploymentId,
      agent: "server",
      decisionType: "health-check",
      decision: "Envoy is healthy — delegating execution",
      reasoning: "Pre-flight health check to Envoy passed",
      context: {},
    });

    // Envoy executes and reports back
    await agent.executeDeployment(makeInstruction({ deploymentId }));
    await new Promise((r) => setTimeout(r, 100));

    // Server records its own completion
    mockServer.serverDiary.record({
      partitionId: "partition-1",
      deploymentId,
      agent: "server",
      decisionType: "deployment-completion",
      decision: "Deployment confirmed — Envoy reported success",
      reasoning: "All verification checks passed on the target machine",
      context: {},
    });

    // Now query the unified diary
    const allEntries =
      mockServer.serverDiary.getByDeployment(deploymentId);

    // Server entries (4) + Envoy entries (5+) = 9+
    expect(allEntries.length).toBeGreaterThanOrEqual(9);

    // Both agents are represented
    const serverEntries = allEntries.filter((e) => e.agent === "server");
    const envoyEntries = allEntries.filter(
      (e) => e.agent === "envoy",
    );

    expect(serverEntries.length).toBeGreaterThanOrEqual(4);
    expect(envoyEntries.length).toBeGreaterThanOrEqual(5);

    // An engineer reading the diary sees the full story:
    // Server planned, resolved config, checked health, delegated.
    // Envoy received, scanned, executed, verified, completed.
    // Server confirmed.
    const serverTypes = serverEntries.map((e) => e.decisionType);
    expect(serverTypes).toContain("pipeline-plan");
    expect(serverTypes).toContain("configuration-resolved");
    expect(serverTypes).toContain("health-check");
    expect(serverTypes).toContain("deployment-completion");

    const envoyTypes = envoyEntries.map((e) => e.decisionType);
    expect(envoyTypes).toContain("pipeline-plan");
    expect(envoyTypes).toContain("environment-scan");
    expect(envoyTypes).toContain("deployment-execution");
    expect(envoyTypes).toContain("deployment-verification");
    expect(envoyTypes).toContain("deployment-completion");
  });

  it("reporter handles server being unreachable gracefully", async () => {
    // Reporter pointing at a non-existent server
    const reporter = new CommandReporter(
      "http://127.0.0.1:1",
      "envoy-test-05",
    );
    const agent = new EnvoyAgent(
      envoyDiary,
      state,
      baseDir,
      reporter,
    );

    // Should not throw — deployment still completes
    const result = await agent.executeDeployment(
      makeInstruction({ deploymentId: "unreachable-server" }),
    );

    expect(result.success).toBe(true);
    expect(result.debriefEntries.length).toBeGreaterThanOrEqual(5);

    // The deployment worked locally; the report just didn't land
    await new Promise((r) => setTimeout(r, 200));
    expect(mockServer.receivedReports.length).toBe(0);
  });

  it("Envoy without reporter still works (no Server configured)", async () => {
    // No reporter — simulates DEPLOYSTACK_SERVER_URL not being set
    const agent = new EnvoyAgent(envoyDiary, state, baseDir);

    const result = await agent.executeDeployment(
      makeInstruction({ deploymentId: "no-reporter" }),
    );

    expect(result.success).toBe(true);
    expect(result.debriefEntries.length).toBeGreaterThanOrEqual(5);
  });
});
