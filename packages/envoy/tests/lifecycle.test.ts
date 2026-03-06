import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DecisionDebrief } from "@synth-deploy/core";
import { EnvoyAgent } from "../src/agent/envoy-agent.js";
import type { DeploymentInstruction } from "../src/agent/envoy-agent.js";
import { LocalStateStore } from "../src/state/local-state.js";
import { createEnvoyServer } from "../src/server.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "envoy-lifecycle-test-"));
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
    operationId: "web-app",
    version: "2.0.0",
    variables: { APP_ENV: "production", LOG_LEVEL: "warn", DB_HOST: "db-1" },
    environmentName: "production",
    partitionName: "Acme Corp",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite: EnvoyAgent Lifecycle State
// ---------------------------------------------------------------------------

describe("EnvoyAgent — Lifecycle State", () => {
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

  it("defaults to active lifecycle state", () => {
    expect(agent.lifecycleState).toBe("active");
  });

  it("drain() sets state to draining", () => {
    agent.drain();
    expect(agent.lifecycleState).toBe("draining");
  });

  it("pause() sets state to paused", () => {
    agent.pause();
    expect(agent.lifecycleState).toBe("paused");
  });

  it("resume() restores state to active", () => {
    agent.drain();
    expect(agent.lifecycleState).toBe("draining");
    agent.resume();
    expect(agent.lifecycleState).toBe("active");
  });

  it("resume() works from paused state", () => {
    agent.pause();
    expect(agent.lifecycleState).toBe("paused");
    agent.resume();
    expect(agent.lifecycleState).toBe("active");
  });

  it("rejects new deployments when draining", async () => {
    agent.drain();
    const instruction = makeInstruction({ deploymentId: "drain-reject" });
    const result = await agent.executeDeployment(instruction);

    expect(result.success).toBe(false);
    expect(result.failureReason).toContain("draining");
    expect(result.workspacePath).toBe("");
    expect(result.artifacts).toHaveLength(0);
  });

  it("rejects new deployments when paused", async () => {
    agent.pause();
    const instruction = makeInstruction({ deploymentId: "pause-reject" });
    const result = await agent.executeDeployment(instruction);

    expect(result.success).toBe(false);
    expect(result.failureReason).toContain("paused");
    expect(result.workspacePath).toBe("");
    expect(result.artifacts).toHaveLength(0);
  });

  it("accepts deployments after resume from draining", async () => {
    agent.drain();
    agent.resume();

    const instruction = makeInstruction({ deploymentId: "drain-resume" });
    const result = await agent.executeDeployment(instruction);

    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
  });

  it("accepts deployments after resume from paused", async () => {
    agent.pause();
    agent.resume();

    const instruction = makeInstruction({ deploymentId: "pause-resume" });
    const result = await agent.executeDeployment(instruction);

    expect(result.success).toBe(true);
    expect(result.verificationPassed).toBe(true);
  });

  it("getStatus() includes lifecycle state", () => {
    expect(agent.getStatus().lifecycle).toBe("active");

    agent.drain();
    expect(agent.getStatus().lifecycle).toBe("draining");

    agent.pause();
    expect(agent.getStatus().lifecycle).toBe("paused");

    agent.resume();
    expect(agent.getStatus().lifecycle).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Lifecycle HTTP Endpoints
// ---------------------------------------------------------------------------

describe("Envoy HTTP Server — Lifecycle Endpoints", () => {
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

  it("GET /lifecycle returns active state by default", async () => {
    const response = await app.inject({ method: "GET", url: "/lifecycle" });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.state).toBe("active");
    expect(body.inFlightDeployments).toBe(0);
  });

  it("POST /lifecycle/drain sets state to draining", async () => {
    const response = await app.inject({ method: "POST", url: "/lifecycle/drain" });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.state).toBe("draining");
  });

  it("POST /lifecycle/pause sets state to paused", async () => {
    const response = await app.inject({ method: "POST", url: "/lifecycle/pause" });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.state).toBe("paused");
  });

  it("POST /lifecycle/resume restores state to active", async () => {
    // Drain first
    await app.inject({ method: "POST", url: "/lifecycle/drain" });

    // Resume
    const response = await app.inject({ method: "POST", url: "/lifecycle/resume" });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body);
    expect(body.state).toBe("active");
  });

  it("GET /lifecycle reflects current state after transitions", async () => {
    await app.inject({ method: "POST", url: "/lifecycle/pause" });

    const response = await app.inject({ method: "GET", url: "/lifecycle" });
    const body = JSON.parse(response.body);
    expect(body.state).toBe("paused");
  });

  it("POST /deploy is rejected when draining", async () => {
    await app.inject({ method: "POST", url: "/lifecycle/drain" });

    const instruction = makeInstruction({ deploymentId: "http-drain-reject" });
    const response = await app.inject({
      method: "POST",
      url: "/deploy",
      payload: instruction,
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.failureReason).toContain("draining");
  });

  it("POST /deploy is rejected when paused", async () => {
    await app.inject({ method: "POST", url: "/lifecycle/pause" });

    const instruction = makeInstruction({ deploymentId: "http-pause-reject" });
    const response = await app.inject({
      method: "POST",
      url: "/deploy",
      payload: instruction,
    });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.failureReason).toContain("paused");
  });

  it("POST /deploy succeeds after resume", async () => {
    // Pause and resume
    await app.inject({ method: "POST", url: "/lifecycle/pause" });
    await app.inject({ method: "POST", url: "/lifecycle/resume" });

    const instruction = makeInstruction({ deploymentId: "http-resume-deploy" });
    const response = await app.inject({
      method: "POST",
      url: "/deploy",
      payload: instruction,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it("GET /health includes lifecycle state", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(response.body);
    expect(body.lifecycle).toBe("active");

    // Change lifecycle and verify health reflects it
    await app.inject({ method: "POST", url: "/lifecycle/drain" });
    const drainHealth = await app.inject({ method: "GET", url: "/health" });
    const drainBody = JSON.parse(drainHealth.body);
    expect(drainBody.lifecycle).toBe("draining");
  });
});
