import fs from "node:fs";
import path from "node:path";
import type { LocalStateStore } from "../state/local-state.js";
import type { DeploymentInstruction } from "./envoy-agent.js";
import type { ExecutionResult } from "./deployment-executor.js";

// ---------------------------------------------------------------------------
// Types — the diagnostic output
// ---------------------------------------------------------------------------

export type FailureType =
  | "service-crash"
  | "health-timeout"
  | "dependency-unavailable"
  | "partial-deployment"
  | "unknown";

export interface DiagnosticEvidence {
  /** Where this evidence came from: "logs/service.log", "STATUS file", etc. */
  source: string;
  /** What was found */
  finding: string;
  /** Why this matters for the diagnosis */
  relevance: string;
}

/**
 * The result of a diagnostic investigation.
 *
 * Every field is designed to be actionable at 2am:
 * - summary: what happened, in one sentence
 * - rootCause: why it happened, based on local evidence
 * - recommendation: what to do next, specific enough to copy-paste
 * - evidence: what was checked, so the engineer can verify
 * - traditionalComparison: what a dumb agent would have said
 */
export interface DiagnosticReport {
  failureType: FailureType;
  summary: string;
  rootCause: string;
  recommendation: string;
  evidence: DiagnosticEvidence[];
  /** What a traditional deployment agent would have reported for this failure */
  traditionalComparison: string;
}

// ---------------------------------------------------------------------------
// Log pattern matching
// ---------------------------------------------------------------------------

interface LogPattern {
  pattern: RegExp;
  failureType: FailureType;
  extractDetail: (match: RegExpMatchArray, line: string) => string;
}

const LOG_PATTERNS: LogPattern[] = [
  // Port conflicts
  {
    pattern: /EADDRINUSE|address already in use|port (\d+) is already/i,
    failureType: "service-crash",
    extractDetail: (match, line) => {
      const portMatch = line.match(/port\s+(\d+)/i);
      const port = portMatch ? portMatch[1] : "unknown";
      const pidMatch = line.match(/PID[:\s]+(\d+)/i);
      const pid = pidMatch ? pidMatch[1] : null;
      return pid
        ? `Port ${port} already in use by process ${pid}`
        : `Port ${port} already in use by another process`;
    },
  },
  // Missing configuration / files
  {
    pattern: /ENOENT|no such file|file not found|config.*not found/i,
    failureType: "service-crash",
    extractDetail: (_match, line) => {
      const pathMatch = line.match(/['"]([^'"]+)['"]/);
      return pathMatch
        ? `Required file not found: ${pathMatch[1]}`
        : "Required file or configuration not found";
    },
  },
  // Connection refused — dependency unavailable
  {
    pattern: /ECONNREFUSED|connection refused|connect ECONNREFUSED/i,
    failureType: "dependency-unavailable",
    extractDetail: (_match, line) => {
      const hostMatch = line.match(
        /(?:ECONNREFUSED|connection refused)\s*(?:to\s+)?(\S+:\d+|\d+\.\d+\.\d+\.\d+:\d+)/i,
      );
      return hostMatch
        ? `Connection refused to ${hostMatch[1]}`
        : "Connection refused to required dependency";
    },
  },
  // DNS resolution failure — dependency unavailable
  {
    pattern: /ENOTFOUND|getaddrinfo.*failed|DNS.*resolution.*failed/i,
    failureType: "dependency-unavailable",
    extractDetail: (_match, line) => {
      const hostMatch = line.match(/(?:ENOTFOUND|getaddrinfo.*failed)\s+(\S+)/i);
      return hostMatch
        ? `DNS resolution failed for ${hostMatch[1]}`
        : "DNS resolution failed for required dependency";
    },
  },
  // Timeout patterns — health check
  {
    pattern: /ETIMEDOUT|timeout.*health|health.*timeout|startup.*timeout/i,
    failureType: "health-timeout",
    extractDetail: (_match, line) => {
      const msMatch = line.match(/(\d+)\s*ms/);
      return msMatch
        ? `Health check timed out after ${msMatch[1]}ms`
        : "Health check timed out waiting for service readiness";
    },
  },
  // Socket timeout — could be dependency or health
  {
    pattern: /ESOCKETTIMEDOUT|socket.*timeout|read.*timeout/i,
    failureType: "dependency-unavailable",
    extractDetail: (_match, line) => {
      const hostMatch = line.match(/(?:to|connecting)\s+(\S+)/i);
      return hostMatch
        ? `Socket timeout connecting to ${hostMatch[1]}`
        : "Socket timeout connecting to required service";
    },
  },
  // Out of memory
  {
    pattern: /out of memory|OOMKill|heap.*exceeded|ENOMEM/i,
    failureType: "service-crash",
    extractDetail: () => "Service ran out of memory during startup",
  },
  // Permission denied
  {
    pattern: /EACCES|permission denied/i,
    failureType: "service-crash",
    extractDetail: (_match, line) => {
      const pathMatch = line.match(/['"]([^'"]+)['"]/);
      return pathMatch
        ? `Permission denied accessing ${pathMatch[1]}`
        : "Permission denied during service startup";
    },
  },
  // Fatal / crash
  {
    pattern: /\[FATAL\]|fatal error|segmentation fault|SIGSEGV|SIGABRT/i,
    failureType: "service-crash",
    extractDetail: (_match, line) => {
      const cleaned = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.Z]+\s*/, "").trim();
      return cleaned.length > 120 ? cleaned.slice(0, 120) + "…" : cleaned;
    },
  },
  // Exit code
  {
    pattern: /exit(?:ing)?\s+(?:with\s+)?code\s+(\d+)/i,
    failureType: "service-crash",
    extractDetail: (match) => `Service exited with code ${match[1]}`,
  },
];

