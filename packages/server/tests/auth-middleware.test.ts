import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import {
  UserStore,
  RoleStore,
  UserRoleStore,
  SessionStore,
} from "@synth-deploy/core";
import type { UserId, RoleId } from "@synth-deploy/core";
import { registerAuthMiddleware, generateTokens } from "../src/middleware/auth.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JWT_SECRET = new TextEncoder().encode("test-secret");
const TEST_USER_ID = "user-1" as UserId;
const TEST_ROLE_ID = "role-admin" as RoleId;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStores() {
  const userStore = new UserStore();
  const roleStore = new RoleStore();
  const userRoleStore = new UserRoleStore(roleStore);
  const sessionStore = new SessionStore();
  return { userStore, roleStore, userRoleStore, sessionStore };
}

function seedTestUser(stores: ReturnType<typeof createStores>) {
  stores.userStore.create({
    id: TEST_USER_ID,
    email: "test@example.com",
    name: "Test User",
    passwordHash: "hashed",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  stores.roleStore.create({
    id: TEST_ROLE_ID,
    name: "admin",
    permissions: ["deployment.view"],
    isBuiltIn: true,
    createdAt: new Date(),
  });

  stores.userRoleStore.assign(TEST_USER_ID, TEST_ROLE_ID, TEST_USER_ID);
}

async function buildApp(): Promise<{
  app: FastifyInstance;
  stores: ReturnType<typeof createStores>;
  token: string;
}> {
  const stores = createStores();
  seedTestUser(stores);

  const app = Fastify({ logger: false });
  registerAuthMiddleware(app, stores.userStore, stores.userRoleStore, stores.sessionStore, JWT_SECRET);

  // Health endpoint — exempt from auth
  app.get("/health", async () => ({ status: "ok" }));

  // Protected endpoint
  app.get("/api/partitions", async () => ({ partitions: [] }));

  await app.ready();

  // Generate a valid token and persist the session
  const { token, refreshToken, expiresAt } = await generateTokens(TEST_USER_ID, JWT_SECRET);
  stores.sessionStore.create({
    id: "session-1",
    userId: TEST_USER_ID,
    token,
    refreshToken,
    expiresAt,
    createdAt: new Date(),
  });

  return { app, stores, token };
}

// ---------------------------------------------------------------------------
// Tests — auth middleware (JWT-based, always enabled)
// ---------------------------------------------------------------------------

describe("auth middleware — enabled", () => {
  let app: FastifyInstance;
  let token: string;

  beforeEach(async () => {
    const built = await buildApp();
    app = built.app;
    token = built.token;
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/partitions",
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toEqual({ error: "Authentication required" });
  });

  it("returns 401 when Authorization header is malformed (no Bearer prefix)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/partitions",
      headers: { authorization: "Basic some-credentials" },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toEqual({ error: "Authentication required" });
  });

  it("returns 401 when Bearer token is invalid", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/partitions",
      headers: { authorization: "Bearer not-a-valid-jwt" },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toEqual({ error: "Invalid token" });
  });

  it("passes request through with a valid JWT token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/partitions",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ partitions: [] });
  });

  it("allows /health without any authorization", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ status: "ok" });
  });

  it("allows /health even with an invalid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer totally-wrong" },
    });

    // /health bypasses auth entirely — should still succeed
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests — registerAuthMiddleware return value
// ---------------------------------------------------------------------------

describe("registerAuthMiddleware return value", () => {
  it("always returns { enabled: true }", () => {
    const stores = createStores();
    const app = Fastify({ logger: false });
    const result = registerAuthMiddleware(
      app,
      stores.userStore,
      stores.userRoleStore,
      stores.sessionStore,
      JWT_SECRET,
    );
    expect(result.enabled).toBe(true);
    app.close();
  });
});
