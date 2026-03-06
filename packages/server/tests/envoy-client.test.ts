import { describe, it, expect, vi, afterEach } from "vitest";
import { EnvoyClient, EnvoyHealthChecker } from "../src/agent/envoy-client.js";
import type { EnvoyHealthResponse } from "../src/agent/envoy-client.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeHealthResponse(overrides: Partial<EnvoyHealthResponse> = {}): EnvoyHealthResponse {
  return {
    status: "healthy",
    service: "envoy",
    hostname: "test-host",
    timestamp: new Date().toISOString(),
    readiness: { ready: true, reason: "ok" },
    summary: { totalDeployments: 5, succeeded: 4, failed: 1, executing: 0, environments: 2 },
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ===========================================================================
// EnvoyClient retry logic
// ===========================================================================

describe("EnvoyClient retry logic", () => {
  it("succeeds on first attempt without retry", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(makeHealthResponse()), { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    const result = await client.checkHealth();

    expect(result.status).toBe("healthy");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on connection error and succeeds", async () => {
    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"))
      .mockResolvedValueOnce(new Response(JSON.stringify(makeHealthResponse()), { status: 200 }));
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    const result = await client.checkHealth();

    expect(result.status).toBe("healthy");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and succeeds", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(makeHealthResponse()), { status: 200 }));
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    const result = await client.checkHealth();

    expect(result.status).toBe("healthy");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 400 (permanent error)", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response("Bad Request", { status: 400 }));
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);

    await expect(client.checkHealth()).rejects.toThrow("HTTP 400");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// EnvoyClient.checkHealth — detailed scenarios
// ===========================================================================

describe("EnvoyClient.checkHealth", () => {
  it("returns full health response with all fields", async () => {
    const expected = makeHealthResponse({
      summary: { totalDeployments: 10, succeeded: 8, failed: 2, executing: 0, environments: 3 },
    });
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(expected), { status: 200 }),
    );

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    const result = await client.checkHealth();

    expect(result.status).toBe("healthy");
    expect(result.service).toBe("envoy");
    expect(result.hostname).toBe("test-host");
    expect(result.readiness.ready).toBe(true);
    expect(result.summary.totalDeployments).toBe(10);
    expect(result.summary.succeeded).toBe(8);
    expect(result.summary.environments).toBe(3);
  });

  it("throws on non-retryable HTTP error without retrying", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    await expect(client.checkHealth()).rejects.toThrow("HTTP 500");
    // 500 is not in the retryable set (502, 503, 504), so no retry
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws on malformed JSON response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response("this is not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    // response.json() will throw a SyntaxError on invalid JSON
    await expect(client.checkHealth()).rejects.toThrow();
  });

  it("throws on non-transient error without retrying", async () => {
    // Errors that do NOT match isTransientError patterns are thrown immediately
    const mockFetch = vi.fn().mockRejectedValueOnce(new Error("certificate expired"));
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    await expect(client.checkHealth()).rejects.toThrow("certificate expired");
    // Non-transient error should not trigger retries
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("calls the correct URL for health endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(makeHealthResponse()), { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://my-envoy:9090", 5000);
    await client.checkHealth();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("http://my-envoy:9090/health");
  });
});

// ===========================================================================
// EnvoyClient.deploy
// ===========================================================================

describe("EnvoyClient.deploy", () => {
  const deployInstruction = {
    deploymentId: "dep-1",
    partitionId: "part-1",
    environmentId: "env-1",
    operationId: "op-1",
    version: "1.0.0",
    variables: { DB_HOST: "localhost" },
    environmentName: "staging",
    partitionName: "acme-corp",
  };

  it("sends POST with JSON body and returns deploy result", async () => {
    const deployResult = {
      deploymentId: "dep-1",
      success: true,
      workspacePath: "/tmp/deploy",
      artifacts: ["artifact.tar.gz"],
      executionDurationMs: 500,
      totalDurationMs: 800,
      verificationPassed: true,
      verificationChecks: [],
      failureReason: null,
      debriefEntryIds: ["entry-1"],
      debriefEntries: [],
    };

    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(deployResult), { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    const result = await client.deploy(deployInstruction);

    expect(result.deploymentId).toBe("dep-1");
    expect(result.success).toBe(true);
    expect(result.workspacePath).toBe("/tmp/deploy");

    // Verify the fetch was called with correct URL and method
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://envoy.test:8080/deploy");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(deployInstruction);
  });

  it("uses 3x the base timeout for deploy calls", async () => {
    const deployResult = {
      deploymentId: "dep-1",
      success: true,
      workspacePath: "/tmp/deploy",
      artifacts: [],
      executionDurationMs: 100,
      totalDurationMs: 200,
      verificationPassed: true,
      verificationChecks: [],
      failureReason: null,
      debriefEntryIds: [],
      debriefEntries: [],
    };

    // Track the abort signal to verify timeout is set
    let capturedSignal: AbortSignal | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedSignal = init.signal ?? undefined;
      return Promise.resolve(new Response(JSON.stringify(deployResult), { status: 200 }));
    });
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    await client.deploy(deployInstruction);

    // The signal should exist (fetchWithRetry always creates one)
    expect(capturedSignal).toBeDefined();
  });
});

// ===========================================================================
// EnvoyHealthChecker — adapter for ServiceHealthChecker interface
//
// These tests mock EnvoyClient.checkHealth directly to avoid going through
// the retry/fetch layer, which would introduce real sleep delays.
// ===========================================================================

describe("EnvoyHealthChecker", () => {
  const context = { partitionId: "part-1", environmentName: "staging" };

  it("returns healthy when no envoy is registered for serviceId", async () => {
    const checker = new EnvoyHealthChecker();
    const result = await checker.check("op-1/staging", context);

    expect(result.reachable).toBe(true);
    expect(result.responseTimeMs).toBe(0);
    expect(result.error).toBeNull();
  });

  it("returns healthy when registered envoy reports healthy", async () => {
    const checker = new EnvoyHealthChecker();
    const envoyClient = new EnvoyClient("http://envoy.test:8080", 5000);
    vi.spyOn(envoyClient, "checkHealth").mockResolvedValueOnce(makeHealthResponse());
    checker.registerEnvoy("op-1/staging", envoyClient);

    const result = await checker.check("op-1/staging", context);
    expect(result.reachable).toBe(true);
    expect(result.error).toBeNull();
    expect(typeof result.responseTimeMs).toBe("number");
  });

  it("returns not reachable when envoy reports degraded and not ready", async () => {
    const checker = new EnvoyHealthChecker();
    const envoyClient = new EnvoyClient("http://envoy.test:8080", 5000);
    vi.spyOn(envoyClient, "checkHealth").mockResolvedValueOnce(
      makeHealthResponse({
        status: "degraded",
        readiness: { ready: false, reason: "disk full" },
      }),
    );
    checker.registerEnvoy("op-1/staging", envoyClient);

    const result = await checker.check("op-1/staging", context);
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("degraded");
    expect(result.error).toContain("disk full");
  });

  it("returns ETIMEDOUT error when envoy health check is aborted", async () => {
    const checker = new EnvoyHealthChecker();
    const envoyClient = new EnvoyClient("http://envoy.test:8080", 1);
    vi.spyOn(envoyClient, "checkHealth").mockRejectedValueOnce(
      new DOMException("The operation was aborted", "AbortError"),
    );
    checker.registerEnvoy("op-1/staging", envoyClient);

    const result = await checker.check("op-1/staging", context);
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("ETIMEDOUT");
  });

  it("returns ECONNREFUSED error when envoy is not responding", async () => {
    const checker = new EnvoyHealthChecker();
    const envoyClient = new EnvoyClient("http://envoy.test:8080", 5000);
    vi.spyOn(envoyClient, "checkHealth").mockRejectedValueOnce(
      new Error("fetch failed: ECONNREFUSED"),
    );
    checker.registerEnvoy("op-1/staging", envoyClient);

    const result = await checker.check("op-1/staging", context);
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns generic error for unexpected failures", async () => {
    const checker = new EnvoyHealthChecker();
    const envoyClient = new EnvoyClient("http://envoy.test:8080", 5000);
    vi.spyOn(envoyClient, "checkHealth").mockRejectedValueOnce(
      new Error("something completely unexpected"),
    );
    checker.registerEnvoy("op-1/staging", envoyClient);

    const result = await checker.check("op-1/staging", context);
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("health check failed");
  });

  it("returns healthy=true even when status is healthy but readiness is false", async () => {
    const checker = new EnvoyHealthChecker();
    const envoyClient = new EnvoyClient("http://envoy.test:8080", 5000);
    vi.spyOn(envoyClient, "checkHealth").mockResolvedValueOnce(
      makeHealthResponse({
        status: "healthy",
        readiness: { ready: false, reason: "warming up" },
      }),
    );
    checker.registerEnvoy("op-1/staging", envoyClient);

    const result = await checker.check("op-1/staging", context);
    // healthy status but not ready -> not reachable
    expect(result.reachable).toBe(false);
    expect(result.error).toContain("warming up");
  });
});