// ---------------------------------------------------------------------------
// DiagnosticInvestigator — the Envoy's forensic eye
// ---------------------------------------------------------------------------

/**
 * Investigates deployment failures by reading local evidence.
 *
 * When a deployment fails, the investigator:
 * 1. Reads service logs from the workspace
 * 2. Checks the STATUS and HEALTH markers
 * 3. Examines artifact completeness
 * 4. Cross-references with deployment history
 * 5. Produces a specific diagnostic that tells an engineer exactly
 *    what happened and what to do about it
 *
 * The investigator never guesses — it reports what it found.
 * If it can't determine the cause, it says so and lists what it checked.
 */
export class DiagnosticInvestigator {
  constructor(
    private state: LocalStateStore,
  ) {}

  /**
   * Investigate a failed deployment.
   *
   * @param workspacePath — where the deployment artifacts live
   * @param instruction — the original deployment instruction
   * @param execResult — the execution result (if execution was attempted)
   */
  investigate(
    workspacePath: string,
    instruction: DeploymentInstruction,
    execResult?: ExecutionResult | null,
  ): DiagnosticReport {
    const evidence: DiagnosticEvidence[] = [];

    // --- Gather evidence ---

    const logFindings = this.readLogs(workspacePath, evidence);
    const statusState = this.checkStatusFile(workspacePath, evidence);
    const healthState = this.checkHealthFile(workspacePath, evidence);
    const artifactState = this.checkArtifactCompleteness(workspacePath, evidence);
    const historyContext = this.checkDeploymentHistory(instruction, evidence);

    if (execResult?.error) {
      evidence.push({
        source: "execution-result",
        finding: `Executor reported: ${execResult.error}`,
        relevance: "Direct error from the deployment execution phase",
      });
    }

    // --- Classify the failure ---

    const failureType = this.classifyFailure(
      logFindings,
      statusState,
      healthState,
      artifactState,
    );

    // --- Produce the diagnostic ---

    return this.buildReport(
      failureType,
      instruction,
      evidence,
      logFindings,
      statusState,
      healthState,
      artifactState,
      historyContext,
      execResult,
    );
  }

  // -------------------------------------------------------------------------
  // Evidence gathering
  // -------------------------------------------------------------------------

