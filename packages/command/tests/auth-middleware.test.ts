import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerAuthMiddleware } from "../src/middleware/auth.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_API_KEY = "sk-test-secret-key-12345";

/** Build a minimal Fastify app with auth middleware and a dummy route. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerAuthMiddleware(app);

  // Health endpoint — should always be public
  app.get("/health", async () => ({ status: "ok" }));

  // Protected endpoint
  app.get("/api/partitions", async () => ({ partitions: [] }));

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests — auth ENABLED (DEPLOYSTACK_API_KEY is set)
// ---------------------------------------------------------------------------

describe("auth middleware — enabled", () => {
  let app: FastifyInstance;
  const originalEnv = process.env.DEPLOYSTACK_API_KEY;

  beforeEach(async () => {
    process.env.DEPLOYSTACK_API_KEY = TEST_API_KEY;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnv === undefined) {
      delete process.env.DEPLOYSTACK_API_KEY;
    } else {
      process.env.DEPLOYSTACK_API_KEY = originalEnv;
    }
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/partitions",
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when Authorization header is malformed (no Bearer prefix)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/partitions",
      headers: { authorization: `Basic ${TEST_API_KEY}` },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 when Bearer token is wrong", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/partitions",
      headers: { authorization: "Bearer wrong-key" },
    });

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.payload)).toEqual({ error: "Unauthorized" });
  });

  it("passes request through with correct Bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/partitions",
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
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
// Tests — auth DISABLED (no DEPLOYSTACK_API_KEY set)
// ---------------------------------------------------------------------------

describe("auth middleware — disabled (no API key set)", () => {
  let app: FastifyInstance;
  const originalEnv = process.env.DEPLOYSTACK_API_KEY;

  beforeEach(async () => {
    delete process.env.DEPLOYSTACK_API_KEY;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    if (originalEnv !== undefined) {
      process.env.DEPLOYSTACK_API_KEY = originalEnv;
    }
  });

  it("allows requests without any authorization header", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/partitions",
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ partitions: [] });
  });

  it("returns enabled: false from registerAuthMiddleware", async () => {
    const testApp = Fastify({ logger: false });
    const result = registerAuthMiddleware(testApp);
    expect(result.enabled).toBe(false);
    await testApp.close();
  });
});

// ---------------------------------------------------------------------------
// Tests — registerAuthMiddleware return value
// ---------------------------------------------------------------------------

describe("registerAuthMiddleware return value", () => {
  const originalEnv = process.env.DEPLOYSTACK_API_KEY;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DEPLOYSTACK_API_KEY;
    } else {
      process.env.DEPLOYSTACK_API_KEY = originalEnv;
    }
  });

  it("returns { enabled: true } when API key is set", () => {
    process.env.DEPLOYSTACK_API_KEY = TEST_API_KEY;
    const app = Fastify({ logger: false });
    const result = registerAuthMiddleware(app);
    expect(result.enabled).toBe(true);
    app.close();
  });

  it("returns { enabled: false } when API key is not set", () => {
    delete process.env.DEPLOYSTACK_API_KEY;
    const app = Fastify({ logger: false });
    const result = registerAuthMiddleware(app);
    expect(result.enabled).toBe(false);
    app.close();
  });
});
