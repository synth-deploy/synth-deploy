import crypto from "node:crypto";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyFormBody from "@fastify/formbody";
import fastifyMultipart from "@fastify/multipart";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PersistentDecisionDebrief, openEntityDatabase, PersistentPartitionStore, PersistentEnvironmentStore, PersistentSettingsStore, PersistentDeploymentStore, PersistentArtifactStore, PersistentSecurityBoundaryStore, PersistentTelemetryStore, PersistentUserStore, PersistentRoleStore, PersistentUserRoleStore, PersistentSessionStore, PersistentIdpProviderStore, PersistentRoleMappingStore, PersistentApiKeyStore, PersistentEnvoyRegistryStore, PersistentRegistryPollerVersionStore, PersistentAlertWebhookStore, LlmClient, buildLlmConfigFromSettings, initEdition, EditionError } from "@synth-deploy/core";
import type { Deployment, Artifact, ArtifactVersion, SecurityBoundary, Permission, RoleId } from "@synth-deploy/core";
import { SynthAgent } from "./agent/synth-agent.js";
import { EnvoyHealthChecker } from "./agent/health-checker.js";
import { McpClientManager } from "./agent/mcp-client-manager.js";
import { createMcpServer } from "./mcp/server.js";
import { registerOperationRoutes } from "./api/operations.js";
import { registerHealthRoutes } from "./api/health.js";
import { registerEnvoyReportRoutes } from "./api/envoy-reports.js";
import { registerArtifactRoutes } from "./api/artifacts.js";
import { registerSecurityBoundaryRoutes } from "./api/security-boundaries.js";
import { registerPartitionRoutes } from "./api/partitions.js";
import { registerEnvironmentRoutes } from "./api/environments.js";
import { registerAgentRoutes } from "./api/agent.js";
import { registerSettingsRoutes } from "./api/settings.js";
import { registerTelemetryRoutes } from "./api/telemetry.js";
import { registerEnvoyRoutes } from "./api/envoys.js";
import { EnvoyRegistry } from "./agent/envoy-registry.js";
import { EnvoyClient } from "./agent/envoy-client.js";
import { registerSystemRoutes } from "./api/system.js";
import { registerAuthMiddleware } from "./middleware/auth.js";
import { registerAuthRoutes } from "./api/auth.js";
import { registerApiKeyRoutes } from "./api/api-keys.js";
import { registerUserRoutes } from "./api/users.js";
import { registerIdpRoutes } from "./api/idp.js";
import { startStaleDeploymentScanner } from "./agent/stale-deployment-detector.js";
import { startRetentionScanner } from "./agent/debrief-retention.js";
import { ProgressEventStore } from "./api/progress-event-store.js";
import { registerFleetRoutes } from "./api/fleet.js";
import { FleetDeploymentStore, FleetExecutor } from "./fleet/index.js";
import { IntakeChannelStore, IntakeEventStore, IntakeProcessor, RegistryPoller } from "./intake/index.js";
import { registerIntakeRoutes } from "./api/intake.js";
import { registerAlertWebhookRoutes } from "./api/alert-webhooks.js";
import { ArtifactAnalyzer } from "./artifact-analyzer.js";
import { DeploymentGraphStore, GraphInferenceEngine } from "./graph/index.js";
import { registerGraphRoutes } from "./api/graph.js";
import { initServerLogger } from "./logger.js";

// --- Bootstrap shared state ---

// Default to repo-root/data, resolved relative to this file so it's consistent
// regardless of the working directory when the server is started.
const __serverDir = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SYNTH_DATA_DIR
  ? path.resolve(process.env.SYNTH_DATA_DIR)
  : path.resolve(__serverDir, "../../../data");
mkdirSync(DATA_DIR, { recursive: true });
chmodSync(DATA_DIR, 0o700);
initServerLogger(DATA_DIR);

// --- JWT secret — auto-generated on first run, persisted to disk ---
// SYNTH_JWT_SECRET env var takes precedence (for CI, multi-instance, key rotation).
// When absent, a secret is generated once and stored at DATA_DIR/jwt-secret (mode 0600).
const JWT_SECRET_FILE = path.join(DATA_DIR, "jwt-secret");
function resolveJwtSecret(): string {
  if (process.env.SYNTH_JWT_SECRET) return process.env.SYNTH_JWT_SECRET;
  if (existsSync(JWT_SECRET_FILE)) return readFileSync(JWT_SECRET_FILE, "utf-8").trim();
  const generated = crypto.randomBytes(32).toString("hex");
  writeFileSync(JWT_SECRET_FILE, generated, { mode: 0o600 });
  console.log(`[Synth] Generated JWT secret — stored at ${JWT_SECRET_FILE}`);
  return generated;
}
const resolvedJwtSecret = resolveJwtSecret();

const debrief = new PersistentDecisionDebrief(path.join(DATA_DIR, "debrief.db"));
const entityDb = openEntityDatabase(path.join(DATA_DIR, "synth.db"));
const hasDedicatedEncryptionKey = !!process.env.SYNTH_ENCRYPTION_KEY;
const idpEncryptionSecret = process.env.SYNTH_ENCRYPTION_KEY ?? resolvedJwtSecret;
const partitions = new PersistentPartitionStore(entityDb);
const environments = new PersistentEnvironmentStore(entityDb);
const settings = new PersistentSettingsStore(entityDb, idpEncryptionSecret);
const deployments = new PersistentDeploymentStore(entityDb);
const artifactStore = new PersistentArtifactStore(entityDb);
const securityBoundaryStore = new PersistentSecurityBoundaryStore(entityDb);
const telemetryStore = new PersistentTelemetryStore(entityDb);
const userStore = new PersistentUserStore(entityDb);
const roleStore = new PersistentRoleStore(entityDb);
const userRoleStore = new PersistentUserRoleStore(entityDb, roleStore);
const sessionStore = new PersistentSessionStore(entityDb);
const apiKeyStore = new PersistentApiKeyStore(entityDb);
const idpProviderStore = new PersistentIdpProviderStore(entityDb, idpEncryptionSecret);
const roleMappingStore = new PersistentRoleMappingStore(entityDb);

// Load persisted LLM API key into env if not already set via environment
if (!process.env.SYNTH_LLM_API_KEY) {
  const storedKey = settings.getSecret("llm_api_key");
  if (storedKey) process.env.SYNTH_LLM_API_KEY = storedKey;
}

// Require SYNTH_ENCRYPTION_KEY when IdP providers are configured
if (!hasDedicatedEncryptionKey && idpProviderStore.list().length > 0) {
  console.error(
    "[Synth] FATAL: SYNTH_ENCRYPTION_KEY is not set but IdP providers are configured. " +
    "A dedicated encryption key is required to protect IdP client secrets at rest. " +
    "Set SYNTH_ENCRYPTION_KEY to a dedicated secret separate from SYNTH_JWT_SECRET. Exiting.",
  );
  process.exit(1);
}