  private readLogs(
    workspacePath: string,
    evidence: DiagnosticEvidence[],
  ): LogFinding[] {
    const findings: LogFinding[] = [];
    const logsDir = path.join(workspacePath, "logs");

    if (!fs.existsSync(logsDir)) {
      evidence.push({
        source: "logs/",
        finding: "No log directory found in workspace",
        relevance: "Cannot analyze service output — no logs available",
      });
      return findings;
    }

    let logFiles: string[];
    try {
      logFiles = fs.readdirSync(logsDir).filter((f) => f.endsWith(".log"));
    } catch {
      evidence.push({
        source: "logs/",
        finding: "Cannot read log directory",
        relevance: "Log directory exists but is not readable",
      });
      return findings;
    }

    if (logFiles.length === 0) {
      evidence.push({
        source: "logs/",
        finding: "Log directory exists but contains no .log files",
        relevance: "Service may not have started far enough to produce output",
      });
      return findings;
    }

    for (const logFile of logFiles) {
      const logPath = path.join(logsDir, logFile);
      let content: string;
      try {
        content = fs.readFileSync(logPath, "utf-8");
      } catch {
        evidence.push({
          source: `logs/${logFile}`,
          finding: "Cannot read log file",
          relevance: "Log file exists but is not readable",
        });
        continue;
      }

      const lines = content.split("\n").filter((l) => l.trim().length > 0);

      evidence.push({
        source: `logs/${logFile}`,
        finding: `${lines.length} line(s) of output`,
        relevance: "Service log analyzed for failure indicators",
      });

      // Scan for error patterns
      for (const line of lines) {
        for (const pattern of LOG_PATTERNS) {
          const match = line.match(pattern.pattern);
          if (match) {
            const detail = pattern.extractDetail(match, line);
            findings.push({
              logFile: `logs/${logFile}`,
              failureType: pattern.failureType,
              detail,
              line: line.trim(),
            });
          }
        }
      }

      // Capture the last few error/fatal lines as evidence
      const errorLines = lines.filter((l) =>
        /\[ERROR\]|\[FATAL\]|error:|fatal:/i.test(l),
      );
      if (errorLines.length > 0) {
        const last = errorLines.slice(-3);
        evidence.push({
          source: `logs/${logFile}`,
          finding: `Error lines: ${last.map((l) => l.trim()).join(" → ")}`,
          relevance: "Final error output before service stopped",
        });
      }
    }

    return findings;
  }

  private checkStatusFile(
    workspacePath: string,
    evidence: DiagnosticEvidence[],
  ): string | null {
    const statusPath = path.join(workspacePath, "STATUS");
    if (!fs.existsSync(statusPath)) {
      evidence.push({
        source: "STATUS",
        finding: "STATUS file not found",
        relevance: "Deployment may not have completed artifact writing",
      });
      return null;
    }

    const status = fs.readFileSync(statusPath, "utf-8").trim();
    evidence.push({
      source: "STATUS",
      finding: `Current status: ${status}`,
      relevance:
        status === "DEPLOYED"
          ? "Artifacts were written — failure is post-deployment"
          : status === "FAILED"
            ? "Service explicitly marked as FAILED"
            : status === "STARTING"
              ? "Service stuck in STARTING state — did not reach RUNNING"
              : `Non-standard status "${status}" — may indicate partial execution`,
    });

    return status;
  }

  private checkHealthFile(
    workspacePath: string,
    evidence: DiagnosticEvidence[],
  ): string | null {
    const healthPath = path.join(workspacePath, "HEALTH");
    if (!fs.existsSync(healthPath)) {
      return null;
    }

    const health = fs.readFileSync(healthPath, "utf-8").trim();
    evidence.push({
      source: "HEALTH",
      finding: `Health check result: ${health}`,
      relevance:
        health === "ok"
          ? "Health check passed — failure occurred after health verification"
          : health === "timeout"
            ? "Health check timed out — service did not respond in time"
            : `Health check returned "${health}"`,
    });

    return health;
  }

