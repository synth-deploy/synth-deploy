import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DeploymentExecutor } from "../src/agent/deployment-executor.js";
import type { DeploymentManifest } from "../src/agent/deployment-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "executor-test-"));
}

function cleanDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function makeManifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    deploymentId: `deploy-${Date.now()}`,
    operationId: "web-app",
    partitionId: "partition-1",
    environmentId: "env-prod",
    version: "2.0.0",
    variables: { APP_ENV: "production", DB_HOST: "db-1" },
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

describe("DeploymentExecutor — execute()", () => {
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

  it("creates workspace directory under deployments/", async () => {
    const manifest = makeManifest({ deploymentId: "exec-ws" });
    const result = await executor.execute(manifest);
    expect(result.success).toBe(true);
    expect(fs.existsSync(result.workspacePath)).toBe(true);
    expect(result.workspacePath).toContain("exec-ws");
  });

  it("writes manifest.json with correct content", async () => {
    const manifest = makeManifest({ deploymentId: "exec-manifest" });
    const result = await executor.execute(manifest);
    expect(result.artifacts).toContain("manifest.json");

    const content = JSON.parse(
      fs.readFileSync(path.join(result.workspacePath, "manifest.json"), "utf-8"),
    );
    expect(content.deploymentId).toBe("exec-manifest");
    expect(content.operationId).toBe("web-app");
    expect(content.version).toBe("2.0.0");
    expect(content.variables.APP_ENV).toBe("production");
    expect(content.variables.DB_HOST).toBe("db-1");
  });

  it("writes variables.env with key=value pairs", async () => {
    const manifest = makeManifest({
      deploymentId: "exec-vars",
      variables: { FOO: "bar", BAZ: "qux" },
    });
    const result = await executor.execute(manifest);
    expect(result.artifacts).toContain("variables.env");

    const content = fs.readFileSync(
      path.join(result.workspacePath, "variables.env"),
      "utf-8",
    );
    expect(content).toContain("FOO=bar");
    expect(content).toContain("BAZ=qux");
  });

  it("writes VERSION file with operationId@version", async () => {
    const manifest = makeManifest({ deploymentId: "exec-version" });
    const result = await executor.execute(manifest);
    expect(result.artifacts).toContain("VERSION");

    const content = fs.readFileSync(
      path.join(result.workspacePath, "VERSION"),
      "utf-8",
    );
    expect(content).toBe("web-app@2.0.0");
  });

  it("writes STATUS file with DEPLOYED", async () => {
    const manifest = makeManifest({ deploymentId: "exec-status" });
    const result = await executor.execute(manifest);
    expect(result.artifacts).toContain("STATUS");

    const content = fs.readFileSync(
      path.join(result.workspacePath, "STATUS"),
      "utf-8",
    );
    expect(content).toBe("DEPLOYED");
  });

  it("returns all four artifacts", async () => {
    const result = await executor.execute(makeManifest());
    expect(result.artifacts).toEqual(["manifest.json", "variables.env", "VERSION", "STATUS"]);
  });

  it("reports non-negative durationMs", async () => {
    const result = await executor.execute(makeManifest());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error: null on success", async () => {
    const result = await executor.execute(makeManifest());
    expect(result.error).toBeNull();
  });

  it("handles empty variables", async () => {
    const manifest = makeManifest({ deploymentId: "exec-empty-vars", variables: {} });
    const result = await executor.execute(manifest);
    expect(result.success).toBe(true);
    const content = fs.readFileSync(
      path.join(result.workspacePath, "variables.env"),
      "utf-8",
    );
    expect(content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// verify()
// ---------------------------------------------------------------------------

describe("DeploymentExecutor — verify()", () => {
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

  it("passes for a valid deployment workspace", async () => {
    const manifest = makeManifest({ deploymentId: "verify-valid" });
    const execResult = await executor.execute(manifest);
    const verification = executor.verify(execResult.workspacePath, "2.0.0", "web-app");

    expect(verification.passed).toBe(true);
    expect(verification.checks.length).toBeGreaterThanOrEqual(4);
    expect(verification.checks.every((c) => c.passed)).toBe(true);
  });

  it("fails for nonexistent workspace", () => {
    const verification = executor.verify("/nonexistent/path", "1.0.0", "app");
    expect(verification.passed).toBe(false);
    expect(verification.checks[0].name).toBe("workspace-exists");
    expect(verification.checks[0].passed).toBe(false);
  });

  it("fails when VERSION file has wrong content", async () => {
    const manifest = makeManifest({ deploymentId: "verify-wrong-ver" });
    const execResult = await executor.execute(manifest);

    // Overwrite VERSION with incorrect content
    fs.writeFileSync(path.join(execResult.workspacePath, "VERSION"), "wrong@0.0.0");

    const verification = executor.verify(execResult.workspacePath, "2.0.0", "web-app");
    expect(verification.passed).toBe(false);
    const versionCheck = verification.checks.find((c) => c.name === "version-correct");
    expect(versionCheck).toBeDefined();
    expect(versionCheck!.passed).toBe(false);
  });

  it("fails when manifest.json is missing", async () => {
    const manifest = makeManifest({ deploymentId: "verify-no-manifest" });
    const execResult = await executor.execute(manifest);
    fs.unlinkSync(path.join(execResult.workspacePath, "manifest.json"));

    const verification = executor.verify(execResult.workspacePath, "2.0.0", "web-app");
    expect(verification.passed).toBe(false);
    const manifestCheck = verification.checks.find((c) => c.name === "manifest-present");
    expect(manifestCheck!.passed).toBe(false);
  });

  it("fails when STATUS file is missing", async () => {
    const manifest = makeManifest({ deploymentId: "verify-no-status" });
    const execResult = await executor.execute(manifest);
    fs.unlinkSync(path.join(execResult.workspacePath, "STATUS"));

    const verification = executor.verify(execResult.workspacePath, "2.0.0", "web-app");
    expect(verification.passed).toBe(false);
  });

  it("fails when variables.env is missing", async () => {
    const manifest = makeManifest({ deploymentId: "verify-no-vars" });
    const execResult = await executor.execute(manifest);
    fs.unlinkSync(path.join(execResult.workspacePath, "variables.env"));

    const verification = executor.verify(execResult.workspacePath, "2.0.0", "web-app");
    expect(verification.passed).toBe(false);
    const varsCheck = verification.checks.find((c) => c.name === "variables-present");
    expect(varsCheck!.passed).toBe(false);
  });

  it("check details contain human-readable explanations", async () => {
    const manifest = makeManifest({ deploymentId: "verify-details" });
    const execResult = await executor.execute(manifest);
    const verification = executor.verify(execResult.workspacePath, "2.0.0", "web-app");

    for (const check of verification.checks) {
      expect(check.detail.length).toBeGreaterThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
// cleanupOldWorkspaces()
// ---------------------------------------------------------------------------

describe("DeploymentExecutor — cleanupOldWorkspaces()", () => {
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

  it("removes directories older than maxAgeMs", () => {
    // Create an "old" deployment workspace
    const oldDir = path.join(baseDir, "deployments", "old-deploy");
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, "VERSION"), "app@1.0.0");

    // Set its mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldDir, twoHoursAgo, twoHoursAgo);

    // Create a "recent" deployment workspace
    const recentDir = path.join(baseDir, "deployments", "recent-deploy");
    fs.mkdirSync(recentDir);
    fs.writeFileSync(path.join(recentDir, "VERSION"), "app@2.0.0");

    // Cleanup with maxAge of 1 hour, high maxCount so only age matters
    const removed = executor.cleanupOldWorkspaces(60 * 60 * 1000, 100);

    expect(removed).toBe(1);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(recentDir)).toBe(true);
  });

  it("removes directories beyond maxCount even if recent", () => {
    const deploymentsDir = path.join(baseDir, "deployments");

    // Create 5 recent directories
    for (let i = 0; i < 5; i++) {
      const dir = path.join(deploymentsDir, `deploy-${i}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "STATUS"), "DEPLOYED");
    }

    // Keep only 2 — should remove 3
    const removed = executor.cleanupOldWorkspaces(999_999_999, 2);
    expect(removed).toBe(3);
  });

  it("keeps recent directories untouched", () => {
    const recentDir = path.join(baseDir, "deployments", "keep-me");
    fs.mkdirSync(recentDir);
    fs.writeFileSync(path.join(recentDir, "STATUS"), "DEPLOYED");

    const removed = executor.cleanupOldWorkspaces(60 * 60 * 1000, 100);
    expect(removed).toBe(0);
    expect(fs.existsSync(recentDir)).toBe(true);
  });

  it("returns 0 when no deployments directory exists", () => {
    const emptyExecutor = new DeploymentExecutor("/nonexistent/base");
    const removed = emptyExecutor.cleanupOldWorkspaces(1000, 100);
    expect(removed).toBe(0);
  });

  it("returns 0 when deployments directory is empty", () => {
    const removed = executor.cleanupOldWorkspaces(1000, 100);
    expect(removed).toBe(0);
  });

  it("removes multiple old directories at once", () => {
    const deploymentsDir = path.join(baseDir, "deployments");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

    for (const name of ["old-a", "old-b", "old-c"]) {
      const dir = path.join(deploymentsDir, name);
      fs.mkdirSync(dir);
      fs.utimesSync(dir, twoHoursAgo, twoHoursAgo);
    }

    const removed = executor.cleanupOldWorkspaces(60 * 60 * 1000, 100);
    expect(removed).toBe(3);
  });
});