// Startup validation — log warnings for missing optional env vars
if (!process.env.SYNTH_LLM_API_KEY) {
  console.warn("[Synth] WARNING: SYNTH_LLM_API_KEY is not set. LLM features will be unavailable until configured via settings.");
}
if (!process.env.SYNTH_DATA_DIR) {
  console.warn("[Synth] WARNING: SYNTH_DATA_DIR is not set. Using default ./data directory.");
}

// --- Resolve edition (Community or Enterprise) ---
initEdition();

const envoyRegistryStore = new PersistentEnvoyRegistryStore(entityDb);
const envoyRegistry = new EnvoyRegistry(envoyRegistryStore);

const envoyUrl = process.env.SYNTH_ENVOY_URL ?? "http://localhost:9411";

const jwtSecret: Uint8Array = new TextEncoder().encode(resolvedJwtSecret);

// --- Seed default roles ---
const ALL_PERMISSIONS: Permission[] = [
  "deployment.create", "deployment.approve", "deployment.reject", "deployment.view", "deployment.rollback",
  "artifact.create", "artifact.update", "artifact.annotate", "artifact.delete", "artifact.view",
  "environment.create", "environment.update", "environment.delete", "environment.view",
  "partition.create", "partition.update", "partition.delete", "partition.view",
  "envoy.register", "envoy.configure", "envoy.view",
  "settings.manage", "users.manage", "roles.manage",
];

const DEPLOYER_PERMISSIONS: Permission[] = [
  "deployment.create", "deployment.approve", "deployment.reject", "deployment.view", "deployment.rollback",
  "artifact.create", "artifact.update", "artifact.annotate", "artifact.view",
  "environment.view",
  "partition.view",
  "envoy.view",
];

const VIEWER_PERMISSIONS: Permission[] = [
  "deployment.view",
  "artifact.view",
  "environment.view",
  "partition.view",
  "envoy.view",
];

if (roleStore.list().length === 0) {
  roleStore.create({
    id: crypto.randomUUID() as RoleId,
    name: "Admin",
    permissions: ALL_PERMISSIONS,
    isBuiltIn: true,
    createdAt: new Date(),
  });
  roleStore.create({
    id: crypto.randomUUID() as RoleId,
    name: "Deployer",
    permissions: DEPLOYER_PERMISSIONS,
    isBuiltIn: true,
    createdAt: new Date(),
  });
  roleStore.create({
    id: crypto.randomUUID() as RoleId,
    name: "Viewer",
    permissions: VIEWER_PERMISSIONS,
    isBuiltIn: true,
    createdAt: new Date(),
  });
  console.log("[Synth] Seeded default roles: Admin, Deployer, Viewer");
}
const healthCheckerUrl = settings.get().envoy?.url;
const healthChecker = healthCheckerUrl ? new EnvoyHealthChecker(healthCheckerUrl) : undefined;
const agent = new SynthAgent(debrief, deployments, artifactStore, environments, partitions, healthChecker, {}, settings);
// Initialize server LLM client — picks up provider from env or settings
const llmSettings = settings.get().llm;
const llm = new LlmClient(debrief, "server", buildLlmConfigFromSettings(llmSettings));
if (llm.isAvailable()) {
  console.log(`[Synth] LLM available for artifact analysis (provider: ${llmSettings?.provider ?? "anthropic"})`);
} else {
  console.warn("[Synth] LLM not available for artifact analysis — set SYNTH_LLM_API_KEY or configure via Settings");
}
const artifactAnalyzer = new ArtifactAnalyzer({ llm, debrief });

// --- Connect to external MCP servers (if configured) ---

const mcpClientManager = new McpClientManager();
const mcpServerConfigs = settings.get().mcpServers ?? [];
if (mcpServerConfigs.length > 0) {
  await mcpClientManager.connectAll(mcpServerConfigs);
  const connected = mcpClientManager.getConnectedServers();
  if (connected.length > 0) {
    console.log(`[MCP Client] Connected to ${connected.length} external server(s): ${connected.join(", ")}`);
  }
}
agent.mcpClientManager = mcpClientManager;

// --- Seed demo data so the server is immediately usable ---