  private checkArtifactCompleteness(
    workspacePath: string,
    evidence: DiagnosticEvidence[],
  ): ArtifactState {
    const expected = ["manifest.json", "variables.env", "VERSION", "STATUS"];
    const present: string[] = [];
    const missing: string[] = [];

    for (const artifact of expected) {
      if (fs.existsSync(path.join(workspacePath, artifact))) {
        present.push(artifact);
      } else {
        missing.push(artifact);
      }
    }

    const state: ArtifactState = {
      complete: missing.length === 0,
      present,
      missing,
    };

    if (missing.length > 0) {
      evidence.push({
        source: "workspace artifacts",
        finding: `Missing: ${missing.join(", ")}. Present: ${present.join(", ")}`,
        relevance:
          "Deployment artifacts are incomplete — execution was interrupted",
      });
    } else {
      evidence.push({
        source: "workspace artifacts",
        finding: `All ${expected.length} expected artifacts present`,
        relevance: "Deployment artifacts are complete — failure is post-write",
      });
    }

    return state;
  }

  private checkDeploymentHistory(
    instruction: DeploymentInstruction,
    evidence: DiagnosticEvidence[],
  ): HistoryContext {
    const previousDeploys = this.state.getDeploymentsByEnvironment(
      instruction.partitionId,
      instruction.environmentId,
    );

    const recentFailures = previousDeploys.filter(
      (d) => d.status === "failed",
    );

    const envSnapshot = this.state.getEnvironment(
      instruction.partitionId,
      instruction.environmentId,
    );

    const context: HistoryContext = {
      previousDeployCount: previousDeploys.length,
      previousFailureCount: recentFailures.length,
      previousVersion: envSnapshot?.currentVersion ?? null,
      isFirstDeployment: previousDeploys.length === 0,
    };

    if (recentFailures.length > 0) {
      const lastFailure = recentFailures[recentFailures.length - 1];
      evidence.push({
        source: "deployment history",
        finding:
          `${recentFailures.length} previous failure(s) for this environment. ` +
          `Last failure: ${lastFailure.failureReason ?? "unknown reason"}`,
        relevance: "Recurring failures may indicate a systemic issue",
      });
    }

    if (envSnapshot) {
      evidence.push({
        source: "environment state",
        finding:
          `Previous version: ${envSnapshot.currentVersion} ` +
          `(deployment ${envSnapshot.currentDeploymentId})`,
        relevance:
          "Previous deployment was active — environment is in a known rollback-capable state",
      });
    }

    return context;
  }

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  private classifyFailure(
    logFindings: LogFinding[],
    statusState: string | null,
    healthState: string | null,
    artifactState: ArtifactState,
  ): FailureType {
    // Partial deployment — artifacts incomplete
    if (!artifactState.complete) {
      return "partial-deployment";
    }

    // Health timeout — status stuck at STARTING or health file says timeout
    if (
      healthState === "timeout" ||
      statusState === "STARTING"
    ) {
      return "health-timeout";
    }

    // Log-based classification — use the most specific finding
    if (logFindings.length > 0) {
      // If any finding says dependency-unavailable, prioritize that
      const depFinding = logFindings.find(
        (f) => f.failureType === "dependency-unavailable",
      );
      if (depFinding) return "dependency-unavailable";

      // Health timeout from logs
      const healthFinding = logFindings.find(
        (f) => f.failureType === "health-timeout",
      );
      if (healthFinding) return "health-timeout";

      // Service crash from logs
      const crashFinding = logFindings.find(
        (f) => f.failureType === "service-crash",
      );
      if (crashFinding) return "service-crash";
    }

    // Status-based fallback
    if (statusState === "FAILED") {
      return "service-crash";
    }

    return "unknown";
  }

  // -------------------------------------------------------------------------
  // Report building
  // -------------------------------------------------------------------------

