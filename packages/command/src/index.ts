import crypto from "node:crypto";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PersistentDecisionDebrief, PartitionStore, ProjectStore, EnvironmentStore, SettingsStore, OrderStore } from "@deploystack/core";
import { CommandAgent, InMemoryDeploymentStore } from "./agent/command-agent.js";
import { createMcpServer } from "./mcp/server.js";
import { registerDeploymentRoutes } from "./api/deployments.js";
import { registerHealthRoutes } from "./api/health.js";
import { registerEnvoyReportRoutes } from "./api/envoy-reports.js";
import { registerProjectRoutes } from "./api/projects.js";
import { registerPartitionRoutes } from "./api/partitions.js";
import { registerEnvironmentRoutes } from "./api/environments.js";
import { registerAgentRoutes } from "./api/agent.js";
import { registerSettingsRoutes } from "./api/settings.js";
import { registerOrderRoutes } from "./api/orders.js";

// --- Bootstrap shared state ---

const DATA_DIR = path.resolve(process.env.DEPLOYSTACK_DATA_DIR ?? "data");
mkdirSync(DATA_DIR, { recursive: true });

const debrief = new PersistentDecisionDebrief(path.join(DATA_DIR, "debrief.db"));
const partitions = new PartitionStore();
const projects = new ProjectStore();
const environments = new EnvironmentStore();
const settings = new SettingsStore();
const deployments = new InMemoryDeploymentStore();
const orders = new OrderStore();
const agent = new CommandAgent(debrief, deployments, orders, undefined, {}, settings);

// --- Seed demo data so the server is immediately usable ---

const demoPartition = partitions.create("Acme Corp", { APP_ENV: "production", DB_HOST: "acme-db-1" });
const demoEnv = environments.create("production", { APP_ENV: "production", LOG_LEVEL: "warn" });
const stagingEnv = environments.create("staging", { APP_ENV: "staging", LOG_LEVEL: "debug" });
const demoProject = projects.create("web-app", [demoEnv.id, stagingEnv.id]);

debrief.record({
  partitionId: null,
  deploymentId: null,
  agent: "command",
  decisionType: "system",
  decision: "Command initialized with demo data",
  reasoning:
    "Seeded one partition (Acme Corp), two environments (production, staging), " +
    "one project (web-app) so the API and MCP tools are immediately testable without setup.",
  context: {
    partitionId: demoPartition.id,
    productionEnvId: demoEnv.id,
    stagingEnvId: stagingEnv.id,
    projectId: demoProject.id,
  },
});

// --- Create MCP server ---

const mcp = createMcpServer({ agent, debrief, partitions, environments, deployments, projects });

// --- Create Fastify HTTP server ---

const app = Fastify({ logger: true });

// Enable CORS for development (UI on port 5173, server on 3000)
await app.register(fastifyCors, {
  origin: true,
});

// Register REST routes
registerHealthRoutes(app);
registerDeploymentRoutes(app, agent, partitions, environments, deployments, debrief, projects, orders);
registerEnvoyReportRoutes(app, debrief);
registerProjectRoutes(app, projects, environments);
registerPartitionRoutes(app, partitions, deployments, debrief);
registerEnvironmentRoutes(app, environments, projects);
registerAgentRoutes(app, agent, partitions, environments, projects, deployments, debrief);
registerSettingsRoutes(app, settings);
registerOrderRoutes(app, orders, agent, partitions, environments, projects, deployments, debrief);

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

// MCP sessions keyed by session ID
const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (request, reply) => {
  const sessionId = (request.headers["mcp-session-id"] as string) ?? undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && mcpTransports.has(sessionId)) {
    transport = mcpTransports.get(sessionId)!;
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await mcp.connect(transport);
    // After connect, the transport has a sessionId
    const newSessionId = transport.sessionId;
    if (newSessionId) {
      mcpTransports.set(newSessionId, transport);
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

  const transport = mcpTransports.get(sessionId)!;
  await transport.handleRequest(request.raw, reply.raw);
  reply.hijack();
});

// Handle DELETE for session cleanup
app.delete("/mcp", async (request, reply) => {
  const sessionId = request.headers["mcp-session-id"] as string | undefined;
  if (sessionId && mcpTransports.has(sessionId)) {
    const transport = mcpTransports.get(sessionId)!;
    await transport.close();
    mcpTransports.delete(sessionId);
  }
  return reply.status(200).send({ status: "session closed" });
});

// --- Start ---

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

app.listen({ port: PORT, host: HOST }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }

  const uiStatus = existsSync(uiDistPath) ? `UI:       http://${HOST}:${PORT}/` : "UI:       not built (run npm run build:ui)";

  console.log(`
╔══════════════════════════════════════════════════════╗
║  DeployStack Command v0.1.0                           ║
║                                                      ║
║  REST API:  http://${HOST}:${PORT}/api                ║
║  MCP:       http://${HOST}:${PORT}/mcp                ║
║  Health:    http://${HOST}:${PORT}/health              ║
║  ${uiStatus.padEnd(51)}║
║                                                      ║
║  Demo partition: ${demoPartition.id}  ║
║  Demo project: ${demoProject.id}  ║
║  Environments: ${demoEnv.id} (prod)  ║
║                ${stagingEnv.id} (stg)  ║
╚══════════════════════════════════════════════════════╝
  `);
});