if (process.env.SYNTH_SEED_DEMO !== 'false' && partitions.list().length === 0) {
  function hoursAgo(h: number): Date { return new Date(Date.now() - h * 3600_000); }

  // Environments
  const prodEnv = environments.create("production", { APP_ENV: "production", LOG_LEVEL: "warn" });
  const stagingEnv = environments.create("staging", { APP_ENV: "staging", LOG_LEVEL: "debug" });
  const devEnv = environments.create("development", { APP_ENV: "development", LOG_LEVEL: "trace" });

  // Partitions
  const acmePartition = partitions.create("Acme Corp", { APP_ENV: "production", DB_HOST: "acme-db-1", REGION: "us-east-1" });
  const globexPartition = partitions.create("Globex Industries", { APP_ENV: "production", DB_HOST: "globex-db-1", REGION: "eu-west-1" });
  const initechPartition = partitions.create("Initech", { APP_ENV: "production", DB_HOST: "initech-db-1", REGION: "us-west-2" });

  // --- Artifacts with analysis, versions, and annotations ---

  const webAppArtifact = artifactStore.create({
    name: "web-app",
    type: "nodejs",
    analysis: {
      summary: "Node.js web application with Express backend and React frontend. Requires PostgreSQL and Redis.",
      dependencies: ["postgresql", "redis", "node:20"],
      configurationExpectations: { DB_HOST: "PostgreSQL hostname", REDIS_URL: "Redis connection string", APP_ENV: "Runtime environment" },
      deploymentIntent: "Rolling deployment with zero-downtime via health check gating",
      confidence: 0.92,
    },
    annotations: [
      { field: "dependencies", correction: "Added redis dependency — missed in initial analysis", annotatedBy: "operator", annotatedAt: hoursAgo(48) },
    ],
    learningHistory: [
      { timestamp: hoursAgo(96), event: "initial-analysis", details: "First artifact analysis completed from Dockerfile and package.json" },
      { timestamp: hoursAgo(48), event: "annotation-applied", details: "Operator corrected missing redis dependency" },
      { timestamp: hoursAgo(24), event: "reanalysis", details: "Re-analyzed after v2.4.1 deployment — confidence improved from 0.85 to 0.92" },
    ],
  });

  const apiArtifact = artifactStore.create({
    name: "api-service",
    type: "docker",
    analysis: {
      summary: "Containerized REST API service. Stateless, scales horizontally. Requires connection to shared PostgreSQL.",
      dependencies: ["postgresql", "docker-runtime"],
      configurationExpectations: { API_URL: "Service endpoint URL", DB_HOST: "PostgreSQL hostname" },
      deploymentIntent: "Blue-green deployment with endpoint health verification",
      confidence: 0.88,
    },
    annotations: [],
    learningHistory: [
      { timestamp: hoursAgo(72), event: "initial-analysis", details: "Analyzed from Dockerfile and docker-compose.yml" },
      { timestamp: hoursAgo(36), event: "failure-learning", details: "v1.11.0 failed due to port conflict — added pre-deploy cleanup recommendation" },
    ],
  });

  const workerArtifact = artifactStore.create({
    name: "worker-service",
    type: "binary",
    analysis: {
      summary: "Compiled Go binary for background job processing. Reads from RabbitMQ, writes to PostgreSQL.",
      dependencies: ["rabbitmq", "postgresql"],
      configurationExpectations: { QUEUE_URL: "RabbitMQ connection string", DB_HOST: "PostgreSQL hostname" },
      deploymentIntent: "Stop-deploy-start with queue depth verification",
      confidence: 0.95,
    },
    annotations: [
      { field: "deploymentIntent", correction: "Changed from rolling to stop-deploy-start — workers must fully drain before restart", annotatedBy: "operator", annotatedAt: hoursAgo(20) },
    ],
    learningHistory: [
      { timestamp: hoursAgo(80), event: "initial-analysis", details: "Analyzed from Makefile and systemd unit file" },
      { timestamp: hoursAgo(20), event: "annotation-applied", details: "Operator corrected deployment strategy to stop-deploy-start" },
      { timestamp: hoursAgo(3), event: "successful-deployment", details: "v3.0.0 deployed successfully with corrected strategy" },
    ],
  });

  // Artifact versions
  artifactStore.addVersion({ artifactId: webAppArtifact.id, version: "2.3.0", source: "npm-registry", metadata: { commit: "abc1234", builtBy: "ci" } });
  artifactStore.addVersion({ artifactId: webAppArtifact.id, version: "2.4.0", source: "npm-registry", metadata: { commit: "def5678", builtBy: "ci" } });
  artifactStore.addVersion({ artifactId: webAppArtifact.id, version: "2.4.1", source: "npm-registry", metadata: { commit: "ghi9012", builtBy: "ci", hotfix: "true" } });
  artifactStore.addVersion({ artifactId: webAppArtifact.id, version: "2.5.0-rc.1", source: "npm-registry", metadata: { commit: "jkl3456", builtBy: "ci", prerelease: "true" } });

  artifactStore.addVersion({ artifactId: apiArtifact.id, version: "1.11.0", source: "docker-registry", metadata: { image: "api-service:1.11.0", digest: "sha256:a4f8e" } });
  artifactStore.addVersion({ artifactId: apiArtifact.id, version: "1.12.0", source: "docker-registry", metadata: { image: "api-service:1.12.0", digest: "sha256:b5c9f" } });
  artifactStore.addVersion({ artifactId: apiArtifact.id, version: "1.13.0-beta.2", source: "docker-registry", metadata: { image: "api-service:1.13.0-beta.2", digest: "sha256:c6d0a", prerelease: "true" } });

  artifactStore.addVersion({ artifactId: workerArtifact.id, version: "2.9.0", source: "github-releases", metadata: { commit: "mno7890", binary: "worker-linux-amd64" } });
  artifactStore.addVersion({ artifactId: workerArtifact.id, version: "3.0.0", source: "github-releases", metadata: { commit: "pqr1234", binary: "worker-linux-amd64", majorUpgrade: "true" } });

  // --- Deployments (mix of statuses and ages) ---

  const dep1: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: webAppArtifact.id }, partitionId: acmePartition.id as Deployment["partitionId"],
    environmentId: prodEnv.id as Deployment["environmentId"], version: "2.3.0", status: "succeeded",
    variables: { ...acmePartition.variables, ...prodEnv.variables },
    plan: {
      scriptedPlan: {
        platform: "bash",
        executionScript: "#!/usr/bin/env bash\nset -euo pipefail\nsystemctl stop web-app\ncp -r /opt/web-app/ /opt/web-app.bak/\ntar -xzf /opt/releases/web-app-2.3.0.tar.gz -C /opt/web-app/\nenvsubst < /opt/web-app/config.template > /opt/web-app/.env\nsystemctl start web-app\ncurl -f --retry 3 --retry-delay 5 http://localhost:8080/health",
        dryRunScript: null,
        rollbackScript: "#!/usr/bin/env bash\nset -euo pipefail\nsystemctl stop web-app\ncp -r /opt/web-app.bak/ /opt/web-app/\ncp /opt/web-app.bak/.env /opt/web-app/.env\nsystemctl start web-app",
        reasoning: "Standard 5-step deploy: stop, backup, extract, config, start. One config change: API_ENDPOINT updated to v2 endpoint validated in staging for 4h.",
        stepSummary: [
          { description: "Stop service", reversible: true },
          { description: "Backup current binaries", reversible: false },
          { description: "Deploy new artifact", reversible: true },
          { description: "Apply environment config (1 variable changed: API_ENDPOINT)", reversible: true },
          { description: "Start service and verify health endpoint → 200 OK", reversible: true },
        ],
        diffFromCurrent: [
          { key: "API_ENDPOINT", from: "https://api.acme.corp/v1", to: "https://api.acme.corp/v2" },
        ],
      },
      reasoning: "Standard 5-step deploy: stop, backup, extract, config, start. One config change: API_ENDPOINT updated to v2 endpoint validated in staging for 4h.",
      diffFromCurrent: [
        { key: "API_ENDPOINT", from: "https://api.acme.corp/v1", to: "https://api.acme.corp/v2" },
      ],
    },
    debriefEntryIds: [],
    createdAt: hoursAgo(72), completedAt: hoursAgo(71.5), failureReason: undefined,
  };
  const dep2: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: webAppArtifact.id }, partitionId: acmePartition.id as Deployment["partitionId"],
    environmentId: prodEnv.id as Deployment["environmentId"], version: "2.4.0", status: "succeeded",
    variables: { ...acmePartition.variables, ...prodEnv.variables },
    debriefEntryIds: [],
    createdAt: hoursAgo(48), completedAt: hoursAgo(47.8), failureReason: undefined,
  };
  const dep3: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: webAppArtifact.id }, partitionId: acmePartition.id as Deployment["partitionId"],
    environmentId: prodEnv.id as Deployment["environmentId"], version: "2.4.1", status: "succeeded",
    variables: { ...acmePartition.variables, ...prodEnv.variables },
    debriefEntryIds: [],
    createdAt: hoursAgo(24), completedAt: hoursAgo(23.7), failureReason: undefined,
  };
  const dep4: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: apiArtifact.id }, partitionId: acmePartition.id as Deployment["partitionId"],
    environmentId: prodEnv.id as Deployment["environmentId"], version: "1.11.0", status: "failed",
    variables: { ...acmePartition.variables, ...prodEnv.variables },
    debriefEntryIds: [],
    createdAt: hoursAgo(36), completedAt: hoursAgo(35.9),
    failureReason: "Health check failed after 3 retries: connection refused on port 8080",
  };
  const dep5: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: apiArtifact.id }, partitionId: acmePartition.id as Deployment["partitionId"],
    environmentId: prodEnv.id as Deployment["environmentId"], version: "1.12.0", status: "succeeded",
    variables: { ...acmePartition.variables, ...prodEnv.variables },
    debriefEntryIds: [],
    createdAt: hoursAgo(12), completedAt: hoursAgo(11.8), failureReason: undefined,
  };
  const dep6: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: webAppArtifact.id }, partitionId: globexPartition.id as Deployment["partitionId"],
    environmentId: stagingEnv.id as Deployment["environmentId"], version: "2.5.0-rc.1", status: "succeeded",
    variables: { ...globexPartition.variables, ...stagingEnv.variables },
    debriefEntryIds: [],
    createdAt: hoursAgo(6), completedAt: hoursAgo(5.8), failureReason: undefined,
  };
  const dep7: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: workerArtifact.id }, partitionId: initechPartition.id as Deployment["partitionId"],
    environmentId: prodEnv.id as Deployment["environmentId"], version: "2.9.0", status: "failed",
    variables: { ...initechPartition.variables, ...prodEnv.variables },
    debriefEntryIds: [],
    createdAt: hoursAgo(18), completedAt: hoursAgo(17.8),
    failureReason: "Queue depth exceeded threshold (342 > 100) during verification",
  };
  const dep8: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: workerArtifact.id }, partitionId: initechPartition.id as Deployment["partitionId"],
    environmentId: prodEnv.id as Deployment["environmentId"], version: "3.0.0", status: "succeeded",
    variables: { ...initechPartition.variables, ...prodEnv.variables },
    debriefEntryIds: [],
    createdAt: hoursAgo(3), completedAt: hoursAgo(2.7), failureReason: undefined,
  };
  const dep9: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: apiArtifact.id }, partitionId: globexPartition.id as Deployment["partitionId"],
    environmentId: stagingEnv.id as Deployment["environmentId"], version: "1.13.0-beta.2", status: "running",
    variables: { ...globexPartition.variables, ...stagingEnv.variables },
    plan: {
      scriptedPlan: {
        platform: "bash",
        executionScript: "#!/usr/bin/env bash\nset -euo pipefail\ndocker pull registry.internal/api:1.13.0-beta.2\ndocker stop api-staging\ndocker run -d --name api-staging --env-file /opt/api/.env -p 8080:8080 registry.internal/api:1.13.0-beta.2\ncurl -f --retry 3 --retry-delay 5 http://localhost:8080/health",
        dryRunScript: null,
        rollbackScript: "#!/usr/bin/env bash\nset -euo pipefail\ndocker stop api-staging\ndocker pull registry.internal/api:1.12.0\ndocker start api-staging",
        reasoning: "Container swap: pull new image, stop old container, start new one, verify health. Staging environment — rollback is fast via image tag swap.",
        stepSummary: [
          { description: "Pull latest image from registry", reversible: true },
          { description: "Stop running container", reversible: true },
          { description: "Start new container with updated image", reversible: true },
          { description: "Verify health endpoint returns 200", reversible: false },
        ],
      },
      reasoning: "Container swap: pull new image, stop old container, start new one, verify health. Staging environment — rollback is fast via image tag swap.",
    },
    debriefEntryIds: [],
    createdAt: hoursAgo(0.5),
  };
  const dep11: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: workerArtifact.id }, partitionId: globexPartition.id as Deployment["partitionId"],
    environmentId: prodEnv.id as Deployment["environmentId"], version: "3.1.0", status: "awaiting_approval",
    variables: { ...globexPartition.variables, ...prodEnv.variables },
    plan: {
      scriptedPlan: {
        platform: "bash",
        executionScript: "#!/usr/bin/env bash\nset -euo pipefail\nnpm run worker:drain --timeout=120\nsystemctl stop synth-worker\ncp -r /opt/releases/worker-3.1.0/* /opt/worker/\nenvsubst < /opt/worker/config.template > /opt/worker/.env\nsystemctl start synth-worker\ncurl -f --retry 6 --retry-delay 5 http://localhost:9090/metrics",
        dryRunScript: null,
        rollbackScript: "#!/usr/bin/env bash\nset -euo pipefail\nsystemctl stop synth-worker\ncp -r /opt/worker.bak/* /opt/worker/\ncp /opt/worker.bak/.env /opt/worker/.env\nsystemctl start synth-worker",
        reasoning: "Worker upgrade with concurrency increase. Drain first to avoid job loss, then replace binary and config atomically. Queue depth check confirms processing resumed.",
        stepSummary: [
          { description: "Drain queue — wait for in-flight jobs to complete", reversible: false },
          { description: "Stop worker processes on all nodes", reversible: true },
          { description: "Deploy new worker binary", reversible: true },
          { description: "Update queue concurrency config (WORKER_CONCURRENCY: 4 → 8)", reversible: true },
          { description: "Start worker and verify queue depth drops", reversible: true },
          { description: "Verify queue processing resumes within 30s", reversible: false },
        ],
      },
      reasoning: "Worker upgrade with concurrency increase. Drain first to avoid job loss, then replace binary and config atomically. Queue depth check confirms processing resumed.",
    },
    debriefEntryIds: [],
    createdAt: hoursAgo(0.1),
  };
  const dep10: Deployment = {
    id: crypto.randomUUID() as Deployment["id"], input: { type: "deploy" as const, artifactId: webAppArtifact.id }, partitionId: initechPartition.id as Deployment["partitionId"],
    environmentId: prodEnv.id as Deployment["environmentId"], version: "2.4.1", status: "rolled_back",
    variables: { ...initechPartition.variables, ...prodEnv.variables },
    debriefEntryIds: [],
    createdAt: hoursAgo(8), completedAt: hoursAgo(7.5),
    failureReason: "Rolled back after post-deploy smoke test detected 502 errors on /api/v2/users",
  };

  for (const d of [dep1, dep2, dep3, dep4, dep5, dep6, dep7, dep8, dep9, dep10, dep11]) {
    deployments.save(d);
  }

  // --- Security boundaries for envoys ---

  const envoyId = "envoy-prod-1";
  securityBoundaryStore.set(envoyId, [
    { id: crypto.randomUUID(), envoyId, boundaryType: "filesystem", config: { allowedPaths: ["/opt/synth", "/var/log/synth"], readOnly: ["/etc"], denied: ["/root", "/home"] } },
    { id: crypto.randomUUID(), envoyId, boundaryType: "network", config: { allowedHosts: ["db.internal", "redis.internal", "registry.internal"], allowedPorts: [5432, 6379, 443], deniedCidrs: ["10.0.0.0/8"] } },
    { id: crypto.randomUUID(), envoyId, boundaryType: "execution", config: { allowedCommands: ["docker", "npm", "systemctl", "curl"], deniedCommands: ["rm -rf", "dd", "mkfs"], maxTimeoutMs: 300000 } },
    { id: crypto.randomUUID(), envoyId, boundaryType: "credential", config: { allowedSecretPaths: ["synth/*"], deniedSecretPaths: ["admin/*", "root/*"], rotationRequired: true } },
  ]);

  const stagingEnvoyId = "envoy-staging-1";
  securityBoundaryStore.set(stagingEnvoyId, [
    { id: crypto.randomUUID(), envoyId: stagingEnvoyId, boundaryType: "filesystem", config: { allowedPaths: ["/opt/synth", "/var/log", "/tmp"], readOnly: ["/etc"] } },
    { id: crypto.randomUUID(), envoyId: stagingEnvoyId, boundaryType: "network", config: { allowedHosts: ["*"], allowedPorts: [5432, 6379, 443, 8080], deniedCidrs: [] } },
    { id: crypto.randomUUID(), envoyId: stagingEnvoyId, boundaryType: "execution", config: { allowedCommands: ["docker", "npm", "systemctl", "curl", "node"], deniedCommands: ["rm -rf"], maxTimeoutMs: 600000 } },
  ]);

  // --- Debrief entries (rich decision diary) ---

  debrief.record({
    partitionId: null, operationId: null, agent: "server", decisionType: "system",
    decision: "Command initialized with demo data",
    reasoning: "Seeded 3 partitions, 3 environments, 3 artifacts, 10 deployments, and 2 envoy security boundary sets.",
    context: { partitions: 3, environments: 3, deployments: 10, artifacts: 3, securityBoundaries: 2 },
  });

  // dep1 — web-app 2.3.0 succeeded
  debrief.record({
    partitionId: acmePartition.id, operationId: dep1.id, agent: "server", decisionType: "pipeline-plan",
    decision: "Planned deployment pipeline for web-app v2.3.0 to Acme Corp production",
    reasoning: "Standard 3-step pipeline: install deps, run migrations, health check. No variable conflicts.",
    context: { version: "2.3.0", steps: 3 },
  });
  debrief.record({
    partitionId: acmePartition.id, operationId: dep1.id, agent: "server", decisionType: "configuration-resolved",
    decision: "Resolved 4 variables for Acme Corp production (partition + environment merged)",
    reasoning: "Merged partition variables (APP_ENV, DB_HOST, REGION) with environment variables (APP_ENV, LOG_LEVEL). APP_ENV conflict resolved: environment value takes precedence.",
    context: { resolvedCount: 4, conflicts: 1, policy: "environment-wins" },
  });
  debrief.record({
    partitionId: acmePartition.id, operationId: dep1.id, agent: "envoy", decisionType: "deployment-execution",
    decision: "Executed deployment web-app v2.3.0 on Acme Corp production",
    reasoning: "All 3 steps completed. Total execution time: 28.4s.",
    context: { duration: 28400 },
  });
  debrief.record({
    partitionId: acmePartition.id, operationId: dep1.id, agent: "envoy", decisionType: "health-check",
    decision: "Health check passed on first attempt",
    reasoning: "GET /health returned 200 with body {\"status\":\"ok\"} in 45ms.",
    context: { attempts: 1, responseTime: 45 },
  });
  debrief.record({
    partitionId: acmePartition.id, operationId: dep1.id, agent: "server", decisionType: "deployment-completion",
    decision: "Deployment web-app v2.3.0 completed successfully",
    reasoning: "All pipeline steps passed. Health check confirmed. Marked as succeeded.",
    context: { status: "succeeded" },
  });

  // dep4 — api-service 1.11.0 failed
  debrief.record({
    partitionId: acmePartition.id, operationId: dep4.id, agent: "server", decisionType: "pipeline-plan",
    decision: "Planned deployment pipeline for api-service v1.11.0 to Acme Corp production",
    reasoning: "2-step pipeline: pull image, verify endpoint.",
    context: { version: "1.11.0", steps: 2 },
  });
  debrief.record({
    partitionId: acmePartition.id, operationId: dep4.id, agent: "envoy", decisionType: "deployment-execution",
    decision: "Image pull succeeded, starting verification",
    reasoning: "docker pull completed in 12.3s. Image sha256:a4f8e... verified.",
    context: { step: "Pull image", duration: 12300 },
  });
  debrief.record({
    partitionId: acmePartition.id, operationId: dep4.id, agent: "envoy", decisionType: "health-check",
    decision: "Health check failed after 3 retries",
    reasoning: "Connection refused on port 8080. Retry 1: refused (5s). Retry 2: refused (10s). Retry 3: refused (15s). Container logs: \"Error: EADDRINUSE :::8080\".",
    context: { attempts: 3, lastError: "ECONNREFUSED", containerLog: "EADDRINUSE" },
  });
  debrief.record({
    partitionId: acmePartition.id, operationId: dep4.id, agent: "envoy", decisionType: "diagnostic-investigation",
    decision: "Root cause: port 8080 bound by stale process from previous deployment",
    reasoning: "Found zombie process from api-service v1.10.0 holding port 8080. Previous deployment did not cleanly shut down.",
    context: { rootCause: "port-conflict", stalePid: 14823 },
  });
  debrief.record({
    partitionId: acmePartition.id, operationId: dep4.id, agent: "server", decisionType: "deployment-failure",
    decision: "Deployment api-service v1.11.0 failed — health check could not connect",
    reasoning: "Envoy diagnostic identified port conflict from stale process. Recommend adding a pre-deploy cleanup step.",
    context: { status: "failed", recommendation: "Add cleanup step" },
  });

  // dep7 — worker-service 2.9.0 failed
  debrief.record({
    partitionId: initechPartition.id, operationId: dep7.id, agent: "server", decisionType: "pipeline-plan",
    decision: "Planned deployment pipeline for worker-service v2.9.0 to Initech production",
    reasoning: "4-step pipeline with full verification strategy.",
    context: { version: "2.9.0", steps: 4, verificationStrategy: "full" },
  });
  debrief.record({
    partitionId: initechPartition.id, operationId: dep7.id, agent: "envoy", decisionType: "deployment-execution",
    decision: "Workers stopped and binary deployed successfully",
    reasoning: "Pre-deploy steps completed. Workers stopped gracefully (0 in-flight jobs lost). Binary copied.",
    context: { stepsCompleted: 2, jobsLost: 0 },
  });
  debrief.record({
    partitionId: initechPartition.id, operationId: dep7.id, agent: "envoy", decisionType: "deployment-verification",
    decision: "Verification failed: queue depth 342 exceeds threshold of 100",
    reasoning: "Workers restarted but queue depth grew rapidly. v2.9.0 introduced a regression in the message processing loop causing 10x slowdown.",
    context: { queueDepth: 342, threshold: 100, processingRate: "0.3/s vs expected 3/s" },
  });
  debrief.record({
    partitionId: initechPartition.id, operationId: dep7.id, agent: "server", decisionType: "deployment-failure",
    decision: "Deployment worker-service v2.9.0 failed — queue depth exceeded threshold",
    reasoning: "Queue depth check returned 342 (max 100). Processing regression in v2.9.0.",
    context: { status: "failed" },
  });

  // dep10 — web-app 2.4.1 rolled back
  debrief.record({
    partitionId: initechPartition.id, operationId: dep10.id, agent: "server", decisionType: "pipeline-plan",
    decision: "Planned deployment pipeline for web-app v2.4.1 to Initech production",
    reasoning: "Standard 3-step pipeline.",
    context: { version: "2.4.1", steps: 3 },
  });
  debrief.record({
    partitionId: initechPartition.id, operationId: dep10.id, agent: "envoy", decisionType: "deployment-execution",
    decision: "All deployment steps completed, starting post-deploy verification",
    reasoning: "Dependencies installed (14.2s), migrations ran (3.1s), health check passed (0.2s).",
    context: { totalDuration: 17500 },
  });
  debrief.record({
    partitionId: initechPartition.id, operationId: dep10.id, agent: "envoy", decisionType: "deployment-verification",
    decision: "Post-deploy smoke test detected 502 errors on /api/v2/users",
    reasoning: "12 endpoint checks: 10 passed, 2 returned 502 (GET and POST /api/v2/users). The v2 users endpoint depends on a schema migration that was partially applied.",
    context: { passed: 10, failed: 2, failedEndpoints: ["/api/v2/users"] },
  });
  debrief.record({
    partitionId: initechPartition.id, operationId: dep10.id, agent: "server", decisionType: "deployment-failure",
    decision: "Initiated rollback of web-app v2.4.1 on Initech production",
    reasoning: "502 errors on critical user endpoints. Rolling back to previous known-good version.",
    context: { status: "rolled_back", rolledBackFrom: "2.4.1" },
  });

  // dep6 — web-app 2.5.0-rc.1 with variable conflict
  debrief.record({
    partitionId: globexPartition.id, operationId: dep6.id, agent: "server", decisionType: "pipeline-plan",
    decision: "Planned deployment for web-app v2.5.0-rc.1 to Globex staging",
    reasoning: "Standard 3-step pipeline. Release candidate — permissive conflict policy.",
    context: { version: "2.5.0-rc.1", steps: 3 },
  });
  debrief.record({
    partitionId: globexPartition.id, operationId: dep6.id, agent: "server", decisionType: "variable-conflict",
    decision: "Variable conflict: APP_ENV defined in both partition and environment",
    reasoning: "Partition sets APP_ENV=production, environment sets APP_ENV=staging. Permissive policy — using environment value.",
    context: { variable: "APP_ENV", partitionValue: "production", environmentValue: "staging", resolution: "environment-wins" },
  });
  debrief.record({
    partitionId: globexPartition.id, operationId: dep6.id, agent: "server", decisionType: "deployment-completion",
    decision: "Deployment web-app v2.5.0-rc.1 completed on Globex staging",
    reasoning: "All steps passed despite variable conflict. RC verified in staging.",
    context: { status: "succeeded" },
  });

  // dep9 — in-progress
  debrief.record({
    partitionId: globexPartition.id, operationId: dep9.id, agent: "server", decisionType: "pipeline-plan",
    decision: "Planned deployment for api-service v1.13.0-beta.2 to Globex staging",
    reasoning: "2-step pipeline for staging. Beta version — monitoring closely.",
    context: { version: "1.13.0-beta.2", steps: 2 },
  });
  debrief.record({
    partitionId: globexPartition.id, operationId: dep9.id, agent: "envoy", decisionType: "deployment-execution",
    decision: "Image pull in progress for api-service v1.13.0-beta.2",
    reasoning: "Pulling docker image from registry. Download progress: 67%.",
    context: { step: "Pull image", progress: "67%" },
  });

  // Environment scans
  debrief.record({
    partitionId: acmePartition.id, operationId: null, agent: "envoy", decisionType: "environment-scan",
    decision: "Environment scan completed for Acme Corp production",
    reasoning: "Current versions: web-app v2.4.1, api-service v1.12.0. Disk: 62%. Memory: 71%. No drift detected.",
    context: { versions: { "web-app": "2.4.1", "api-service": "1.12.0" }, diskUsage: "62%", memoryUsage: "71%" },
  });
  debrief.record({
    partitionId: initechPartition.id, operationId: null, agent: "envoy", decisionType: "environment-scan",
    decision: "Environment scan for Initech production — drift detected",
    reasoning: "worker-service v3.0.0 running. web-app at v2.4.0 (v2.4.1 was rolled back). Drift: LOG_LEVEL manually changed from 'warn' to 'debug' outside deployment pipeline.",
    context: { drift: true, driftDetails: "LOG_LEVEL changed outside pipeline" },
  });

  console.log('Demo seed data created (set SYNTH_SEED_DEMO=false to disable)');
} else if (process.env.SYNTH_SEED_DEMO === 'false') {
  console.log('Demo seed data skipped (SYNTH_SEED_DEMO=false)');
} else {
  console.log('Demo seed data skipped (database already populated)');
}

