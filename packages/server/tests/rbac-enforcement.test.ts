import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  DecisionDebrief,
  PartitionStore,
  EnvironmentStore,
  ArtifactStore,
  SettingsStore,
  TelemetryStore,
  UserStore,
  RoleStore,
  UserRoleStore,
  SessionStore,
} from "@synth-deploy/core";
import type { UserId, RoleId, Permission } from "@synth-deploy/core";
import { InMemoryDeploymentStore } from "../src/agent/synth-agent.js";
import { registerPartitionRoutes } from "../src/api/partitions.js";
import { registerEnvironmentRoutes } from "../src/api/environments.js";
import { registerSettingsRoutes } from "../src/api/settings.js";
import { registerDeploymentRoutes } from "../src/api/deployments.js";
import { registerArtifactRoutes } from "../src/api/artifacts.js";
import { registerAuthMiddleware, generateTokens } from "../src/middleware/auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JWT_SECRET = new TextEncoder().encode("rbac-test-secret");
const VIEWER_USER_ID = "viewer-user" as UserId;
const DEPLOYER_USER_ID = "deployer-user" as UserId;
const VIEWER_ROLE_ID = "role-viewer" as RoleId;
const DEPLOYER_ROLE_ID = "role-deployer" as RoleId;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestContext {
  app: FastifyInstance;
  viewerToken: string;
  deployerToken: string;
}

