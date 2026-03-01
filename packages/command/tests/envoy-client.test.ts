import { describe, it, expect, vi, afterEach } from "vitest";
import { EnvoyClient } from "../src/agent/envoy-client.js";

describe("EnvoyClient retry logic", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("succeeds on first attempt without retry", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "healthy", service: "envoy", hostname: "test", timestamp: new Date().toISOString(), readiness: { ready: true, reason: "ok" }, summary: { totalDeployments: 0, succeeded: 0, failed: 0, executing: 0, environments: 0 } }), { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    const result = await client.checkHealth();

    expect(result.status).toBe("healthy");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries on connection error and succeeds", async () => {
    const healthResponse = { status: "healthy", service: "envoy", hostname: "test", timestamp: new Date().toISOString(), readiness: { ready: true, reason: "ok" }, summary: { totalDeployments: 0, succeeded: 0, failed: 0, executing: 0, environments: 0 } };

    const mockFetch = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed: ECONNREFUSED"))
      .mockResolvedValueOnce(new Response(JSON.stringify(healthResponse), { status: 200 }));
    globalThis.fetch = mockFetch;

    const client = new EnvoyClient("http://envoy.test:8080", 5000);
    const result = await client.checkHealth();

    expect(result.status).toBe("healthy");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 and succeeds", async () => {
    const healthResponse = { status: "healthy", service: "envoy", hostname: "test", timestamp: new Date().toISOString(), readiness: { ready: true, reason: "ok" }, summary: { totalDeployments: 0, succeeded: 0, failed: 0, executing: 0, environments: 0 } };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(new Response("Service Unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(healthResponse), { status: 200 }));
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
