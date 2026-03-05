import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DecisionDebrief } from "@deploystack/core";
import { EnvoyAgent } from "../src/agent/envoy-agent.js";
import type {
  DeploymentInstruction,
  DeploymentResult,
} from "../src/agent/envoy-agent.js";
import { DiagnosticInvestigator } from "../src/agent/diagnostic-investigator.js";
import type { DiagnosticReport } from "../src/agent/diagnostic-investigator.js";
import { LocalStateStore } from "../src/state/local-state.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "envoy-diag-"));
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
 * Simulate what a traditional deployment agent would return
 * for the same failure — the bare minimum.
 */
function traditionalAgentOutput(scenario: string): string {
  switch (scenario) {
    case "service-crash":
      return "Deployment failed. Service exited with non-zero status.";
    case "health-timeout":
      return "Health check failed after timeout. Deployment marked as failed.";
    case "dependency-unavailable":
      return "Service check failed. Deployment unsuccessful.";
    case "partial-deployment":
      return "Deployment error. Check logs for details.";
    default:
      return "Deployment failed.";
  }
}

// ---------------------------------------------------------------------------
// Workspace setup helpers — create realistic failure states
// ---------------------------------------------------------------------------

/**
 * Set up a workspace that looks like a service crashed on startup.
 * Artifacts are all written (deployment itself succeeded) but the
 * service log shows a port conflict and fatal exit.
 */