// Seed demo envoys on every startup when demo mode is on — the registry is
// in-memory so it's always empty at boot, regardless of DB state.
if (process.env.SYNTH_SEED_DEMO !== 'false') {
  const secsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

  const e1 = envoyRegistry.register({ name: "stg-web-01", url: "http://stg-web-01.internal:8080", assignedEnvironments: ["staging"] });
  e1.lastHealthStatus = "healthy"; e1.lastHealthCheck = secsAgo(12);
  e1.cachedHostname = "stg-web-01.acme.internal"; e1.cachedOs = "Ubuntu 22.04";
  e1.cachedSummary = { totalDeployments: 47, succeeded: 45, failed: 2, executing: 0, environments: 1 };
  e1.cachedReadiness = { ready: true, reason: "Workspace is ready for deployments." };

  const e2 = envoyRegistry.register({ name: "stg-web-02", url: "http://stg-web-02.internal:8080", assignedEnvironments: ["staging"] });
  e2.lastHealthStatus = "healthy"; e2.lastHealthCheck = secsAgo(8);
  e2.cachedHostname = "stg-web-02.acme.internal"; e2.cachedOs = "Ubuntu 22.04";
  e2.cachedSummary = { totalDeployments: 44, succeeded: 43, failed: 1, executing: 0, environments: 1 };
  e2.cachedReadiness = { ready: true, reason: "Workspace is ready for deployments." };

  const e3 = envoyRegistry.register({ name: "prd-web-01", url: "http://prd-web-01.internal:8080", assignedEnvironments: ["production"] });
  e3.lastHealthStatus = "healthy"; e3.lastHealthCheck = secsAgo(3);
  e3.cachedHostname = "prd-web-01.acme.internal"; e3.cachedOs = "Ubuntu 22.04";
  e3.cachedSummary = { totalDeployments: 112, succeeded: 110, failed: 2, executing: 0, environments: 1 };
  e3.cachedReadiness = { ready: true, reason: "Workspace is ready for deployments." };

  const e4 = envoyRegistry.register({ name: "prd-web-02", url: "http://prd-web-02.internal:8080", assignedEnvironments: ["production"] });
  e4.lastHealthStatus = "degraded"; e4.lastHealthCheck = secsAgo(45);
  e4.cachedHostname = "prd-web-02.acme.internal"; e4.cachedOs = "Ubuntu 20.04";
  e4.cachedSummary = { totalDeployments: 108, succeeded: 104, failed: 4, executing: 0, environments: 1 };
  e4.cachedReadiness = { ready: false, reason: "Heartbeat degraded — 45s since last check-in." };

  const e5 = envoyRegistry.register({ name: "prd-batch-01", url: "http://prd-batch-01.internal:8080", assignedEnvironments: ["production"] });
  e5.lastHealthStatus = "healthy"; e5.lastHealthCheck = secsAgo(6);
  e5.cachedHostname = "prd-batch-01.acme.internal"; e5.cachedOs = "Windows Server 2022";
  e5.cachedSummary = { totalDeployments: 23, succeeded: 23, failed: 0, executing: 0, environments: 1 };
  e5.cachedReadiness = { ready: true, reason: "Workspace is ready for deployments." };
}