  private buildReport(
    failureType: FailureType,
    instruction: DeploymentInstruction,
    evidence: DiagnosticEvidence[],
    logFindings: LogFinding[],
    statusState: string | null,
    healthState: string | null,
    artifactState: ArtifactState,
    historyContext: HistoryContext,
    execResult?: ExecutionResult | null,
  ): DiagnosticReport {
    const svc = `${instruction.operationId} v${instruction.version}`;
    const env = instruction.environmentName;

    switch (failureType) {
      case "service-crash":
        return this.buildServiceCrashReport(
          svc,
          env,
          instruction,
          evidence,
          logFindings,
          historyContext,
        );

      case "health-timeout":
        return this.buildHealthTimeoutReport(
          svc,
          env,
          instruction,
          evidence,
          logFindings,
          healthState,
          statusState,
        );

      case "dependency-unavailable":
        return this.buildDependencyReport(
          svc,
          env,
          instruction,
          evidence,
          logFindings,
        );

      case "partial-deployment":
        return this.buildPartialDeploymentReport(
          svc,
          env,
          instruction,
          evidence,
          artifactState,
          execResult,
          historyContext,
        );

      default:
        return this.buildUnknownReport(
          svc,
          env,
          instruction,
          evidence,
          execResult,
        );
    }
  }

  private buildServiceCrashReport(
    svc: string,
    env: string,
    instruction: DeploymentInstruction,
    evidence: DiagnosticEvidence[],
    logFindings: LogFinding[],
    historyContext: HistoryContext,
  ): DiagnosticReport {
    // Find the most specific crash detail from logs
    const crashDetails = logFindings.filter(
      (f) => f.failureType === "service-crash",
    );
    const primaryDetail = crashDetails[0]?.detail ?? "Service process terminated unexpectedly";

    // Build specific recommendation based on the crash type
    let recommendation: string;
    const portMatch = primaryDetail.match(/port\s+(\d+)/i);
    const pidMatch = primaryDetail.match(/process\s+(\d+)/i);
    const fileMatch = primaryDetail.match(/not found:\s*(.+)/i);
    const permMatch = primaryDetail.match(/permission denied/i);

    if (portMatch) {
      recommendation =
        `Run \`lsof -i :${portMatch[1]}\` to identify the process occupying port ${portMatch[1]}. ` +
        (pidMatch
          ? `Process ${pidMatch[1]} is the blocker — verify if it should be running. `
          : "") +
        `Either stop the conflicting process or change ${instruction.operationId}'s ` +
        `listen port via the APP_PORT or PORT variable.`;
    } else if (fileMatch) {
      recommendation =
        `Verify that ${fileMatch[1]} exists on the target machine. ` +
        `Check the deployment manifest for required configuration files ` +
        `and ensure they are provisioned before deploying.`;
    } else if (permMatch) {
      recommendation =
        `Check filesystem permissions for the deployment workspace. ` +
        `The service process needs read/execute access to its binary and ` +
        `read access to configuration. Run \`ls -la\` on the workspace ` +
        `to verify ownership and permissions.`;
    } else if (primaryDetail.includes("out of memory")) {
      recommendation =
        `The service exceeded its memory allocation during startup. ` +
        `Review the memory limits for ${instruction.operationId} on ${env} ` +
        `and either increase the allocation or investigate why startup ` +
        `memory consumption has increased in this version.`;
    } else {
      recommendation =
        `Review the service logs at the workspace path for the full stack trace. ` +
        `The crash occurred during startup — check for configuration ` +
        `changes between the previous version and v${instruction.version} ` +
        `that could cause initialization failure.`;
    }

    const rollbackNote = historyContext.previousVersion
      ? ` The previous version (${historyContext.previousVersion}) is still on disk and can be rolled back to.`
      : "";

    return {
      failureType: "service-crash",
      summary:
        `${svc} failed to start on ${env}. ` +
        `${primaryDetail}.`,
      rootCause:
        `The service process exited during startup. ` +
        `Log analysis identified the cause: ${primaryDetail}. ` +
        `${crashDetails.length > 1 ? `${crashDetails.length} error indicators found in service logs. ` : ""}` +
        `Deployment artifacts were written successfully — this is a ` +
        `runtime failure, not a deployment packaging issue.${rollbackNote}`,
      recommendation,
      evidence,
      traditionalComparison:
        `Traditional agent output: "Deployment failed. Service exited with non-zero status." ` +
        `No log analysis, no root cause, no remediation steps.`,
    };
  }

