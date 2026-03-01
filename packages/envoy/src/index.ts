import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { DecisionDebrief } from "@deploystack/core";
import { EnvoyAgent } from "./agent/envoy-agent.js";
import { LocalStateStore } from "./state/local-state.js";
import { createEnvoyServer } from "./server.js";

// --- Configuration ---

const PORT = parseInt(process.env.ENVOY_PORT ?? "3001", 10);
const HOST = process.env.ENVOY_HOST ?? "0.0.0.0";
const BASE_DIR = process.env.ENVOY_BASE_DIR ?? path.join(process.cwd(), ".envoy");

// --- Bootstrap ---

// Ensure base directory exists
fs.mkdirSync(BASE_DIR, { recursive: true });
fs.mkdirSync(path.join(BASE_DIR, "deployments"), { recursive: true });

const COMMAND_URL = process.env.DEPLOYSTACK_COMMAND_URL ?? "";

const debrief = new DecisionDebrief();
const state = new LocalStateStore();

// Connect the CommandReporter if a Command URL is configured
let reporter: import("./agent/command-reporter.js").CommandReporter | undefined;
if (COMMAND_URL) {
  const { CommandReporter } = await import("./agent/command-reporter.js");
  const envoyId = `envoy-${HOST}:${PORT}`;
  reporter = new CommandReporter(COMMAND_URL, envoyId);
}

const agent = new EnvoyAgent(debrief, state, BASE_DIR, reporter);

debrief.record({
  partitionId: null,
  deploymentId: null,
  agent: "envoy",
  decisionType: "system",
  decision: "Envoy initialized with seed data",
  reasoning:
    `Envoy agent started with workspace at "${BASE_DIR}". ` +
    `Seeded local state with deployment records and environment snapshots for demo.`,
  context: {
    baseDir: BASE_DIR,
    port: PORT,
    host: HOST,
    commandUrl: COMMAND_URL || "(not configured)",
  },
});

// --- Seed envoy local state so status and health endpoints show data ---

function hoursAgo(h: number): Date { return new Date(Date.now() - h * 3600_000); }

// Use stable IDs so they don't need to match Command's UUIDs —
// Envoy tracks its own view of the world.
const partitionIds = {
  acme: crypto.randomUUID(),
  globex: crypto.randomUUID(),
  initech: crypto.randomUUID(),
};
const envIds = {
  production: crypto.randomUUID(),
  staging: crypto.randomUUID(),
};

// Deployment records — Envoy's local history of what it executed
const envoyDeps = [
  { deploymentId: crypto.randomUUID(), partitionId: partitionIds.acme, environmentId: envIds.production, operationId: "web-app", version: "2.3.0", variables: { APP_ENV: "production" }, workspacePath: path.join(BASE_DIR, "deployments", "web-app-2.3.0") },
  { deploymentId: crypto.randomUUID(), partitionId: partitionIds.acme, environmentId: envIds.production, operationId: "web-app", version: "2.4.0", variables: { APP_ENV: "production" }, workspacePath: path.join(BASE_DIR, "deployments", "web-app-2.4.0") },
  { deploymentId: crypto.randomUUID(), partitionId: partitionIds.acme, environmentId: envIds.production, operationId: "web-app", version: "2.4.1", variables: { APP_ENV: "production" }, workspacePath: path.join(BASE_DIR, "deployments", "web-app-2.4.1") },
  { deploymentId: crypto.randomUUID(), partitionId: partitionIds.acme, environmentId: envIds.production, operationId: "api-service", version: "1.11.0", variables: { APP_ENV: "production" }, workspacePath: path.join(BASE_DIR, "deployments", "api-service-1.11.0") },
  { deploymentId: crypto.randomUUID(), partitionId: partitionIds.acme, environmentId: envIds.production, operationId: "api-service", version: "1.12.0", variables: { APP_ENV: "production" }, workspacePath: path.join(BASE_DIR, "deployments", "api-service-1.12.0") },
  { deploymentId: crypto.randomUUID(), partitionId: partitionIds.globex, environmentId: envIds.staging, operationId: "web-app", version: "2.5.0-rc.1", variables: { APP_ENV: "staging" }, workspacePath: path.join(BASE_DIR, "deployments", "web-app-2.5.0-rc.1") },
  { deploymentId: crypto.randomUUID(), partitionId: partitionIds.initech, environmentId: envIds.production, operationId: "worker-service", version: "2.9.0", variables: { APP_ENV: "production" }, workspacePath: path.join(BASE_DIR, "deployments", "worker-service-2.9.0") },
  { deploymentId: crypto.randomUUID(), partitionId: partitionIds.initech, environmentId: envIds.production, operationId: "worker-service", version: "3.0.0", variables: { APP_ENV: "production" }, workspacePath: path.join(BASE_DIR, "deployments", "worker-service-3.0.0") },
];

// Record deployments and complete them with appropriate statuses
for (const d of envoyDeps) {
  state.recordDeployment(d);
}
state.completeDeployment(envoyDeps[0].deploymentId, "succeeded");
state.completeDeployment(envoyDeps[1].deploymentId, "succeeded");
state.completeDeployment(envoyDeps[2].deploymentId, "succeeded");
state.completeDeployment(envoyDeps[3].deploymentId, "failed", "Health check failed: connection refused on port 8080");
state.completeDeployment(envoyDeps[4].deploymentId, "succeeded");
state.completeDeployment(envoyDeps[5].deploymentId, "succeeded");
state.completeDeployment(envoyDeps[6].deploymentId, "failed", "Queue depth exceeded threshold (342 > 100)");
state.completeDeployment(envoyDeps[7].deploymentId, "succeeded");