// --- Create MCP server ---

const mcp = createMcpServer({ agent, debrief, partitions, environments, deployments, artifactStore });

// --- Create Fastify HTTP server ---

const app = Fastify({ logger: true });

// Map EditionError → 402 Payment Required
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof EditionError) {
    return reply.status(402).send({
      error: "Enterprise feature",
      feature: error.featureName,
      message: error.message,
    });
  }
  // Let Fastify handle everything else
  reply.send(error);
});

// Configure CORS origin from SYNTH_CORS_ORIGIN env var.
// If unset: reject all cross-origin (secure default). Single value: string. Comma-separated: string[].
const rawCorsOrigin = process.env.SYNTH_CORS_ORIGIN;
let corsOrigin: boolean | string | string[];
if (!rawCorsOrigin || rawCorsOrigin.trim() === '') {
  corsOrigin = false;
  console.warn('[Synth] SYNTH_CORS_ORIGIN is not set — CORS will reject all cross-origin requests. Set it to your UI origin (e.g., http://localhost:5173) for development.');
} else if (rawCorsOrigin.includes(',')) {
  corsOrigin = rawCorsOrigin.split(',').map((o) => o.trim());
} else {
  corsOrigin = rawCorsOrigin.trim();
}

await app.register(fastifyCors, {
  origin: corsOrigin,
});