  private buildHealthTimeoutReport(
    svc: string,
    env: string,
    instruction: DeploymentInstruction,
    evidence: DiagnosticEvidence[],
    logFindings: LogFinding[],
    healthState: string | null,
    statusState: string | null,
  ): DiagnosticReport {
    const timeoutDetail = logFindings.find(
      (f) => f.failureType === "health-timeout",
    );
    const timeoutMs = timeoutDetail?.detail.match(/(\d+)ms/)?.[1];

    const stateDetail =
      statusState === "STARTING"
        ? "The service is stuck in STARTING state — it began initialization but never reached RUNNING."
        : healthState === "timeout"
          ? "The health endpoint did not respond within the configured timeout window."
          : "The service did not become healthy within the expected timeframe.";

    // Check if there are dependency issues too
    const depFindings = logFindings.filter(
      (f) => f.failureType === "dependency-unavailable",
    );
    const depNote =
      depFindings.length > 0
        ? ` Note: dependency connection issues were also detected (${depFindings[0].detail}), which may be causing the slow startup.`
        : "";

    return {
      failureType: "health-timeout",
      summary:
        `${svc} deployed to ${env} but did not become healthy` +
        (timeoutMs ? ` within ${timeoutMs}ms` : "") +
        `. ${stateDetail}`,
      rootCause:
        `The service started but its health check never returned a successful response. ` +
        `${stateDetail}${depNote} ` +
        `This typically indicates the service is either: (a) taking longer than expected ` +
        `to initialize, (b) waiting on a dependency that isn't available, or ` +
        `(c) stuck in a startup loop.`,
      recommendation:
        `Check if the service process is still running (\`ps aux | grep ${instruction.operationId}\`). ` +
        `If running, inspect the service logs for initialization progress. ` +
        (timeoutMs
          ? `The health check timeout is ${timeoutMs}ms — consider whether this is sufficient for ${env}. `
          : "") +
        (depFindings.length > 0
          ? `Resolve the dependency issue first: ${depFindings[0].detail}. `
          : "") +
        `If this is a ${env === "production" ? "production" : "non-production"} environment, ` +
        `consider ${env === "production" ? "increasing the health check timeout before retrying" : "investigating locally before redeploying"}.`,
      evidence,
      traditionalComparison:
        `Traditional agent output: "Health check failed after timeout. Deployment marked as failed." ` +
        `No distinction between slow startup vs. dependency issues vs. crash loops.`,
    };
  }

  private buildDependencyReport(
    svc: string,
    env: string,
    instruction: DeploymentInstruction,
    evidence: DiagnosticEvidence[],
    logFindings: LogFinding[],
  ): DiagnosticReport {
    const depFindings = logFindings.filter(
      (f) => f.failureType === "dependency-unavailable",
    );
    const primaryDep = depFindings[0];

    // Try to identify which dependency from variables
    const connVars = Object.entries(instruction.variables).filter(
      ([k]) =>
        /host|url|endpoint|addr|connection/i.test(k),
    );

    const hostDetail = primaryDep?.detail ?? "Required dependency is not reachable";

    // Extract host:port from the finding
    const hostPortMatch = hostDetail.match(
      /(\S+:\d+|\d+\.\d+\.\d+\.\d+:\d+)/,
    );
    const targetHost = hostPortMatch?.[1];

    let recommendation: string;
    if (targetHost) {
      recommendation =
        `Verify that the service at ${targetHost} is running and accepting connections. ` +
        `Run \`nc -zv ${targetHost.replace(":", " ")}\` from the deployment target to test connectivity. `;
    } else {
      recommendation =
        `Identify which dependency is unavailable from the connection variables ` +
        `(${connVars.map(([k]) => k).join(", ") || "check deployment manifest"}). ` +
        `Verify the dependency is running and the network path is clear. `;
    }

    recommendation +=
      `If the dependency is intentionally down, this deployment should be ` +
      `deferred until it's restored. If the dependency host or port has changed, ` +
      `update the deployment variables accordingly.`;

    return {
      failureType: "dependency-unavailable",
      summary:
        `${svc} on ${env} cannot reach a required dependency. ${hostDetail}.`,
      rootCause:
        `The service started but failed to connect to a required external dependency. ` +
        `${depFindings.length} connection failure(s) detected in service logs: ` +
        `${depFindings.map((f) => f.detail).join("; ")}. ` +
        `The deployment artifacts are intact — the service itself is packaged ` +
        `correctly but its runtime environment is missing a dependency.`,
      recommendation,
      evidence,
      traditionalComparison:
        `Traditional agent output: "Service check failed. Deployment unsuccessful." ` +
        `No identification of which dependency, no connectivity test suggestion, ` +
        `no variable cross-reference.`,
    };
  }

