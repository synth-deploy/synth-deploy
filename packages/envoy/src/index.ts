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
  decision: "Envoy initialized",
  reasoning:
    `Envoy agent started with workspace at "${BASE_DIR}". ` +
    `Ready to receive deployment instructions from Command. ` +
    `Local state store is empty — this is a fresh start.`,
  context: {
    baseDir: BASE_DIR,
    port: PORT,
    host: HOST,
    commandUrl: COMMAND_URL || "(not configured — Envoy will not push reports to Command)",
  },
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