// Form body parsing (required for SAML POST callbacks)
await app.register(fastifyFormBody);

// Multipart/form-data parsing (required for file upload intake)
await app.register(fastifyMultipart, { limits: { fileSize: 100 * 1024 * 1024 } });

// Rate limiting — configurable via environment variables
await app.register(rateLimit, {
  max: Number(process.env.SYNTH_RATE_LIMIT_MAX ?? 100),
  timeWindow: Number(process.env.SYNTH_RATE_LIMIT_WINDOW_MS ?? 60_000),
});

// Register authentication middleware
const auth = registerAuthMiddleware(app, userStore, userRoleStore, sessionStore, jwtSecret);

// Register REST routes
registerHealthRoutes(app, {
  entityDb,
  dataDir: DATA_DIR,
  envoyUrl,
  llmApiKey: process.env.SYNTH_LLM_API_KEY,
  llmBaseUrl: process.env.SYNTH_LLM_BASE_URL,
  mcpServers: settings.get().mcpServers,
  llmClient: llm,
});
const progressStore = new ProgressEventStore();
const defaultEnvoyClient = new EnvoyClient(settings.get().envoy.url, settings.get().envoy.timeoutMs);
registerOperationRoutes(app, deployments, debrief, partitions, environments, artifactStore, settings, telemetryStore, progressStore, defaultEnvoyClient, envoyRegistry, llm);
registerEnvoyReportRoutes(app, debrief, deployments, envoyRegistry);
registerArtifactRoutes(app, artifactStore, telemetryStore, artifactAnalyzer);
registerSecurityBoundaryRoutes(app, securityBoundaryStore, telemetryStore);
registerPartitionRoutes(app, partitions, deployments, debrief, telemetryStore);
registerEnvironmentRoutes(app, environments, deployments, telemetryStore);
registerAgentRoutes(app, agent, partitions, environments, artifactStore, deployments, debrief, settings, llm, envoyRegistry, telemetryStore, artifactAnalyzer);
registerSettingsRoutes(app, settings, telemetryStore);
registerTelemetryRoutes(app, telemetryStore);
registerEnvoyRoutes(app, settings, envoyRegistry, telemetryStore, deployments, debrief);
registerSystemRoutes(app, deployments, artifactStore, environments, partitions, envoyRegistry);
registerAuthRoutes(app, userStore, roleStore, userRoleStore, sessionStore, jwtSecret);
registerApiKeyRoutes(app, apiKeyStore, jwtSecret);
registerUserRoutes(app, userStore, roleStore, userRoleStore);
registerIdpRoutes(app, idpProviderStore, roleMappingStore, userStore, roleStore, userRoleStore, sessionStore, jwtSecret, { hasDedicatedEncryptionKey });

