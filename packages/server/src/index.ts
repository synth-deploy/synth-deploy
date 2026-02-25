import crypto from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DecisionDiary, TenantStore, ProjectStore } from "@deploystack/core";
import type { Environment } from "@deploystack/core";
import { ServerAgent, InMemoryDeploymentStore } from "./agent/server-agent.js";
import { createMcpServer } from "./mcp/server.js";
import { registerDeploymentRoutes } from "./api/deployments.js";
import { registerHealthRoutes } from "./api/health.js";
import { registerTentacleReportRoutes } from "./api/tentacle-reports.js";
import { registerProjectRoutes } from "./api/projects.js";
import { registerTenantRoutes } from "./api/tenants.js";
import { registerEnvironmentRoutes } from "./api/environments.js";
import { registerAgentRoutes } from "./api/agent.js";

// --- Bootstrap shared state ---

const diary = new DecisionDiary();
const tenants = new TenantStore();
const projects = new ProjectStore();
const deployments = new InMemoryDeploymentStore();
const agent = new ServerAgent(diary, deployments);

// Simple in-memory environment store
const environmentMap = new Map<string, Environment>();
const environments = {
  get: (id: string) => environmentMap.get(id),
  create: (name: string, variables: Record<string, string> = {}): Environment => {
    const env: Environment = { id: crypto.randomUUID(), name, variables };
    environmentMap.set(env.id, env);
    return env;
  },
  list: () => [...environmentMap.values()],
};

// --- Seed demo data so the server is immediately usable ---

const demoTenant = tenants.create("Acme Corp", { APP_ENV: "production", DB_HOST: "acme-db-1" });
const demoEnv = environments.create("production", { APP_ENV: "production", LOG_LEVEL: "warn" });
const stagingEnv = environments.create("staging", { APP_ENV: "staging", LOG_LEVEL: "debug" });
const demoProject = projects.create("web-app", [demoEnv.id, stagingEnv.id]);

diary.record({
  tenantId: null,
  deploymentId: null,
  agent: "server",
  decisionType: "system",
  decision: "Server initialized with demo data",
  reasoning:
    "Seeded one tenant (Acme Corp), two environments (production, staging), " +
    "one project (web-app) so the API and MCP tools are immediately testable without setup.",
  context: {
    tenantId: demoTenant.id,
    productionEnvId: demoEnv.id,
    stagingEnvId: stagingEnv.id,
    projectId: demoProject.id,
  },
});

// --- Create MCP server ---

const mcp = createMcpServer({ agent, diary, tenants, environments, deployments });

// --- Create Fastify HTTP server ---

const app = Fastify({ logger: true });

// Enable CORS for development (UI on port 5173, server on 3000)
await app.register(fastifyCors, {
  origin: true,
});

// Register REST routes
registerHealthRoutes(app);
registerDeploymentRoutes(app, agent, tenants, environments, deployments, diary);
registerTentacleReportRoutes(app, diary);
registerProjectRoutes(app, projects, environments);
registerTenantRoutes(app, tenants, deployments, diary);
registerEnvironmentRoutes(app, environments);
registerAgentRoutes(app, agent, tenants, environments, projects, deployments, diary);

// Convenience: list seed data (keep for backward compat)
app.get("/api/tenants", async () => ({ tenants: tenants.list() }));
app.get("/api/environments", async () => ({ environments: environments.list() }));

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
║  DeployStack Server v0.1.0                           ║
║                                                      ║
║  REST API:  http://${HOST}:${PORT}/api                ║
║  MCP:       http://${HOST}:${PORT}/mcp                ║
║  Health:    http://${HOST}:${PORT}/health              ║
║  ${uiStatus.padEnd(51)}║
║                                                      ║
║  Demo tenant: ${demoTenant.id}  ║
║  Demo project: ${demoProject.id}  ║
║  Environments: ${demoEnv.id} (prod)  ║
║                ${stagingEnv.id} (stg)  ║
╚══════════════════════════════════════════════════════╝
  `);
});
