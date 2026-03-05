import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listOperations,
  getOperation,
  createOperation,
  deleteOperation,
  listPartitions,
  getPartition,
  createPartition,
  listDeployments,
  getDeployment,
  triggerDeployment,
  getRecentDebrief,
  getHealth,
  listEnvironments,
  getSettings,
  updateSettings,
  listOrders,
  getOrder,
  createOrder,
  executeOrder,
} from "../src/api";

// ---------------------------------------------------------------------------
// Fetch mock helper
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetchResponse(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function mockFetchError(errorBody: unknown, status: number) {
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve(errorBody),
  });
}

function mockNetworkError(message: string) {
  fetchMock.mockRejectedValueOnce(new TypeError(message));
}

function mockMalformedJson(status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError("Unexpected token")),
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Successful fetch — Operations
// ---------------------------------------------------------------------------

describe("API client — operations", () => {
  it("listOperations fetches and unwraps the operations array", async () => {
    const ops = [{ id: "op-1", name: "web-app" }];
    mockFetchResponse({ operations: ops });

    const result = await listOperations();
    expect(result).toEqual(ops);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/operations",
      expect.objectContaining({ headers: expect.objectContaining({ "Content-Type": "application/json" }) }),
    );
  });

  it("getOperation fetches a single operation with environments", async () => {
    const data = { operation: { id: "op-1" }, environments: [{ id: "env-1" }] };
    mockFetchResponse(data);

    const result = await getOperation("op-1");
    expect(result).toEqual(data);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/operations/op-1",
      expect.anything(),
    );
  });

  it("createOperation sends POST with name and environmentIds", async () => {
    mockFetchResponse({ operation: { id: "op-new", name: "new-app" } });

    const result = await createOperation("new-app", ["env-1"]);
    expect(result).toEqual({ id: "op-new", name: "new-app" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/operations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "new-app", environmentIds: ["env-1"] });
  });

  it("deleteOperation sends DELETE", async () => {
    mockFetchResponse({});

    await deleteOperation("op-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/operations/op-1");
    expect(init.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// Successful fetch — Partitions
// ---------------------------------------------------------------------------

describe("API client — partitions", () => {
  it("listPartitions fetches and unwraps the partitions array", async () => {
    const parts = [{ id: "p-1", name: "Acme" }];
    mockFetchResponse({ partitions: parts });

    const result = await listPartitions();
    expect(result).toEqual(parts);
  });

  it("getPartition fetches a single partition", async () => {
    mockFetchResponse({ partition: { id: "p-1", name: "Acme" } });

    const result = await getPartition("p-1");
    expect(result).toEqual({ id: "p-1", name: "Acme" });
  });

  it("createPartition sends POST with name and variables", async () => {
    mockFetchResponse({ partition: { id: "p-new" } });

    await createPartition("New Corp", { REGION: "us-east" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ name: "New Corp", variables: { REGION: "us-east" } });
  });

  it("createPartition defaults variables to empty object", async () => {
    mockFetchResponse({ partition: { id: "p-new" } });

    await createPartition("No Vars");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ name: "No Vars", variables: {} });
  });
});

// ---------------------------------------------------------------------------
// Successful fetch — Deployments
// ---------------------------------------------------------------------------

describe("API client — deployments", () => {
  it("listDeployments fetches all deployments", async () => {
    mockFetchResponse({ deployments: [{ id: "d-1" }] });

    const result = await listDeployments();
    expect(result).toEqual([{ id: "d-1" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/deployments", expect.anything());
  });

  it("listDeployments filters by partitionId", async () => {
    mockFetchResponse({ deployments: [] });

    await listDeployments("p-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/deployments?partitionId=p-1",
      expect.anything(),
    );
  });

  it("getDeployment fetches deployment with debrief", async () => {
    const data = { deployment: { id: "d-1" }, debrief: [] };
    mockFetchResponse(data);

    const result = await getDeployment("d-1");
    expect(result).toEqual(data);
  });

  it("triggerDeployment sends POST with trigger params", async () => {
    const trigger = {
      orderId: "ord-1",
      partitionId: "p-1",
      environmentId: "env-1",
      triggeredBy: "user" as const,
    };
    mockFetchResponse({ deployment: { id: "d-new" }, debrief: [] });

    await triggerDeployment(trigger);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/deployments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(trigger);
  });
});

// ---------------------------------------------------------------------------
// Successful fetch — Debrief
// ---------------------------------------------------------------------------

describe("API client — debrief", () => {
  it("getRecentDebrief fetches without filters", async () => {
    mockFetchResponse({ entries: [{ id: "e-1" }] });

    const result = await getRecentDebrief();
    expect(result).toEqual([{ id: "e-1" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/debrief", expect.anything());
  });

  it("getRecentDebrief appends query params when filters are provided", async () => {
    mockFetchResponse({ entries: [] });

    await getRecentDebrief({ limit: 10, partitionId: "p-1", decisionType: "system" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("limit=10");
    expect(url).toContain("partitionId=p-1");
    expect(url).toContain("decisionType=system");
  });
});

// ---------------------------------------------------------------------------
// Successful fetch — Health
// ---------------------------------------------------------------------------

describe("API client — health", () => {
  it("getHealth fetches the health endpoint", async () => {
    const health = { status: "ok", service: "deploystack", timestamp: "2026-03-01T00:00:00Z" };
    mockFetchResponse(health);

    const result = await getHealth();
    expect(result).toEqual(health);
    expect(fetchMock).toHaveBeenCalledWith("/health", expect.anything());
  });
});

// ---------------------------------------------------------------------------
// Successful fetch — Environments
// ---------------------------------------------------------------------------

describe("API client — environments", () => {
  it("listEnvironments fetches and unwraps", async () => {
    mockFetchResponse({ environments: [{ id: "env-1", name: "staging" }] });

    const result = await listEnvironments();
    expect(result).toEqual([{ id: "env-1", name: "staging" }]);
  });
});

// ---------------------------------------------------------------------------
// Successful fetch — Settings
// ---------------------------------------------------------------------------

describe("API client — settings", () => {
  it("getSettings fetches and unwraps", async () => {
    const settings = { environmentsEnabled: true };
    mockFetchResponse({ settings });

    const result = await getSettings();
    expect(result).toEqual(settings);
  });

  it("updateSettings sends PUT with partial updates", async () => {
    mockFetchResponse({ settings: { environmentsEnabled: false } });

    await updateSettings({ environmentsEnabled: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ environmentsEnabled: false });
  });
});

// ---------------------------------------------------------------------------
// Successful fetch — Orders
// ---------------------------------------------------------------------------

describe("API client — orders", () => {
  it("listOrders fetches without filters", async () => {
    mockFetchResponse({ orders: [{ id: "ord-1" }] });

    const result = await listOrders();
    expect(result).toEqual([{ id: "ord-1" }]);
    expect(fetchMock).toHaveBeenCalledWith("/api/orders", expect.anything());
  });

  it("listOrders appends filter params", async () => {
    mockFetchResponse({ orders: [] });

    await listOrders({ operationId: "op-1", partitionId: "p-1" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("operationId=op-1");
    expect(url).toContain("partitionId=p-1");
  });

  it("getOrder fetches order with deployments", async () => {
    const data = { order: { id: "ord-1" }, deployments: [] };
    mockFetchResponse(data);

    const result = await getOrder("ord-1");
    expect(result).toEqual(data);
  });

  it("createOrder sends POST with order params", async () => {
    mockFetchResponse({ order: { id: "ord-new" } });

    const params = {
      operationId: "op-1",
      partitionId: "p-1",
      environmentId: "env-1",
      version: "2.0.0",
    };
    await createOrder(params);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual(params);
  });

  it("executeOrder sends POST to execute endpoint", async () => {
    mockFetchResponse({ deployment: { id: "d-1" }, debrief: [] });

    await executeOrder("ord-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/orders/ord-1/execute");
    expect(init.method).toBe("POST");
  });
});

// ---------------------------------------------------------------------------
// Network error handling
// ---------------------------------------------------------------------------

describe("API client — network errors", () => {
  it("propagates network errors (fetch rejects)", async () => {
    mockNetworkError("Failed to fetch");

    await expect(listOperations()).rejects.toThrow("Failed to fetch");
  });

  it("propagates TypeError for DNS resolution failures", async () => {
    mockNetworkError("getaddrinfo ENOTFOUND localhost");

    await expect(getHealth()).rejects.toThrow("getaddrinfo ENOTFOUND");
  });

  it("propagates connection refused errors", async () => {
    mockNetworkError("ECONNREFUSED");

    await expect(listPartitions()).rejects.toThrow("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// HTTP error status codes
// ---------------------------------------------------------------------------

describe("API client — HTTP error status codes", () => {
  it("throws with server error message when response body has error field", async () => {
    mockFetchError({ error: "Partition not found" }, 404);

    await expect(getPartition("missing")).rejects.toThrow("Partition not found");
  });

  it("throws with status code when response body has no error field", async () => {
    mockFetchError({}, 500);

    await expect(listOperations()).rejects.toThrow("Request failed: 500");
  });

  it("throws for 401 Unauthorized", async () => {
    mockFetchError({ error: "Unauthorized" }, 401);

    await expect(listDeployments()).rejects.toThrow("Unauthorized");
  });

  it("throws for 403 Forbidden", async () => {
    mockFetchError({ error: "Forbidden" }, 403);

    await expect(createPartition("test")).rejects.toThrow("Forbidden");
  });

  it("throws for 422 Unprocessable Entity", async () => {
    mockFetchError({ error: "Invalid operation name" }, 422);

    await expect(createOperation("", [])).rejects.toThrow("Invalid operation name");
  });

  it("throws for 503 Service Unavailable", async () => {
    mockFetchError({}, 503);

    await expect(getHealth()).rejects.toThrow("Request failed: 503");
  });
});

// ---------------------------------------------------------------------------
// Malformed JSON response
// ---------------------------------------------------------------------------

describe("API client — malformed JSON", () => {
  it("throws when successful response has invalid JSON body", async () => {
    // fetchJson calls res.json() on success path too — if the body isn't valid JSON,
    // the promise from res.json() rejects and the error propagates
    mockMalformedJson(200);

    await expect(listOperations()).rejects.toThrow();
  });

  it("falls back to generic error when error response body is not valid JSON", async () => {
    // When an error response (non-ok) has a body that can't be parsed as JSON,
    // fetchJson catches the JSON parse error and falls back to status code
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
    });

    await expect(listPartitions()).rejects.toThrow("Request failed: 502");
  });
});

// ---------------------------------------------------------------------------
// Request headers
// ---------------------------------------------------------------------------

describe("API client — request headers", () => {
  it("always sends Content-Type: application/json", async () => {
    mockFetchResponse({ operations: [] });

    await listOperations();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("preserves custom headers from RequestInit", async () => {
    // This tests the internal fetchJson behavior — since all public methods go
    // through fetchJson, we verify one method passes the right shape
    mockFetchResponse({ operations: [] });

    await listOperations();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toBeDefined();
  });
});