// Fleet (large-scale) deployment orchestration
const fleetStore = new FleetDeploymentStore(entityDb);
const fleetExecutor = new FleetExecutor(envoyRegistry, (url, token) => new EnvoyClient(url));
registerFleetRoutes(app, fleetStore, envoyRegistry, deployments, fleetExecutor, debrief);

// --- Deployment Graph Orchestration ---

const graphStore = new DeploymentGraphStore();
const graphInferenceEngine = new GraphInferenceEngine(llm, artifactStore);
registerGraphRoutes(app, graphStore, graphInferenceEngine, envoyRegistry, artifactStore, debrief);

// --- Artifact Intake Pipeline ---

const intakeChannelStore = new IntakeChannelStore(entityDb);
const intakeEventStore = new IntakeEventStore(entityDb);
const intakeProcessor = new IntakeProcessor(artifactStore, artifactAnalyzer);
const registryPollerVersionStore = new PersistentRegistryPollerVersionStore(entityDb);
const registryPoller = new RegistryPoller(async (channelId, payload) => {
  const event = intakeEventStore.create({ channelId, status: "processing", payload: payload as unknown as Record<string, unknown> });
  try {
    const result = await intakeProcessor.process(payload, channelId);
    intakeEventStore.update(event.id, { status: "completed", artifactId: result.artifactId, processedAt: new Date() });
  } catch (err) {
    intakeEventStore.update(event.id, { status: "failed", error: err instanceof Error ? err.message : "Processing failed", processedAt: new Date() });
  }
}, registryPollerVersionStore);
registerIntakeRoutes(app, intakeChannelStore, intakeEventStore, intakeProcessor, registryPoller, artifactStore);

