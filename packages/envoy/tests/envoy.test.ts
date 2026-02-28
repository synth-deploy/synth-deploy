import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DecisionDebrief } from "@deploystack/core";
import type { DebriefEntry } from "@deploystack/core";
import { EnvoyAgent } from "../src/agent/envoy-agent.js";
import type { DeploymentInstruction } from "../src/agent/envoy-agent.js";
import { DeploymentExecutor } from "../src/agent/deployment-executor.js";
import { EnvironmentScanner } from "../src/agent/environment-scanner.js";
import { LocalStateStore } from "../src/state/local-state.js";
import { createEnvoyServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "envoy-test-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function makeInstruction(overrides: Partial<DeploymentInstruction> = {}): DeploymentInstruction {
  return {
    deploymentId: `deploy-${Date.now()}`,
    partitionId: "partition-1",
    environmentId: "env-prod",
    projectId: "web-app",
    version: "2.0.0",
    variables: { APP_ENV: "production", LOG_LEVEL: "warn", DB_HOST: "db-1" },
    environmentName: "production",
    partitionName: "Acme Corp",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite 1: Local State Store
// ---------------------------------------------------------------------------

describe("LocalStateStore", () => {
  let state: LocalStateStore;

  beforeEach(() => {
    state = new LocalStateStore();
  });

  it("records and retrieves deployments", () => {
    const record = state.recordDeployment({
      deploymentId: "d-1",
      partitionId: "t-1",
      environmentId: "e-1",
      projectId: "web-app",
      version: "1.0.0",
      variables: { APP_ENV: "prod" },
      workspacePath: "/tmp/test",
    });

    expect(record.status).toBe("executing");
    expect(record.completedAt).toBeNull();

    const retrieved = state.getDeployment("d-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.projectId).toBe("web-app");
  });

  it("completes deployments and tracks status", () => {
    state.recordDeployment({
      deploymentId: "d-1",
      partitionId: "t-1",
      environmentId: "e-1",
      projectId: "web-app",
      version: "1.0.0",
      variables: {},
      workspacePath: "/tmp/test",
    });

    const completed = state.completeDeployment("d-1", "succeeded");
    expect(completed!.status).toBe("succeeded");
    expect(completed!.completedAt).toBeInstanceOf(Date);
  });

  it("updates environment snapshots on deployment", () => {
    const snapshot = state.updateEnvironment("t-1", "e-1", {
      currentVersion: "2.0.0",
      currentDeploymentId: "d-1",
      activeVariables: { APP_ENV: "production" },
    });

    expect(snapshot.currentVersion).toBe("2.0.0");
    expect(snapshot.currentDeploymentId).toBe("d-1");

    const retrieved = state.getEnvironment("t-1", "e-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.currentVersion).toBe("2.0.0");
  });

  it("produces accurate summary", () => {
    state.recordDeployment({
      deploymentId: "d-1", partitionId: "t-1", environmentId: "e-1",
      projectId: "app", version: "1.0", variables: {}, workspacePath: "/tmp",
    });
    state.recordDeployment({
      deploymentId: "d-2", partitionId: "t-1", environmentId: "e-1",
      projectId: "app", version: "2.0", variables: {}, workspacePath: "/tmp",
    });
    state.completeDeployment("d-1", "succeeded");
    state.completeDeployment("d-2", "failed", "disk full");

    const summary = state.getSummary();
    expect(summary.totalDeployments).toBe(2);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.executing).toBe(0);
  });

  it("isolates deployments by partition", () => {
    state.recordDeployment({
      deploymentId: "d-1", partitionId: "t-1", environmentId: "e-1",
      projectId: "app", version: "1.0", variables: {}, workspacePath: "/tmp",
    });
    state.recordDeployment({
      deploymentId: "d-2", partitionId: "t-2", environmentId: "e-1",
      projectId: "app", version: "1.0", variables: {}, workspacePath: "/tmp",
    });

    expect(state.getDeploymentsByPartition("t-1")).toHaveLength(1);
    expect(state.getDeploymentsByPartition("t-2")).toHaveLength(1);
    expect(state.getDeploymentsByPartition("t-1")[0].deploymentId).toBe("d-1");
  });
});

// ---------------------------------------------------------------------------
// Test Suite 2: Deployment Executor
// ---------------------------------------------------------------------------

describe("DeploymentExecutor", () => {
  let baseDir: string;
  let executor: DeploymentExecutor;

  beforeEach(() => {
    baseDir = makeTmpDir();
    fs.mkdirSync(path.join(baseDir, "deployments"), { recursive: true });
    executor = new DeploymentExecutor(baseDir);
  });

  afterEach(() => {
    cleanDir(baseDir);
  });

  it("creates deployment workspace with all artifacts", async () => {
    const result = await executor.execute({
      deploymentId: "test-deploy",
      projectId: "web-app",
      partitionId: "partition-1",
      environmentId: "env-prod",
      version: "2.0.0",
      variables: { APP_ENV: "production", DB_HOST: "db-1" },
      receivedAt: new Date().toISOString(),
    });

    expect(result.success).toBe(true);
    expect(result.artifacts).toContain("manifest.json");
    expect(result.artifacts).toContain("variables.env");
    expect(result.artifacts).toContain("VERSION");
    expect(result.artifacts).toContain("STATUS");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify files exist
    expect(fs.existsSync(path.join(result.workspacePath, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.workspacePath, "VERSION"))).toBe(true);

    // Verify content
    const version = fs.readFileSync(
      path.join(result.workspacePath, "VERSION"),
      "utf-8",
    );
    expect(version).toBe("web-app@2.0.0");

    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(result.workspacePath, "manifest.json"),
        "utf-8",
      ),
    );
    expect(manifest.version).toBe("2.0.0");
    expect(manifest.variables.APP_ENV).toBe("production");
  });

  it("verification passes for correct deployment", async () => {
    const execResult = await executor.execute({
      deploymentId: "test-deploy",
      projectId: "web-app",
      partitionId: "partition-1",
      environmentId: "env-prod",
      version: "2.0.0",
      variables: { APP_ENV: "production" },
      receivedAt: new Date().toISOString(),
    });

    const verification = executor.verify(
      execResult.workspacePath,
      "2.0.0",
      "web-app",
    );

    expect(verification.passed).toBe(true);
    expect(verification.checks.every((c) => c.passed)).toBe(true);
    expect(verification.checks.length).toBeGreaterThanOrEqual(4);
  });

  it("verification fails for missing workspace", () => {
    const verification = executor.verify("/nonexistent/path", "1.0", "app");
    expect(verification.passed).toBe(false);
    expect(verification.checks[0].name).toBe("workspace-exists");
    expect(verification.checks[0].passed).toBe(false);
  });

  it("verification detects wrong version", async () => {
    const execResult = await executor.execute({
      deploymentId: "test-deploy",
      projectId: "web-app",
      partitionId: "partition-1",
      environmentId: "env-prod",
      version: "2.0.0",
      variables: {},
      receivedAt: new Date().toISOString(),
    });

    const verification = executor.verify(
      execResult.workspacePath,
      "3.0.0", // wrong version
      "web-app",
    );

    expect(verification.passed).toBe(false);
    const versionCheck = verification.checks.find(
      (c) => c.name === "version-correct",
    );
    expect(versionCheck!.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 3: Environment Scanner
// ---------------------------------------------------------------------------

describe("EnvironmentScanner", () => {
  let baseDir: string;
  let state: LocalStateStore;
  let scanner: EnvironmentScanner;

  beforeEach(() => {
    baseDir = makeTmpDir();
    fs.mkdirSync(path.join(baseDir, "deployments"), { recursive: true });
    state = new LocalStateStore();
    scanner = new EnvironmentScanner(baseDir, state);
  });

  afterEach(() => {
    cleanDir(baseDir);
  });

  it("scans empty environment correctly", () => {
    const result = scanner.scan();
    expect(result.deploymentsWritable).toBe(true);
    expect(result.disk.workspaceExists).toBe(true);
    expect(result.disk.deploymentCount).toBe(0);
    expect(result.knownState.totalDeployments).toBe(0);
  });

  it("reports readiness when workspace exists", () => {
    const readiness = scanner.checkReadiness();
    expect(readiness.ready).toBe(true);
  });

  it("reports not ready when base dir missing", () => {
    const badScanner = new EnvironmentScanner("/nonexistent/path", state);
    const readiness = badScanner.checkReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toContain("does not exist");
  });

  it("counts deployment directories on disk", () => {
    // Create some deployment directories
    fs.mkdirSync(path.join(baseDir, "deployments", "d-1"));
    fs.mkdirSync(path.join(baseDir, "deployments", "d-2"));

    const result = scanner.scan();
    expect(result.disk.deploymentCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 4: EnvoyAgent — Full Local Pipeline
// ---------------------------------------------------------------------------

describe("EnvoyAgent — Local Pipeline", () => {
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

  it("executes a successful deployment end-to-end", async () => {
    const instruction = makeInstruction();
    const result = await agent.executeDeployment(instruction);

    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
    expect(result.artifacts).toContain("manifest.json");
    expect(result.artifacts).toContain("VERSION");
    expect(result.failureReason).toBeNull();
    expect(result.debriefEntryIds.length).toBeGreaterThanOrEqual(5);
  });

  it("records all pipeline steps to the Decision Diary", async () => {
    const instruction = makeInstruction({ deploymentId: "diary-test" });
    await agent.executeDeployment(instruction);

    const entries = diary.getByDeployment("diary-test");

    // Expect: receipt, scan, execution, verification, completion
    expect(entries.length).toBeGreaterThanOrEqual(5);

    // All entries should be from the envoy agent
    expect(entries.every((e) => e.agent === "envoy")).toBe(true);

    // All entries should reference this deployment
    expect(entries.every((e) => e.deploymentId === "diary-test")).toBe(true);

    // Check decision types present
    const types = entries.map((e) => e.decisionType);
    expect(types).toContain("pipeline-plan");
    expect(types).toContain("environment-scan");
    expect(types).toContain("deployment-execution");
    expect(types).toContain("deployment-verification");
    expect(types).toContain("deployment-completion");
  });

  it("diary entries have specific, actionable reasoning", async () => {
    const instruction = makeInstruction({ deploymentId: "reasoning-test" });
    await agent.executeDeployment(instruction);

    const entries = diary.getByDeployment("reasoning-test");

    for (const entry of entries) {
      // No empty reasoning
      expect(entry.reasoning.length).toBeGreaterThan(20);
      // No generic placeholders
      expect(entry.reasoning).not.toContain("TODO");
      expect(entry.reasoning).not.toContain("placeholder");
      // Every entry should reference something specific
      expect(
        entry.reasoning.includes("web-app") ||
        entry.reasoning.includes("2.0.0") ||
        entry.reasoning.includes("production") ||
        entry.reasoning.includes("Acme Corp") ||
        entry.reasoning.includes("workspace") ||
        entry.reasoning.includes("artifact"),
      ).toBe(true);
    }
  });

  it("updates local state after successful deployment", async () => {
    const instruction = makeInstruction({ deploymentId: "state-test" });
    await agent.executeDeployment(instruction);

    // Check deployment record
    const record = state.getDeployment("state-test");
    expect(record).toBeDefined();
    expect(record!.status).toBe("succeeded");
    expect(record!.completedAt).toBeInstanceOf(Date);

    // Check environment snapshot
    const env = state.getEnvironment("partition-1", "env-prod");
    expect(env).toBeDefined();
    expect(env!.currentVersion).toBe("2.0.0");
    expect(env!.currentDeploymentId).toBe("state-test");
    expect(env!.activeVariables.APP_ENV).toBe("production");
  });

  it("recognizes upgrade from previous version", async () => {
    // First deployment
    const first = makeInstruction({
      deploymentId: "upgrade-v1",
      version: "1.0.0",
    });
    await agent.executeDeployment(first);

    // Second deployment — should recognize as upgrade
    const second = makeInstruction({
      deploymentId: "upgrade-v2",
      version: "2.0.0",
    });
    const result = await agent.executeDeployment(second);

    expect(result.success).toBe(true);

    // The scan entry should mention upgrading from v1
    const entries = diary.getByDeployment("upgrade-v2");
    const scanEntry = entries.find((e) => e.decisionType === "environment-scan");
    expect(scanEntry).toBeDefined();
    expect(scanEntry!.decision).toContain("upgrading from v1.0.0");
    expect(scanEntry!.reasoning).toContain("v1.0.0");
  });

  it("first deployment is recognized as initial", async () => {
    const instruction = makeInstruction({ deploymentId: "first-deploy" });
    await agent.executeDeployment(instruction);

    const entries = diary.getByDeployment("first-deploy");
    const scanEntry = entries.find((e) => e.decisionType === "environment-scan");
    expect(scanEntry).toBeDefined();
    expect(scanEntry!.decision).toContain("first deployment");
  });

  it("health status is accurate", async () => {
    // Before any deployments
    const beforeStatus = agent.getStatus();
    expect(beforeStatus.healthy).toBe(true);
    expect(beforeStatus.summary.totalDeployments).toBe(0);

    // After a deployment
    await agent.executeDeployment(makeInstruction());
    const afterStatus = agent.getStatus();
    expect(afterStatus.healthy).toBe(true);
    expect(afterStatus.summary.totalDeployments).toBe(1);
    expect(afterStatus.summary.succeeded).toBe(1);
  });

  it("handles multiple partitions with isolation", async () => {
    const partitionA = makeInstruction({
      deploymentId: "d-a",
      partitionId: "partition-a",
      partitionName: "Alpha Corp",
    });
    const partitionB = makeInstruction({
      deploymentId: "d-b",
      partitionId: "partition-b",
      partitionName: "Beta Corp",
    });

    await agent.executeDeployment(partitionA);
    await agent.executeDeployment(partitionB);

    // Both succeeded
    expect(state.getDeployment("d-a")!.status).toBe("succeeded");
    expect(state.getDeployment("d-b")!.status).toBe("succeeded");

    // Diary entries are tagged correctly
    const aEntries = diary.getByPartition("partition-a");
    const bEntries = diary.getByPartition("partition-b");
    expect(aEntries.length).toBeGreaterThan(0);
    expect(bEntries.length).toBeGreaterThan(0);
    expect(aEntries.every((e) => e.partitionId === "partition-a")).toBe(true);
    expect(bEntries.every((e) => e.partitionId === "partition-b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 5: Envoy HTTP Server
// ---------------------------------------------------------------------------

describe("Envoy HTTP Server", () => {
  let baseDir: string;
  let diary: DecisionDebrief;
  let state: LocalStateStore;
  let agent: EnvoyAgent;
  let app: ReturnType<typeof createEnvoyServer>;

  beforeEach(async () => {
    baseDir = makeTmpDir();
    fs.mkdirSync(path.join(baseDir, "deployments"), { recursive: true });
    diary = new DecisionDebrief();
    state = new LocalStateStore();
    agent = new EnvoyAgent(diary, state, baseDir);
    app = createEnvoyServer(agent, state);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    cleanDir(baseDir);
  });

  it("GET /health returns healthy status", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.status).toBe("healthy");
    expect(body.service).toBe("deploystack-envoy");
    expect(body.hostname).toBeDefined();
    expect(body.readiness.ready).toBe(true);
  });

  it("POST /deploy executes a deployment", async () => {
    const instruction = makeInstruction({ deploymentId: "http-deploy" });
    const response = await app.inject({
      method: "POST",
      url: "/deploy",
      payload: instruction,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.deploymentId).toBe("http-deploy");
    expect(body.verificationPassed).toBe(true);
    expect(body.artifacts.length).toBeGreaterThan(0);
  });

  it("POST /deploy rejects invalid payload", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/deploy",
      payload: { invalid: true },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toContain("Invalid");
  });

  it("GET /status shows deployment after execution", async () => {
    await app.inject({
      method: "POST",
      url: "/deploy",
      payload: makeInstruction({ deploymentId: "status-deploy" }),
    });

    const response = await app.inject({ method: "GET", url: "/status" });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.healthy).toBe(true);
    expect(body.recentDeployments.length).toBe(1);
    expect(body.recentDeployments[0].deploymentId).toBe("status-deploy");
    expect(body.environments.length).toBe(1);
    expect(body.environments[0].currentVersion).toBe("2.0.0");
  });

  it("GET /deployments/:id returns deployment details", async () => {
    await app.inject({
      method: "POST",
      url: "/deploy",
      payload: makeInstruction({ deploymentId: "detail-deploy" }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/deployments/detail-deploy",
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.deploymentId).toBe("detail-deploy");
    expect(body.status).toBe("succeeded");
    expect(body.version).toBe("2.0.0");
  });

  it("GET /deployments/:id returns 404 for unknown deployment", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/deployments/nonexistent",
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Test Suite 6: Full Server → Envoy Deployment Cycle
// ---------------------------------------------------------------------------

describe("Full Deployment Cycle — Server triggers, Envoy executes", () => {
  let baseDir: string;
  let serverDiary: DecisionDebrief;
  let envoyDiary: DecisionDebrief;
  let state: LocalStateStore;
  let envoyAgent: EnvoyAgent;
  let app: ReturnType<typeof createEnvoyServer>;

  beforeEach(async () => {
    baseDir = makeTmpDir();
    fs.mkdirSync(path.join(baseDir, "deployments"), { recursive: true });
    serverDiary = new DecisionDebrief();
    envoyDiary = new DecisionDebrief();
    state = new LocalStateStore();
    envoyAgent = new EnvoyAgent(envoyDiary, state, baseDir);
    app = createEnvoyServer(envoyAgent, state);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    cleanDir(baseDir);
  });

  it("simulates complete Server→Envoy deployment flow", async () => {
    // Step 1: Server decides to deploy (simulated — we record the Server's decision)
    const deploymentId = "full-cycle-001";
    serverDiary.record({
      partitionId: "partition-1",
      deploymentId,
      agent: "server",
      decisionType: "pipeline-plan",
      decision: "Planned deployment pipeline: resolve-configuration → preflight-health-check → execute-deployment → post-deploy-verify",
      reasoning: "Server orchestrating deployment of web-app v3.0.0 to production",
      context: { projectId: "web-app", version: "3.0.0" },
    });

    // Step 2: Server checks Envoy health via HTTP
    const healthResponse = await app.inject({ method: "GET", url: "/health" });
    const health = JSON.parse(healthResponse.body);
    expect(health.status).toBe("healthy");
    expect(health.readiness.ready).toBe(true);

    // Step 3: Server delegates execution to Envoy via HTTP
    const deployResponse = await app.inject({
      method: "POST",
      url: "/deploy",
      payload: {
        deploymentId,
        partitionId: "partition-1",
        environmentId: "env-prod",
        projectId: "web-app",
        version: "3.0.0",
        variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
        environmentName: "production",
        partitionName: "Acme Corp",
      },
    });

    const deployResult = JSON.parse(deployResponse.body);
    expect(deployResult.success).toBe(true);
    expect(deployResult.verificationPassed).toBe(true);

    // Step 4: Server records Envoy's result (simulated)
    serverDiary.record({
      partitionId: "partition-1",
      deploymentId,
      agent: "server",
      decisionType: "deployment-completion",
      decision: `Envoy confirmed deployment: ${deployResult.artifacts.length} artifacts, all verification checks passed`,
      reasoning:
        `Envoy executed deployment of web-app v3.0.0 on production. ` +
        `Workspace: ${deployResult.workspacePath}. ` +
        `Execution took ${deployResult.executionDurationMs}ms. ` +
        `${deployResult.verificationChecks.length} verification checks all passed.`,
      context: {
        envoyResult: deployResult,
      },
    });

    // Verify: both diaries have entries for this deployment
    const serverEntries = serverDiary.getByDeployment(deploymentId);
    const envoyEntries = envoyDiary.getByDeployment(deploymentId);

    expect(serverEntries.length).toBeGreaterThanOrEqual(2);
    expect(envoyEntries.length).toBeGreaterThanOrEqual(5);

    // Server entries use "server" agent
    expect(serverEntries.every((e) => e.agent === "server")).toBe(true);
    // Envoy entries use "envoy" agent
    expect(envoyEntries.every((e) => e.agent === "envoy")).toBe(true);

    // Both reference the same deployment
    expect(serverEntries.every((e) => e.deploymentId === deploymentId)).toBe(true);
    expect(envoyEntries.every((e) => e.deploymentId === deploymentId)).toBe(true);
  });

  it("Envoy health check → deploy → status shows complete lifecycle", async () => {
    // Health check
    const h = await app.inject({ method: "GET", url: "/health" });
    expect(JSON.parse(h.body).summary.totalDeployments).toBe(0);

    // Deploy
    const d = await app.inject({
      method: "POST",
      url: "/deploy",
      payload: makeInstruction({ deploymentId: "lifecycle-001" }),
    });
    expect(JSON.parse(d.body).success).toBe(true);

    // Status reflects the deployment
    const s = await app.inject({ method: "GET", url: "/status" });
    const status = JSON.parse(s.body);
    expect(status.summary.totalDeployments).toBe(1);
    expect(status.summary.succeeded).toBe(1);
    expect(status.environments.length).toBe(1);
    expect(status.environments[0].currentVersion).toBe("2.0.0");

    // Deploy a second version — upgrade
    const d2 = await app.inject({
      method: "POST",
      url: "/deploy",
      payload: makeInstruction({
        deploymentId: "lifecycle-002",
        version: "3.0.0",
      }),
    });
    expect(JSON.parse(d2.body).success).toBe(true);

    // Status reflects the upgrade
    const s2 = await app.inject({ method: "GET", url: "/status" });
    const status2 = JSON.parse(s2.body);
    expect(status2.summary.totalDeployments).toBe(2);
    expect(status2.summary.succeeded).toBe(2);
    expect(status2.environments[0].currentVersion).toBe("3.0.0");
  });

  it("combined diary tells the complete story across both agents", async () => {
    const deploymentId = "combined-story";

    // Server plan
    serverDiary.record({
      partitionId: "partition-1",
      deploymentId,
      agent: "server",
      decisionType: "pipeline-plan",
      decision: "Planned deployment pipeline",
      reasoning: "Server orchestrating web-app v2.0.0 to production",
      context: {},
    });

    // Server config resolution
    serverDiary.record({
      partitionId: "partition-1",
      deploymentId,
      agent: "server",
      decisionType: "configuration-resolved",
      decision: "Configuration accepted",
      reasoning: "3 variables merged, no conflicts",
      context: {},
    });

    // Envoy executes
    await app.inject({
      method: "POST",
      url: "/deploy",
      payload: makeInstruction({ deploymentId }),
    });

    // Server records completion
    serverDiary.record({
      partitionId: "partition-1",
      deploymentId,
      agent: "server",
      decisionType: "deployment-completion",
      decision: "Deployment confirmed by Envoy",
      reasoning: "All checks passed",
      context: {},
    });

    // Combined view: server decisions + envoy decisions
    const serverEntries = serverDiary.getByDeployment(deploymentId);
    const envoyEntries = envoyDiary.getByDeployment(deploymentId);

    // Both diaries recorded entries for this deployment
    expect(serverEntries.length).toBeGreaterThanOrEqual(3);
    expect(envoyEntries.length).toBeGreaterThanOrEqual(5);

    // Server entries cover the orchestration story
    const serverTypes = serverEntries.map((e) => e.decisionType);
    expect(serverTypes).toContain("pipeline-plan");
    expect(serverTypes).toContain("configuration-resolved");
    expect(serverTypes).toContain("deployment-completion");

    // Envoy entries cover the local execution story
    const envoyTypes = envoyEntries.map((e) => e.decisionType);
    expect(envoyTypes).toContain("pipeline-plan");
    expect(envoyTypes).toContain("environment-scan");
    expect(envoyTypes).toContain("deployment-execution");
    expect(envoyTypes).toContain("deployment-verification");
    expect(envoyTypes).toContain("deployment-completion");

    // Together they tell the complete story — 8+ entries total
    const totalEntries = serverEntries.length + envoyEntries.length;
    expect(totalEntries).toBeGreaterThanOrEqual(8);

    // Agent attribution is correct
    expect(serverEntries.every((e) => e.agent === "server")).toBe(true);
    expect(envoyEntries.every((e) => e.agent === "envoy")).toBe(true);

    // The server's final entry references Envoy completion
    const serverCompletion = serverEntries.find(
      (e) => e.decisionType === "deployment-completion",
    );
    expect(serverCompletion).toBeDefined();
    expect(serverCompletion!.decision).toContain("confirmed");
  });
});