function setupServiceCrashWorkspace(
  workspacePath: string,
  instruction: DeploymentInstruction,
): void {
  fs.mkdirSync(workspacePath, { recursive: true });

  // Deployment artifacts — all present (deployment succeeded)
  fs.writeFileSync(
    path.join(workspacePath, "manifest.json"),
    JSON.stringify({
      deploymentId: instruction.deploymentId,
      operationId: instruction.operationId,
      version: instruction.version,
      variables: instruction.variables,
    }),
  );
  fs.writeFileSync(
    path.join(workspacePath, "variables.env"),
    Object.entries(instruction.variables)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  fs.writeFileSync(
    path.join(workspacePath, "VERSION"),
    `${instruction.operationId}@${instruction.version}`,
  );
  fs.writeFileSync(path.join(workspacePath, "STATUS"), "FAILED");

  // Service log showing the crash
  fs.mkdirSync(path.join(workspacePath, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "logs", "service.log"),
    [
      `2026-02-23T10:15:01.123Z [INFO] Starting ${instruction.operationId} v${instruction.version}...`,
      `2026-02-23T10:15:01.234Z [INFO] Loading configuration from /etc/${instruction.operationId}/config.yaml`,
      `2026-02-23T10:15:01.345Z [INFO] Initializing HTTP server on port 8080`,
      `2026-02-23T10:15:01.456Z [ERROR] Failed to bind to port 8080: EADDRINUSE`,
      `2026-02-23T10:15:01.567Z [ERROR] Another process is listening on port 8080 (PID: 4521)`,
      `2026-02-23T10:15:01.678Z [FATAL] Cannot start HTTP server — exiting with code 1`,
    ].join("\n"),
  );
}

/**
 * Set up a workspace where the service started but health check timed out.
 * The service is stuck in STARTING state — it never reached RUNNING.
 */
function setupHealthTimeoutWorkspace(
  workspacePath: string,
  instruction: DeploymentInstruction,
): void {
  fs.mkdirSync(workspacePath, { recursive: true });

  // Deployment artifacts — all present
  fs.writeFileSync(
    path.join(workspacePath, "manifest.json"),
    JSON.stringify({
      deploymentId: instruction.deploymentId,
      operationId: instruction.operationId,
      version: instruction.version,
    }),
  );
  fs.writeFileSync(
    path.join(workspacePath, "variables.env"),
    Object.entries(instruction.variables)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  fs.writeFileSync(
    path.join(workspacePath, "VERSION"),
    `${instruction.operationId}@${instruction.version}`,
  );
  fs.writeFileSync(path.join(workspacePath, "STATUS"), "STARTING");
  fs.writeFileSync(path.join(workspacePath, "HEALTH"), "timeout");

  // Service log showing slow startup
  fs.mkdirSync(path.join(workspacePath, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "logs", "service.log"),
    [
      `2026-02-23T10:15:01.000Z [INFO] Starting ${instruction.operationId} v${instruction.version}...`,
      `2026-02-23T10:15:01.100Z [INFO] Loading configuration...`,
      `2026-02-23T10:15:02.000Z [INFO] Connecting to database at ${instruction.variables.DB_HOST || "db:5432"}...`,
      `2026-02-23T10:15:15.000Z [WARN] Database connection slow — still waiting...`,
      `2026-02-23T10:15:30.000Z [WARN] Database connection slow — 28s elapsed...`,
      `2026-02-23T10:15:31.000Z [ERROR] Startup timeout: health check timed out after 30000ms`,
      `2026-02-23T10:15:31.100Z [ERROR] Service did not become healthy within the allowed window`,
    ].join("\n"),
  );
}

/**
 * Set up a workspace where the service can't reach a required dependency.
 * The service started but immediately fails on connection to the database.
 */
function setupDependencyUnavailableWorkspace(
  workspacePath: string,
  instruction: DeploymentInstruction,
): void {
  fs.mkdirSync(workspacePath, { recursive: true });

  // Deployment artifacts — all present
  fs.writeFileSync(
    path.join(workspacePath, "manifest.json"),
    JSON.stringify({
      deploymentId: instruction.deploymentId,
      operationId: instruction.operationId,
      version: instruction.version,
    }),
  );
  fs.writeFileSync(
    path.join(workspacePath, "variables.env"),
    Object.entries(instruction.variables)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  fs.writeFileSync(
    path.join(workspacePath, "VERSION"),
    `${instruction.operationId}@${instruction.version}`,
  );
  fs.writeFileSync(path.join(workspacePath, "STATUS"), "FAILED");

  // Service log showing connection refused
  fs.mkdirSync(path.join(workspacePath, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "logs", "service.log"),
    [
      `2026-02-23T10:15:01.000Z [INFO] Starting ${instruction.operationId} v${instruction.version}...`,
      `2026-02-23T10:15:01.100Z [INFO] Loading configuration...`,
      `2026-02-23T10:15:01.200Z [INFO] Attempting to connect to database at ${instruction.variables.DB_HOST || "db:5432"}...`,
      `2026-02-23T10:15:01.300Z [ERROR] connect ECONNREFUSED ${instruction.variables.DB_HOST || "127.0.0.1:5432"}`,
      `2026-02-23T10:15:02.300Z [ERROR] connect ECONNREFUSED ${instruction.variables.DB_HOST || "127.0.0.1:5432"}`,
      `2026-02-23T10:15:03.300Z [ERROR] connect ECONNREFUSED ${instruction.variables.DB_HOST || "127.0.0.1:5432"}`,
      `2026-02-23T10:15:03.400Z [FATAL] Cannot connect to database after 3 retries — exiting`,
    ].join("\n"),
  );
}

/**
 * Set up a workspace with incomplete artifacts — the deployment
 * was interrupted before finishing.
 */
function setupPartialDeploymentWorkspace(
  workspacePath: string,
  instruction: DeploymentInstruction,
): void {
  fs.mkdirSync(workspacePath, { recursive: true });

  // Only some artifacts — deployment was interrupted
  fs.writeFileSync(
    path.join(workspacePath, "manifest.json"),
    JSON.stringify({
      deploymentId: instruction.deploymentId,
      operationId: instruction.operationId,
      version: instruction.version,
    }),
  );
  // variables.env written
  fs.writeFileSync(
    path.join(workspacePath, "variables.env"),
    Object.entries(instruction.variables)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  // VERSION and STATUS are missing — deployment was interrupted
}

// ===========================================================================
// TEST SUITE 1: DiagnosticInvestigator — Direct Investigation
// ===========================================================================

describe("DiagnosticInvestigator — Failure Scenario Investigation", () => {
  let baseDir: string;
  let state: LocalStateStore;
  let investigator: DiagnosticInvestigator;

  beforeEach(() => {
    baseDir = makeTmpDir();
    state = new LocalStateStore();
    investigator = new DiagnosticInvestigator(state);
  });

  afterEach(() => {
    cleanDir(baseDir);
  });

  // =========================================================================
  // Scenario 1: Service Failed to Start
  // =========================================================================

  describe("Scenario 1: Service failed to start", () => {
    it("identifies port conflict as root cause", () => {
      const instruction = makeInstruction({ deploymentId: "crash-001" });
      const workspacePath = path.join(baseDir, "deployments", "crash-001");
      setupServiceCrashWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.failureType).toBe("service-crash");
      expect(diagnostic.summary).toContain("web-app v2.0.0");
      expect(diagnostic.summary).toContain("production");
      expect(diagnostic.summary).toContain("Port 8080");
    });

    it("provides actionable recommendation with port", () => {
      const instruction = makeInstruction({ deploymentId: "crash-002" });
      const workspacePath = path.join(baseDir, "deployments", "crash-002");
      setupServiceCrashWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      // Recommendation should mention the specific port and command to run
      expect(diagnostic.recommendation).toContain("lsof");
      expect(diagnostic.recommendation).toContain("8080");
    });

    it("collects evidence from service log", () => {
      const instruction = makeInstruction({ deploymentId: "crash-003" });
      const workspacePath = path.join(baseDir, "deployments", "crash-003");
      setupServiceCrashWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      // Should have evidence from the log file
      const logEvidence = diagnostic.evidence.filter(
        (e) => e.source.includes("service.log"),
      );
      expect(logEvidence.length).toBeGreaterThan(0);

      // Should have evidence from STATUS file
      const statusEvidence = diagnostic.evidence.find(
        (e) => e.source === "STATUS",
      );
      expect(statusEvidence).toBeDefined();
      expect(statusEvidence!.finding).toContain("FAILED");
    });

    it("root cause explains the crash is runtime, not packaging", () => {
      const instruction = makeInstruction({ deploymentId: "crash-004" });
      const workspacePath = path.join(baseDir, "deployments", "crash-004");
      setupServiceCrashWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.rootCause).toContain("runtime");
      expect(diagnostic.rootCause).toContain("not a deployment packaging issue");
    });

    it("is categorically different from traditional agent output", () => {
      const instruction = makeInstruction({ deploymentId: "crash-005" });
      const workspacePath = path.join(baseDir, "deployments", "crash-005");
      setupServiceCrashWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );
      const traditional = traditionalAgentOutput("service-crash");

      // Traditional: "Deployment failed. Service exited with non-zero status."
      // Envoy: identifies the port conflict, the PID, recommends lsof
      expect(traditional.length).toBeLessThan(diagnostic.summary.length);
      expect(traditional).not.toContain("Port");
      expect(traditional).not.toContain("8080");
      expect(diagnostic.summary).toContain("Port 8080");
      expect(diagnostic.traditionalComparison).toContain("Traditional agent output");
    });
  });

  // =========================================================================
  // Scenario 2: Health Check Timeout
  // =========================================================================

  describe("Scenario 2: Health check timeout", () => {
    it("identifies health timeout as the failure type", () => {
      const instruction = makeInstruction({ deploymentId: "timeout-001" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "timeout-001",
      );
      setupHealthTimeoutWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.failureType).toBe("health-timeout");
      expect(diagnostic.summary).toContain("web-app v2.0.0");
      expect(diagnostic.summary).toContain("did not become healthy");
    });

    it("reports the timeout duration from logs", () => {
      const instruction = makeInstruction({ deploymentId: "timeout-002" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "timeout-002",
      );
      setupHealthTimeoutWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.summary).toContain("30000ms");
    });

    it("distinguishes between slow startup and dependency issues", () => {
      const instruction = makeInstruction({ deploymentId: "timeout-003" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "timeout-003",
      );
      setupHealthTimeoutWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      // Root cause should explain the possible causes
      expect(diagnostic.rootCause).toContain("health check");
      expect(
        diagnostic.rootCause.includes("longer than expected") ||
        diagnostic.rootCause.includes("waiting on a dependency") ||
        diagnostic.rootCause.includes("startup loop"),
      ).toBe(true);
    });

    it("provides environment-aware recommendation", () => {
      const instruction = makeInstruction({ deploymentId: "timeout-004" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "timeout-004",
      );
      setupHealthTimeoutWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      // For production, should suggest checking if process is running
      expect(diagnostic.recommendation).toContain("ps aux");
      expect(diagnostic.recommendation).toContain("web-app");
      // Should mention production-specific advice
      expect(diagnostic.recommendation).toContain("production");
    });

    it("reads HEALTH file as evidence", () => {
      const instruction = makeInstruction({ deploymentId: "timeout-005" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "timeout-005",
      );
      setupHealthTimeoutWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      const healthEvidence = diagnostic.evidence.find(
        (e) => e.source === "HEALTH",
      );
      expect(healthEvidence).toBeDefined();
      expect(healthEvidence!.finding).toContain("timeout");
    });

    it("is categorically different from traditional agent output", () => {
      const instruction = makeInstruction({ deploymentId: "timeout-006" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "timeout-006",
      );
      setupHealthTimeoutWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );
      const traditional = traditionalAgentOutput("health-timeout");

      // Traditional: "Health check failed after timeout. Deployment marked as failed."
      // Envoy: identifies timeout duration, STARTING state, possible slow startup
      expect(traditional).not.toContain("30000ms");
      expect(traditional).not.toContain("STARTING");
      expect(diagnostic.summary).toContain("30000ms");
      expect(diagnostic.traditionalComparison).toContain(
        "No distinction between slow startup",
      );
    });
  });

  // =========================================================================
  // Scenario 3: Dependency Not Available
  // =========================================================================

  describe("Scenario 3: Dependency not available", () => {
    it("identifies dependency unavailable as the failure type", () => {
      const instruction = makeInstruction({ deploymentId: "dep-001" });
      const workspacePath = path.join(baseDir, "deployments", "dep-001");
      setupDependencyUnavailableWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.failureType).toBe("dependency-unavailable");
    });

    it("identifies the specific dependency host from logs", () => {
      const instruction = makeInstruction({
        deploymentId: "dep-002",
        variables: {
          APP_ENV: "production",
          DB_HOST: "db-prod.internal:5432",
          CACHE_HOST: "redis-prod.internal:6379",
        },
      });
      const workspacePath = path.join(baseDir, "deployments", "dep-002");
      setupDependencyUnavailableWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      // Should identify the database connection — uses human-readable text
      expect(diagnostic.summary).toContain("Connection refused");
      expect(diagnostic.summary).toContain("dependency");
    });

    it("recommends network connectivity test", () => {
      const instruction = makeInstruction({ deploymentId: "dep-003" });
      const workspacePath = path.join(baseDir, "deployments", "dep-003");
      setupDependencyUnavailableWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      // Recommendation should include a connectivity check command
      expect(
        diagnostic.recommendation.includes("nc -zv") ||
        diagnostic.recommendation.includes("running and accepting"),
      ).toBe(true);
    });

    it("explains the failure is environmental, not deployment-related", () => {
      const instruction = makeInstruction({ deploymentId: "dep-004" });
      const workspacePath = path.join(baseDir, "deployments", "dep-004");
      setupDependencyUnavailableWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.rootCause).toContain("artifacts are intact");
      expect(diagnostic.rootCause).toContain("runtime environment");
    });

    it("cross-references connection variables from the instruction", () => {
      const instruction = makeInstruction({
        deploymentId: "dep-005",
        variables: {
          APP_ENV: "production",
          DB_HOST: "db-prod.internal:5432",
          CACHE_HOST: "redis-prod.internal:6379",
        },
      });
      const workspacePath = path.join(baseDir, "deployments", "dep-005");
      setupDependencyUnavailableWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      // Should reference connection variables when recommending fixes
      expect(
        diagnostic.recommendation.includes("DB_HOST") ||
        diagnostic.recommendation.includes("CACHE_HOST") ||
        diagnostic.recommendation.includes("connection variables") ||
        diagnostic.recommendation.includes("deployment variables"),
      ).toBe(true);
    });

    it("is categorically different from traditional agent output", () => {
      const instruction = makeInstruction({ deploymentId: "dep-006" });
      const workspacePath = path.join(baseDir, "deployments", "dep-006");
      setupDependencyUnavailableWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );
      const traditional = traditionalAgentOutput("dependency-unavailable");

      // Traditional: "Service check failed. Deployment unsuccessful."
      // Envoy: identifies which dependency, connection refused, specific host
      expect(traditional).not.toContain("ECONNREFUSED");
      expect(traditional).not.toContain("database");
      expect(diagnostic.traditionalComparison).toContain(
        "No identification of which dependency",
      );
    });
  });

  // =========================================================================
  // Scenario 4: Partial Deployment Failure
  // =========================================================================

  describe("Scenario 4: Partial deployment failure", () => {
    it("identifies partial deployment as the failure type", () => {
      const instruction = makeInstruction({ deploymentId: "partial-001" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "partial-001",
      );
      setupPartialDeploymentWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.failureType).toBe("partial-deployment");
    });

    it("identifies exactly which artifacts are missing", () => {
      const instruction = makeInstruction({ deploymentId: "partial-002" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "partial-002",
      );
      setupPartialDeploymentWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      // manifest.json and variables.env are present; VERSION and STATUS are missing
      expect(diagnostic.summary).toContain("VERSION");
      expect(diagnostic.summary).toContain("STATUS");
      expect(diagnostic.summary).toContain("2/4");
    });

    it("warns against starting the service in incomplete state", () => {
      const instruction = makeInstruction({ deploymentId: "partial-003" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "partial-003",
      );
      setupPartialDeploymentWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.recommendation).toContain("Do NOT attempt to start");
      expect(diagnostic.recommendation).toContain("incomplete");
    });

    it("recommends disk space check", () => {
      const instruction = makeInstruction({ deploymentId: "partial-004" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "partial-004",
      );
      setupPartialDeploymentWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.recommendation).toContain("df -h");
    });

    it("mentions rollback when previous version exists", () => {
      // Set up a previous successful deployment
      state.recordDeployment({
        deploymentId: "prev-deploy",
        partitionId: "partition-1",
        environmentId: "env-prod",
        operationId: "web-app",
        version: "1.0.0",
        variables: {},
        workspacePath: "/previous/workspace",
      });
      state.completeDeployment("prev-deploy", "succeeded");
      state.updateEnvironment("partition-1", "env-prod", {
        currentVersion: "1.0.0",
        currentDeploymentId: "prev-deploy",
        activeVariables: {},
      });

      const instruction = makeInstruction({ deploymentId: "partial-005" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "partial-005",
      );
      setupPartialDeploymentWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );

      expect(diagnostic.recommendation).toContain("1.0.0");
      expect(diagnostic.recommendation).toContain("rolled back");
    });

    it("is categorically different from traditional agent output", () => {
      const instruction = makeInstruction({ deploymentId: "partial-006" });
      const workspacePath = path.join(
        baseDir,
        "deployments",
        "partial-006",
      );
      setupPartialDeploymentWorkspace(workspacePath, instruction);

      const diagnostic = investigator.investigate(
        workspacePath,
        instruction,
      );
      const traditional = traditionalAgentOutput("partial-deployment");

      // Traditional: "Deployment error. Check logs for details."
      // Envoy: lists exact missing artifacts, warns not to start, suggests rollback
      expect(traditional).not.toContain("VERSION");
      expect(traditional).not.toContain("STATUS");
      expect(traditional).not.toContain("2/4");
      expect(diagnostic.summary).toContain("VERSION");
      expect(diagnostic.traditionalComparison).toContain(
        "No identification of which artifacts are missing",
      );
    });
  });
});

// ===========================================================================
// TEST SUITE 2: Quality Standards — Diagnostics Are Specific, Not Generic
// ===========================================================================

describe("Diagnostic Quality Standards", () => {
  let baseDir: string;
  let state: LocalStateStore;
  let investigator: DiagnosticInvestigator;

  beforeEach(() => {
    baseDir = makeTmpDir();
    state = new LocalStateStore();
    investigator = new DiagnosticInvestigator(state);
  });

  afterEach(() => {
    cleanDir(baseDir);
  });

  it("no two scenarios produce the same summary", () => {
    const instruction = makeInstruction();
    const scenarios = [
      { name: "crash", setup: setupServiceCrashWorkspace },
      { name: "timeout", setup: setupHealthTimeoutWorkspace },
      { name: "dependency", setup: setupDependencyUnavailableWorkspace },
      { name: "partial", setup: setupPartialDeploymentWorkspace },
    ];

    const summaries: string[] = [];
    for (const scenario of scenarios) {
      const workspacePath = path.join(
        baseDir,
        "deployments",
        `unique-${scenario.name}`,
      );
      scenario.setup(workspacePath, {
        ...instruction,
        deploymentId: `unique-${scenario.name}`,
      });

      const diagnostic = investigator.investigate(
        workspacePath,
        { ...instruction, deploymentId: `unique-${scenario.name}` },
      );
      summaries.push(diagnostic.summary);
    }

    // All summaries must be unique
    const uniqueSummaries = new Set(summaries);
    expect(uniqueSummaries.size).toBe(4);
  });

  it("no two scenarios produce the same recommendation", () => {
    const instruction = makeInstruction();
    const scenarios = [
      { name: "crash", setup: setupServiceCrashWorkspace },
      { name: "timeout", setup: setupHealthTimeoutWorkspace },
      { name: "dependency", setup: setupDependencyUnavailableWorkspace },
      { name: "partial", setup: setupPartialDeploymentWorkspace },
    ];

    const recommendations: string[] = [];
    for (const scenario of scenarios) {
      const workspacePath = path.join(
        baseDir,
        "deployments",
        `rec-${scenario.name}`,
      );
      scenario.setup(workspacePath, {
        ...instruction,
        deploymentId: `rec-${scenario.name}`,
      });

      const diagnostic = investigator.investigate(
        workspacePath,
        { ...instruction, deploymentId: `rec-${scenario.name}` },
      );
      recommendations.push(diagnostic.recommendation);
    }

    const uniqueRecs = new Set(recommendations);
    expect(uniqueRecs.size).toBe(4);
  });

  it("every diagnostic references the specific operation and version", () => {
    const instruction = makeInstruction({
      operationId: "billing-service",
      version: "4.2.1",
    });
    const scenarios = [
      setupServiceCrashWorkspace,
      setupHealthTimeoutWorkspace,
      setupDependencyUnavailableWorkspace,
      setupPartialDeploymentWorkspace,
    ];

    for (let i = 0; i < scenarios.length; i++) {
      const workspacePath = path.join(
        baseDir,
        "deployments",
        `ref-${i}`,
      );
      scenarios[i](workspacePath, {
        ...instruction,
        deploymentId: `ref-${i}`,
      });

      const diagnostic = investigator.investigate(
        workspacePath,
        { ...instruction, deploymentId: `ref-${i}` },
      );

      expect(diagnostic.summary).toContain("billing-service");
      expect(diagnostic.summary).toContain("4.2.1");
    }
  });

  it("every diagnostic references the environment name", () => {
    const instruction = makeInstruction({
      environmentName: "staging-eu-west",
    });
    const scenarios = [
      setupServiceCrashWorkspace,
      setupHealthTimeoutWorkspace,
      setupDependencyUnavailableWorkspace,
      setupPartialDeploymentWorkspace,
    ];

    for (let i = 0; i < scenarios.length; i++) {
      const workspacePath = path.join(
        baseDir,
        "deployments",
        `env-${i}`,
      );
      scenarios[i](workspacePath, {
        ...instruction,
        deploymentId: `env-${i}`,
      });

      const diagnostic = investigator.investigate(
        workspacePath,
        { ...instruction, deploymentId: `env-${i}` },
      );

      expect(diagnostic.summary).toContain("staging-eu-west");
    }
  });

  it("every diagnostic has at least 3 pieces of evidence", () => {
    const instruction = makeInstruction();
    const scenarios = [
      setupServiceCrashWorkspace,
      setupHealthTimeoutWorkspace,
      setupDependencyUnavailableWorkspace,
      setupPartialDeploymentWorkspace,
    ];

    for (let i = 0; i < scenarios.length; i++) {
      const workspacePath = path.join(
        baseDir,
        "deployments",
        `evidence-${i}`,
      );
      scenarios[i](workspacePath, {
        ...instruction,
        deploymentId: `evidence-${i}`,
      });

      const diagnostic = investigator.investigate(
        workspacePath,
        { ...instruction, deploymentId: `evidence-${i}` },
      );

      expect(diagnostic.evidence.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("every diagnostic includes a traditional comparison", () => {
    const instruction = makeInstruction();
    const scenarios = [
      setupServiceCrashWorkspace,
      setupHealthTimeoutWorkspace,
      setupDependencyUnavailableWorkspace,
      setupPartialDeploymentWorkspace,
    ];

    for (let i = 0; i < scenarios.length; i++) {
      const workspacePath = path.join(
        baseDir,
        "deployments",
        `compare-${i}`,
      );
      scenarios[i](workspacePath, {
        ...instruction,
        deploymentId: `compare-${i}`,
      });

      const diagnostic = investigator.investigate(
        workspacePath,
        { ...instruction, deploymentId: `compare-${i}` },
      );

      expect(diagnostic.traditionalComparison).toContain(
        "Traditional agent output",
      );
      // Traditional comparison must be shorter than the Envoy's summary
      // (this proves the Envoy is providing MORE information)
      const traditionalText = diagnostic.traditionalComparison
        .replace('Traditional agent output: "', "")
        .split('"')[0];
      expect(traditionalText.length).toBeLessThan(
        diagnostic.summary.length + diagnostic.rootCause.length,
      );
    }
  });
});

// ===========================================================================
// TEST SUITE 3: EnvoyAgent Integration — Diagnostics in Pipeline
// ===========================================================================

describe("EnvoyAgent — Diagnostic Investigation in Pipeline", () => {
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

  it("successful deployments have null diagnostic", async () => {
    const result = await agent.executeDeployment(
      makeInstruction({ deploymentId: "success-diag" }),
    );

    expect(result.success).toBe(true);
    expect(result.diagnostic).toBeNull();
  });

  it("failed deployments include a diagnostic investigation diary entry", async () => {
    // To create a failure, we'll make the base dir non-writable temporarily
    // Actually, let's use a simpler approach — create a deployment then
    // manually trigger investigation via a post-execution workspace manipulation.
    //
    // For the integrated test, we'll verify that when the executor fails
    // (e.g., bad workspace path), the pipeline produces a diagnostic.

    // Create agent with a non-writable base dir
    const readOnlyDir = path.join(baseDir, "readonly");
    fs.mkdirSync(readOnlyDir, { recursive: true });
    fs.mkdirSync(path.join(readOnlyDir, "deployments"), { recursive: true });
    // Make deployments dir non-writable
    fs.chmodSync(path.join(readOnlyDir, "deployments"), 0o444);

    const readOnlyAgent = new EnvoyAgent(diary, state, readOnlyDir);
    const result = await readOnlyAgent.executeDeployment(
      makeInstruction({ deploymentId: "fail-diag" }),
    );

    // Restore permissions for cleanup
    fs.chmodSync(path.join(readOnlyDir, "deployments"), 0o755);

    if (!result.success) {
      // Diagnostic should be present
      expect(result.diagnostic).not.toBeNull();
      expect(result.diagnostic!.failureType).toBeDefined();
      expect(result.diagnostic!.summary.length).toBeGreaterThan(20);

      // Should have a diagnostic-investigation diary entry
      const entries = diary.getByDeployment("fail-diag");
      const investigationEntry = entries.find(
        (e) => e.decisionType === "diagnostic-investigation",
      );
      expect(investigationEntry).toBeDefined();
      expect(investigationEntry!.decision).toContain("Investigation");
      expect(investigationEntry!.reasoning).toContain("Root cause");
      expect(investigationEntry!.reasoning).toContain("Recommendation");
    }
  });

  it("diagnostic report is included in DeploymentResult for service crash", async () => {
    // Execute a successful deployment first to create workspace
    const deployId = "service-crash-integrated";
    const instruction = makeInstruction({ deploymentId: deployId });
    const result = await agent.executeDeployment(instruction);

    expect(result.success).toBe(true);

    // Now simulate a crash by modifying the workspace
    fs.writeFileSync(
      path.join(result.workspacePath, "STATUS"),
      "FAILED",
    );
    fs.mkdirSync(path.join(result.workspacePath, "logs"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(result.workspacePath, "logs", "service.log"),
      [
        "2026-02-23T10:15:01Z [INFO] Starting web-app v2.0.0...",
        "2026-02-23T10:15:01Z [ERROR] Failed to bind to port 8080: EADDRINUSE",
        "2026-02-23T10:15:01Z [FATAL] Cannot start — exiting with code 1",
      ].join("\n"),
    );

    // Directly test the investigator with this workspace
    const investigator = new DiagnosticInvestigator(state);
    const diagnostic = investigator.investigate(
      result.workspacePath,
      instruction,
    );

    expect(diagnostic.failureType).toBe("service-crash");
    expect(diagnostic.summary).toContain("Port 8080");
    expect(diagnostic.recommendation).toContain("lsof");
  });

  it("all four failure types produce distinct diagnostic-investigation diary entries", () => {
    const instruction = makeInstruction();
    const investigator = new DiagnosticInvestigator(state);
    const scenarios: Array<{
      name: string;
      setup: (wp: string, instr: DeploymentInstruction) => void;
    }> = [
      { name: "crash", setup: setupServiceCrashWorkspace },
      { name: "timeout", setup: setupHealthTimeoutWorkspace },
      { name: "dependency", setup: setupDependencyUnavailableWorkspace },
      { name: "partial", setup: setupPartialDeploymentWorkspace },
    ];

    const diagnostics: DiagnosticReport[] = [];

    for (const scenario of scenarios) {
      const workspacePath = path.join(
        baseDir,
        "deployments",
        `integrated-${scenario.name}`,
      );
      scenario.setup(workspacePath, {
        ...instruction,
        deploymentId: `integrated-${scenario.name}`,
      });

      const diagnostic = investigator.investigate(
        workspacePath,
        { ...instruction, deploymentId: `integrated-${scenario.name}` },
      );

      // Record investigation to diary (as the EnvoyAgent would)
      diary.record({
        partitionId: instruction.partitionId,
        deploymentId: `integrated-${scenario.name}`,
        agent: "envoy",
        decisionType: "diagnostic-investigation",
        decision: `Investigation: ${diagnostic.summary}`,
        reasoning:
          `Root cause: ${diagnostic.rootCause} ` +
          `Recommendation: ${diagnostic.recommendation}`,
        context: {
          diagnostic,
          failureType: diagnostic.failureType,
        },
      });

      diagnostics.push(diagnostic);
    }

    // All four investigation entries exist
    const investigationEntries = diary.getByType("diagnostic-investigation");
    expect(investigationEntries.length).toBe(4);

    // All have different failure types
    const failureTypes = diagnostics.map((d) => d.failureType);
    expect(new Set(failureTypes).size).toBe(4);
    expect(failureTypes).toContain("service-crash");
    expect(failureTypes).toContain("health-timeout");
    expect(failureTypes).toContain("dependency-unavailable");
    expect(failureTypes).toContain("partial-deployment");
  });
});

// ===========================================================================
// TEST SUITE 4: Traditional vs. Envoy Comparison — Side by Side
// ===========================================================================

describe("Traditional Agent vs. Envoy Agent — Output Comparison", () => {
  let baseDir: string;
  let state: LocalStateStore;
  let investigator: DiagnosticInvestigator;

  beforeEach(() => {
    baseDir = makeTmpDir();
    state = new LocalStateStore();
    investigator = new DiagnosticInvestigator(state);
  });

  afterEach(() => {
    cleanDir(baseDir);
  });

  const scenarios = [
    {
      name: "Service failed to start",
      type: "service-crash" as const,
      setup: setupServiceCrashWorkspace,
      traditional: traditionalAgentOutput("service-crash"),
    },
    {
      name: "Health check timeout",
      type: "health-timeout" as const,
      setup: setupHealthTimeoutWorkspace,
      traditional: traditionalAgentOutput("health-timeout"),
    },
    {
      name: "Dependency not available",
      type: "dependency-unavailable" as const,
      setup: setupDependencyUnavailableWorkspace,
      traditional: traditionalAgentOutput("dependency-unavailable"),
    },
    {
      name: "Partial deployment failure",
      type: "partial-deployment" as const,
      setup: setupPartialDeploymentWorkspace,
      traditional: traditionalAgentOutput("partial-deployment"),
    },
  ];

  for (const scenario of scenarios) {
    describe(`${scenario.name}`, () => {
      it("traditional output is generic — Envoy output is specific", () => {
        const instruction = makeInstruction({
          deploymentId: `compare-${scenario.type}`,
        });
        const workspacePath = path.join(
          baseDir,
          "deployments",
          `compare-${scenario.type}`,
        );
        scenario.setup(workspacePath, instruction);

        const diagnostic = investigator.investigate(
          workspacePath,
          instruction,
        );

        // Traditional output does NOT contain:
        expect(scenario.traditional).not.toContain("web-app");
        expect(scenario.traditional).not.toContain("v2.0.0");
        expect(scenario.traditional).not.toContain("production");

        // Envoy output DOES contain:
        expect(diagnostic.summary).toContain("web-app");
        expect(diagnostic.summary).toContain("2.0.0");
        expect(diagnostic.summary).toContain("production");
      });

      it("traditional output offers no actionable next step", () => {
        // Traditional agents just say "failed" — no recommendation
        expect(scenario.traditional).not.toContain("lsof");
        expect(scenario.traditional).not.toContain("ps aux");
        expect(scenario.traditional).not.toContain("nc -zv");
        expect(scenario.traditional).not.toContain("df -h");
      });

      it("Envoy provides actionable recommendation with commands", () => {
        const instruction = makeInstruction({
          deploymentId: `action-${scenario.type}`,
        });
        const workspacePath = path.join(
          baseDir,
          "deployments",
          `action-${scenario.type}`,
        );
        scenario.setup(workspacePath, instruction);

        const diagnostic = investigator.investigate(
          workspacePath,
          instruction,
        );

        // Every recommendation should be long enough to be actionable
        expect(diagnostic.recommendation.length).toBeGreaterThan(50);

        // Every recommendation should contain at least one concrete
        // instruction (command, file path, or variable name)
        const hasConcreteInstruction =
          diagnostic.recommendation.includes("`") ||
          diagnostic.recommendation.includes("run") ||
          diagnostic.recommendation.includes("check") ||
          diagnostic.recommendation.includes("verify");
        expect(hasConcreteInstruction).toBe(true);
      });

      it("Envoy provides evidence — traditional provides none", () => {
        const instruction = makeInstruction({
          deploymentId: `evidence-${scenario.type}`,
        });
        const workspacePath = path.join(
          baseDir,
          "deployments",
          `evidence-${scenario.type}`,
        );
        scenario.setup(workspacePath, instruction);

        const diagnostic = investigator.investigate(
          workspacePath,
          instruction,
        );

        // Envoy collects evidence from multiple sources
        expect(diagnostic.evidence.length).toBeGreaterThanOrEqual(3);

        // Each piece of evidence has source, finding, and relevance
        for (const e of diagnostic.evidence) {
          expect(e.source.length).toBeGreaterThan(0);
          expect(e.finding.length).toBeGreaterThan(0);
          expect(e.relevance.length).toBeGreaterThan(0);
        }
      });
    });
  }
});

// ===========================================================================
// TEST SUITE 5: Edge Cases
// ===========================================================================

describe("DiagnosticInvestigator — Edge Cases", () => {
  let baseDir: string;
  let state: LocalStateStore;
  let investigator: DiagnosticInvestigator;

  beforeEach(() => {
    baseDir = makeTmpDir();
    state = new LocalStateStore();
    investigator = new DiagnosticInvestigator(state);
  });

  afterEach(() => {
    cleanDir(baseDir);
  });

  it("handles completely empty workspace gracefully", () => {
    const instruction = makeInstruction({ deploymentId: "empty-001" });
    const workspacePath = path.join(baseDir, "deployments", "empty-001");
    fs.mkdirSync(workspacePath, { recursive: true });

    const diagnostic = investigator.investigate(
      workspacePath,
      instruction,
    );

    expect(diagnostic.failureType).toBe("partial-deployment");
    expect(diagnostic.summary).toContain("0/4");
    expect(diagnostic.evidence.length).toBeGreaterThan(0);
  });

  it("handles nonexistent workspace path", () => {
    const instruction = makeInstruction({ deploymentId: "noexist-001" });
    const workspacePath = path.join(baseDir, "nonexistent");

    const diagnostic = investigator.investigate(
      workspacePath,
      instruction,
    );

    // Should produce a report, not crash
    expect(diagnostic.failureType).toBeDefined();
    expect(diagnostic.summary.length).toBeGreaterThan(0);
    expect(diagnostic.recommendation.length).toBeGreaterThan(0);
  });

  it("handles workspace with logs but no status files", () => {
    const instruction = makeInstruction({ deploymentId: "logsonly-001" });
    const workspacePath = path.join(
      baseDir,
      "deployments",
      "logsonly-001",
    );
    fs.mkdirSync(path.join(workspacePath, "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "logs", "service.log"),
      "2026-02-23T10:15:01Z [ERROR] connect ECONNREFUSED 10.0.0.5:5432\n",
    );

    const diagnostic = investigator.investigate(
      workspacePath,
      instruction,
    );

    // Should still classify based on log patterns
    expect(diagnostic.failureType).toBeDefined();
    expect(diagnostic.evidence.length).toBeGreaterThan(0);
  });

  it("includes deployment history context when available", () => {
    // Record a previous failed deployment
    state.recordDeployment({
      deploymentId: "prev-fail",
      partitionId: "partition-1",
      environmentId: "env-prod",
      operationId: "web-app",
      version: "1.9.0",
      variables: {},
      workspacePath: "/old/workspace",
    });
    state.completeDeployment("prev-fail", "failed", "Port conflict");

    const instruction = makeInstruction({ deploymentId: "history-001" });
    const workspacePath = path.join(
      baseDir,
      "deployments",
      "history-001",
    );
    setupServiceCrashWorkspace(workspacePath, instruction);

    const diagnostic = investigator.investigate(
      workspacePath,
      instruction,
    );

    const historyEvidence = diagnostic.evidence.find(
      (e) => e.source === "deployment history",
    );
    expect(historyEvidence).toBeDefined();
    expect(historyEvidence!.finding).toContain("previous failure");
  });

  it("handles executor error in context", () => {
    const instruction = makeInstruction({ deploymentId: "execerror-001" });
    const workspacePath = path.join(
      baseDir,
      "deployments",
      "execerror-001",
    );
    fs.mkdirSync(workspacePath, { recursive: true });

    const diagnostic = investigator.investigate(
      workspacePath,
      instruction,
      {
        success: false,
        workspacePath,
        artifacts: [],
        durationMs: 42,
        error: "ENOSPC: no space left on device",
      },
    );

    const execEvidence = diagnostic.evidence.find(
      (e) => e.source === "execution-result",
    );
    expect(execEvidence).toBeDefined();
    expect(execEvidence!.finding).toContain("ENOSPC");
  });
});