// Start polling for any pre-existing enabled registry channels
for (const ch of intakeChannelStore.list()) {
  if (ch.type === "registry" && ch.enabled) {
    registryPoller.startPolling(ch);
  }
}

// --- Alert Webhooks (external monitoring triggers) ---

const alertWebhookStore = new PersistentAlertWebhookStore(entityDb);
registerAlertWebhookRoutes(app, alertWebhookStore, deployments, debrief, environments, partitions, telemetryStore, envoyRegistry);

// --- Serve UI static files if built ---

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDistPath = path.resolve(__dirname, "../../ui/dist");

if (existsSync(uiDistPath)) {
  await app.register(fastifyStatic, {
    root: uiDistPath,
    prefix: "/",
    wildcard: false,
  });

  // SPA fallback: serve index.html for unmatched routes
  app.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile("index.html", uiDistPath);
  });
}

// --- Mount MCP Streamable HTTP transport ---

// MCP sessions keyed by session ID, with creation timestamp for auto-cleanup
interface McpSession {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
}
const mcpTransports = new Map<string, McpSession>();
const MCP_SESSION_TTL_MS = Number(process.env.SYNTH_MCP_SESSION_TTL_MS ?? 60 * 60 * 1000);

app.post("/mcp", async (request, reply) => {
  const sessionId = (request.headers["mcp-session-id"] as string) ?? undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && mcpTransports.has(sessionId)) {
    transport = mcpTransports.get(sessionId)!.transport;
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await mcp.connect(transport);
    // After connect, the transport has a sessionId
    const newSessionId = transport.sessionId;
    if (newSessionId) {
      mcpTransports.set(newSessionId, { transport, createdAt: Date.now() });
    }
  }

  // Hand off to the MCP transport, passing raw Node.js req/res
  await transport.handleRequest(request.raw, reply.raw, request.body);
  reply.hijack();
});

// Handle GET for SSE stream (server-to-client notifications)
app.get("/mcp", async (request, reply) => {
  const sessionId = request.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !mcpTransports.has(sessionId)) {
    return reply.status(400).send({ error: "Invalid or missing session ID" });
  }

  const transport = mcpTransports.get(sessionId)!.transport;
  await transport.handleRequest(request.raw, reply.raw);
  reply.hijack();
});

// Handle DELETE for session cleanup
app.delete("/mcp", async (request, reply) => {
  const sessionId = request.headers["mcp-session-id"] as string | undefined;
  if (sessionId && mcpTransports.has(sessionId)) {
    const session = mcpTransports.get(sessionId)!;
    await session.transport.close();
    mcpTransports.delete(sessionId);
  }
  return reply.status(200).send({ status: "session closed" });
});

// Periodic Envoy health probe (every 5 minutes by default)
const ENVOY_PROBE_INTERVAL_MS = Number(process.env.SYNTH_ENVOY_PROBE_INTERVAL_MS ?? 5 * 60 * 1000);
setInterval(() => { envoyRegistry.probeAll().catch(() => {}); }, ENVOY_PROBE_INTERVAL_MS);

// Periodic MCP session cleanup (every 10 minutes)
const MCP_CLEANUP_INTERVAL_MS = Number(process.env.SYNTH_MCP_CLEANUP_INTERVAL_MS ?? 10 * 60 * 1000);
const mcpCleanupInterval = setInterval(async () => {
  const now = Date.now();
  let closed = 0;
  for (const [id, session] of mcpTransports) {
    if (now - session.createdAt > MCP_SESSION_TTL_MS) {
      try { await session.transport.close(); } catch { /* already closed */ }
      mcpTransports.delete(id);
      closed++;
    }
  }
  if (closed > 0) {
    app.log.info(`Cleaned up ${closed} expired MCP session(s)`);
  }
}, MCP_CLEANUP_INTERVAL_MS);

// --- Start stale deployment scanner ---

const stopStaleScanner = startStaleDeploymentScanner(deployments, debrief);
const stopRetentionScanner = startRetentionScanner(debrief);

// --- Graceful shutdown hook ---

app.addHook("onClose", async () => {
  stopStaleScanner();
  stopRetentionScanner();
  registryPoller.stopAll();
  clearInterval(mcpCleanupInterval);
  await mcpClientManager.disconnectAll();
  debrief.close();
  entityDb.close();
  for (const session of mcpTransports.values()) {
    await session.transport.close();
  }
  mcpTransports.clear();
  console.log("Synth shutting down — resources cleaned up");
});

// --- Start ---

const PORT = parseInt(process.env.PORT ?? "9410", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }

  const uiStatus = existsSync(uiDistPath) ? `UI:       http://${HOST}:${PORT}/` : "UI:       not built (run npm run build:ui)";

  const authStatus = auth.enabled
    ? "Auth:     enabled (JWT)                              "
    : "Auth:     disabled                                   ";

  const seedStatus = process.env.SYNTH_SEED_DEMO !== 'false'
    ? "Seed: 3 partitions, 3 envs, 3 artifacts              \n║        10 deployments, 2 boundaries                  "
    : "Seed: disabled (SYNTH_SEED_DEMO=false)        ";

  console.log(`
╔══════════════════════════════════════════════════════╗
║  Synth v0.1.0                         ║
║                                                     ║
║  REST API:  http://${HOST}:${PORT}/api               ║
║  MCP:       http://${HOST}:${PORT}/mcp               ║
║  Health:    http://${HOST}:${PORT}/health             ║
║  ${uiStatus.padEnd(50)}║
║  ${authStatus}║
║                                                     ║
║  ${seedStatus}║
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