async function createTestServer(): Promise<TestContext> {
  const userStore = new UserStore();
  const roleStore = new RoleStore();
  const userRoleStore = new UserRoleStore(roleStore);
  const sessionStore = new SessionStore();
  const diary = new DecisionDebrief();
  const partitions = new PartitionStore();
  const environments = new EnvironmentStore();
  const deployments = new InMemoryDeploymentStore();
  const artifactStore = new ArtifactStore();
  const settings = new SettingsStore();
  const telemetry = new TelemetryStore();

  // Create viewer role — only view permissions
  roleStore.create({
    id: VIEWER_ROLE_ID,
    name: "Viewer",
    permissions: [
      "deployment.view",
      "artifact.view",
      "environment.view",
      "partition.view",
      "envoy.view",
    ] as Permission[],
    isBuiltIn: false,
    createdAt: new Date(),
  });

  // Create deployer role — create/approve but no settings/users
  roleStore.create({
    id: DEPLOYER_ROLE_ID,
    name: "Deployer",
    permissions: [
      "deployment.create",
      "deployment.approve",
      "deployment.reject",
      "deployment.view",
      "deployment.rollback",
      "artifact.create",
      "artifact.update",
      "artifact.view",
      "environment.view",
      "partition.view",
      "envoy.view",
    ] as Permission[],
    isBuiltIn: false,
    createdAt: new Date(),
  });

  // Create viewer user
  userStore.create({
    id: VIEWER_USER_ID,
    email: "viewer@example.com",
    name: "Viewer User",
    passwordHash: "hashed",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  userRoleStore.assign(VIEWER_USER_ID, VIEWER_ROLE_ID, VIEWER_USER_ID);

  // Create deployer user
  userStore.create({
    id: DEPLOYER_USER_ID,
    email: "deployer@example.com",
    name: "Deployer User",
    passwordHash: "hashed",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  userRoleStore.assign(DEPLOYER_USER_ID, DEPLOYER_ROLE_ID, DEPLOYER_USER_ID);

  const app = Fastify({ logger: false });
  registerAuthMiddleware(app, userStore, userRoleStore, sessionStore, JWT_SECRET);

  // Register routes
  registerPartitionRoutes(app, partitions, deployments, diary, telemetry);
  registerEnvironmentRoutes(app, environments, deployments, telemetry);
  registerSettingsRoutes(app, settings, telemetry);
  registerDeploymentRoutes(app, deployments, diary, partitions, environments, artifactStore, settings, telemetry);
  registerArtifactRoutes(app, artifactStore, telemetry);

  await app.ready();

  // Generate tokens and sessions
  const viewerTokens = await generateTokens(VIEWER_USER_ID, JWT_SECRET);
  sessionStore.create({
    id: "session-viewer",
    userId: VIEWER_USER_ID,
    token: viewerTokens.token,
    refreshToken: viewerTokens.refreshToken,
    expiresAt: viewerTokens.expiresAt,
    createdAt: new Date(),
  });

  const deployerTokens = await generateTokens(DEPLOYER_USER_ID, JWT_SECRET);
  sessionStore.create({
    id: "session-deployer",
    userId: DEPLOYER_USER_ID,
    token: deployerTokens.token,
    refreshToken: deployerTokens.refreshToken,
    expiresAt: deployerTokens.expiresAt,
    createdAt: new Date(),
  });

  return {
    app,
    viewerToken: viewerTokens.token,
    deployerToken: deployerTokens.token,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("RBAC enforcement", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestServer();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  // -------------------------------------------------------------------------
  // 401 — no auth
  // -------------------------------------------------------------------------

  describe("unauthenticated requests return 401", () => {
    const routes: Array<{ method: "GET" | "POST" | "PUT" | "DELETE"; url: string }> = [
      // Deployments
      { method: "GET", url: "/api/deployments" },
      { method: "POST", url: "/api/deployments" },
      { method: "GET", url: "/api/debrief" },
      // Artifacts
      { method: "GET", url: "/api/artifacts" },
      { method: "POST", url: "/api/artifacts" },
      { method: "GET", url: "/api/artifacts/fake-id" },
      { method: "PUT", url: "/api/artifacts/fake-id" },
      { method: "DELETE", url: "/api/artifacts/fake-id" },
      // Environments
      { method: "GET", url: "/api/environments" },
      { method: "POST", url: "/api/environments" },
      { method: "GET", url: "/api/environments/fake-id" },
      { method: "PUT", url: "/api/environments/fake-id" },
      { method: "DELETE", url: "/api/environments/fake-id" },
      // Partitions
      { method: "GET", url: "/api/partitions" },
      { method: "POST", url: "/api/partitions" },
      { method: "GET", url: "/api/partitions/fake-id" },
      { method: "PUT", url: "/api/partitions/fake-id" },
      { method: "DELETE", url: "/api/partitions/fake-id" },
      // Settings
      { method: "GET", url: "/api/settings" },
      { method: "PUT", url: "/api/settings" },
      { method: "GET", url: "/api/settings/command-info" },
    ];

    for (const { method, url } of routes) {
      it(`${method} ${url} returns 401 without auth`, async () => {
        const res = await ctx.app.inject({ method, url });
        expect(res.statusCode).toBe(401);
      });
    }
  });

  // -------------------------------------------------------------------------
  // 403 — wrong permissions
  // -------------------------------------------------------------------------

  describe("viewer cannot perform write operations (403)", () => {
    it("POST /api/deployments returns 403 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/deployments",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
        payload: { artifactId: "a1", environmentId: "e1" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("POST /api/artifacts returns 403 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/artifacts",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
        payload: { name: "test", type: "docker" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("POST /api/environments returns 403 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/environments",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
        payload: { name: "staging" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("POST /api/partitions returns 403 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/partitions",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
        payload: { name: "region-us" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("DELETE /api/artifacts/fake-id returns 403 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/artifacts/fake-id",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("DELETE /api/environments/fake-id returns 403 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/environments/fake-id",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("DELETE /api/partitions/fake-id returns 403 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "DELETE",
        url: "/api/partitions/fake-id",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("deployer cannot access settings (403)", () => {
    it("GET /api/settings returns 403 for deployer", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/settings",
        headers: { authorization: `Bearer ${ctx.deployerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("PUT /api/settings returns 403 for deployer", async () => {
      const res = await ctx.app.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: `Bearer ${ctx.deployerToken}` },
        payload: { environmentsEnabled: true },
      });
      expect(res.statusCode).toBe(403);
    });

    it("GET /api/settings/command-info returns 403 for deployer", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/settings/command-info",
        headers: { authorization: `Bearer ${ctx.deployerToken}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // 200 — correct permissions succeed
  // -------------------------------------------------------------------------

  describe("viewer can access read-only routes (200)", () => {
    it("GET /api/deployments returns 200 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/deployments",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /api/artifacts returns 200 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/artifacts",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /api/environments returns 200 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/environments",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /api/partitions returns 200 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/partitions",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /api/debrief returns 200 for viewer", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/api/debrief",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("deployer can create entities", () => {
    it("POST /api/artifacts returns 201 for deployer", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/artifacts",
        headers: { authorization: `Bearer ${ctx.deployerToken}` },
        payload: { name: "my-app", type: "docker" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("POST /api/partitions returns 201 for deployer (deployer lacks partition.create)", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/partitions",
        headers: { authorization: `Bearer ${ctx.deployerToken}` },
        payload: { name: "region-us" },
      });
      // Deployer role does NOT have partition.create — should be 403
      expect(res.statusCode).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // 403 error format
  // -------------------------------------------------------------------------

  describe("403 response includes required permissions", () => {
    it("includes required and message fields", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: "/api/partitions",
        headers: { authorization: `Bearer ${ctx.viewerToken}` },
        payload: { name: "test" },
      });
      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.payload);
      expect(body.error).toBe("Forbidden");
      expect(body.required).toContain("partition.create");
      expect(body.message).toBeTruthy();
    });
  });
});