// Environment snapshots — what Envoy believes is currently running
state.updateEnvironment(partitionIds.acme, envIds.production, {
  currentVersion: "2.4.1",
  currentDeploymentId: envoyDeps[2].deploymentId,
  activeVariables: { APP_ENV: "production", DB_HOST: "acme-db-1", LOG_LEVEL: "warn", REGION: "us-east-1" },
});
state.updateEnvironment(partitionIds.globex, envIds.staging, {
  currentVersion: "2.5.0-rc.1",
  currentDeploymentId: envoyDeps[5].deploymentId,
  activeVariables: { APP_ENV: "staging", DB_HOST: "globex-db-1", LOG_LEVEL: "debug", REGION: "eu-west-1" },
});
state.updateEnvironment(partitionIds.initech, envIds.production, {
  currentVersion: "3.0.0",
  currentDeploymentId: envoyDeps[7].deploymentId,
  activeVariables: { APP_ENV: "production", DB_HOST: "initech-db-1", LOG_LEVEL: "debug", REGION: "us-west-2" },
});

// Envoy-side debrief entries
debrief.record({
  partitionId: partitionIds.acme, deploymentId: envoyDeps[2].deploymentId, agent: "envoy", decisionType: "deployment-execution",
  decision: "Executed web-app v2.4.1 on Acme Corp production",
  reasoning: "All steps completed in 32.1s. Dependencies installed, migrations applied, health check passed.",
  context: { duration: 32100 },
});
debrief.record({
  partitionId: partitionIds.acme, deploymentId: envoyDeps[3].deploymentId, agent: "envoy", decisionType: "diagnostic-investigation",
  decision: "Diagnosed api-service v1.11.0 failure: port conflict",
  reasoning: "Port 8080 held by stale process (PID 14823) from previous deployment. Recommend adding pre-deploy cleanup step.",
  context: { rootCause: "port-conflict", stalePid: 14823 },
});
debrief.record({
  partitionId: partitionIds.initech, deploymentId: envoyDeps[7].deploymentId, agent: "envoy", decisionType: "deployment-execution",
  decision: "Executed worker-service v3.0.0 on Initech production",
  reasoning: "Workers stopped (0 jobs lost), binary deployed, workers restarted. Queue depth stabilized at 12.",
  context: { duration: 45200, queueDepth: 12 },
});
debrief.record({
  partitionId: partitionIds.acme, deploymentId: null, agent: "envoy", decisionType: "environment-scan",
  decision: "Environment scan: Acme Corp production healthy",
  reasoning: "web-app v2.4.1 and api-service v1.12.0 running. Disk 62%, Memory 71%. No drift.",
  context: { diskUsage: "62%", memoryUsage: "71%", drift: false },
});
debrief.record({
  partitionId: partitionIds.initech, deploymentId: null, agent: "envoy", decisionType: "environment-scan",
  decision: "Environment scan: Initech production — configuration drift detected",
  reasoning: "worker-service v3.0.0 running. LOG_LEVEL manually changed from 'warn' to 'debug' outside pipeline.",
  context: { drift: true, driftVariable: "LOG_LEVEL", expected: "warn", actual: "debug" },
});

// --- Start server ---

const app = createEnvoyServer(agent, state);

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }

  console.log(`
╔══════════════════════════════════════════════════════╗
║  DeployStack Envoy v0.1.0                         ║
║                                                      ║
║  Health:  http://${HOST}:${PORT}/health               ║
║  Deploy:  POST http://${HOST}:${PORT}/deploy          ║
║  Status:  http://${HOST}:${PORT}/status               ║
║                                                      ║
║  Workspace: ${BASE_DIR.padEnd(40)}║
╚══════════════════════════════════════════════════════╝
  `);

  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});

// --- Exports for programmatic use ---

export { EnvoyAgent } from "./agent/envoy-agent.js";
export type {
  DeploymentInstruction,
  DeploymentResult,
} from "./agent/envoy-agent.js";
export { DeploymentExecutor } from "./agent/deployment-executor.js";
export type {
  DeploymentManifest,
  ExecutionResult,
  VerificationResult,
  VerificationCheck,
} from "./agent/deployment-executor.js";
export { EnvironmentScanner } from "./agent/environment-scanner.js";
export type { EnvironmentScanResult } from "./agent/environment-scanner.js";
export { LocalStateStore } from "./state/local-state.js";
export type {
  LocalDeploymentRecord,
  EnvironmentSnapshot,
} from "./state/local-state.js";
export { createEnvoyServer } from "./server.js";
export { CommandReporter } from "./agent/command-reporter.js";
export type { EnvoyReport, SerializedDebriefEntry } from "./agent/command-reporter.js";
export { DiagnosticInvestigator } from "./agent/diagnostic-investigator.js";
export type {
  DiagnosticReport,
  DiagnosticEvidence,
  FailureType,
} from "./agent/diagnostic-investigator.js";