  private buildPartialDeploymentReport(
    svc: string,
    env: string,
    instruction: DeploymentInstruction,
    evidence: DiagnosticEvidence[],
    artifactState: ArtifactState,
    execResult?: ExecutionResult | null,
    historyContext?: HistoryContext,
  ): DiagnosticReport {
    const missingList = artifactState.missing.join(", ");
    const presentList = artifactState.present.join(", ");
    const ratio = `${artifactState.present.length}/${artifactState.present.length + artifactState.missing.length}`;

    const rollbackNote = historyContext?.previousVersion
      ? `The previous version (${historyContext.previousVersion}) should be rolled back to immediately — ` +
        `the environment is in an inconsistent state.`
      : `This environment has no previous deployment to roll back to — ` +
        `clean up the partial artifacts and retry the deployment.`;

    const execError = execResult?.error
      ? ` The executor reported: "${execResult.error}".`
      : "";

    return {
      failureType: "partial-deployment",
      summary:
        `${svc} deployment to ${env} is incomplete — ${ratio} artifacts written. ` +
        `Missing: ${missingList}.`,
      rootCause:
        `The deployment was interrupted before all artifacts could be written. ` +
        `Present: ${presentList}. Missing: ${missingList}. ` +
        `This indicates the deployment process was terminated mid-execution — ` +
        `possible causes include disk full, process killed, or filesystem error.${execError}`,
      recommendation:
        `Do NOT attempt to start the service — the deployment is incomplete ` +
        `and the artifacts are inconsistent. ${rollbackNote} ` +
        `Before retrying, check: (1) available disk space (\`df -h\`), ` +
        `(2) filesystem health, (3) that no process is competing for ` +
        `the workspace directory.`,
      evidence,
      traditionalComparison:
        `Traditional agent output: "Deployment error. Check logs for details." ` +
        `No identification of which artifacts are missing, no inconsistency warning, ` +
        `no rollback guidance.`,
    };
  }

  private buildUnknownReport(
    svc: string,
    env: string,
    _instruction: DeploymentInstruction,
    evidence: DiagnosticEvidence[],
    execResult?: ExecutionResult | null,
  ): DiagnosticReport {
    const execError = execResult?.error
      ? `The executor reported: "${execResult.error}".`
      : "No execution error was captured.";

    return {
      failureType: "unknown",
      summary:
        `${svc} deployment to ${env} failed. ` +
        `Investigation could not determine a specific root cause from available evidence.`,
      rootCause:
        `The deployment failed but the available evidence does not match ` +
        `any known failure pattern. ${execError} ` +
        `${evidence.length} pieces of evidence were examined. ` +
        `This may indicate a new failure mode not yet covered by the ` +
        `diagnostic investigator.`,
      recommendation:
        `Manually inspect the workspace directory and service logs. ` +
        `The evidence collected during investigation is included in this ` +
        `report — start there. If this failure recurs, the diagnostic ` +
        `patterns should be updated to recognize it.`,
      evidence,
      traditionalComparison:
        `Traditional agent output: "Deployment failed." ` +
        `No evidence collected, no investigation attempted.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface LogFinding {
  logFile: string;
  failureType: FailureType;
  detail: string;
  line: string;
}

interface ArtifactState {
  complete: boolean;
  present: string[];
  missing: string[];
}

interface HistoryContext {
  previousDeployCount: number;
  previousFailureCount: number;
  previousVersion: string | null;
  isFirstDeployment: boolean;
}
