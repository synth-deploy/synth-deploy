import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import { OperationStore } from "../src/operation-store.js";
import { OrderStore } from "../src/order-store.js";
import type { CreateOrderParams } from "../src/order-store.js";
import { SettingsStore } from "../src/settings-store.js";
import { DEFAULT_DEPLOY_CONFIG, DEFAULT_APP_SETTINGS } from "../src/types.js";
import type { DeploymentStep } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<DeploymentStep> = {}): DeploymentStep {
  return {
    id: crypto.randomUUID(),
    name: "build",
    type: "pre-deploy",
    command: "npm run build",
    order: 0,
    ...overrides,
  };
}

function makeOrderParams(overrides: Partial<CreateOrderParams> = {}): CreateOrderParams {
  return {
    operationId: crypto.randomUUID(),
    operationName: "web-app",
    partitionId: crypto.randomUUID(),
    environmentId: crypto.randomUUID(),
    environmentName: "production",
    version: "1.0.0",
    steps: [makeStep({ order: 0 }), makeStep({ order: 1, name: "verify", type: "verification", command: "npm test" })],
    deployConfig: { ...DEFAULT_DEPLOY_CONFIG },
    variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// OperationStore
// ---------------------------------------------------------------------------

describe("OperationStore", () => {
  let store: OperationStore;

  beforeEach(() => {
    store = new OperationStore();
  });

  // --- CRUD ---

  it("creates an operation with a unique id", () => {
    const op = store.create("web-app");
    expect(op.id).toBeDefined();
    expect(op.name).toBe("web-app");
    expect(op.environmentIds).toEqual([]);
    expect(op.steps).toEqual([]);
    expect(op.deployConfig).toEqual(DEFAULT_DEPLOY_CONFIG);
  });

  it("creates operations with environment IDs", () => {
    const op = store.create("web-app", ["env-1", "env-2"]);
    expect(op.environmentIds).toEqual(["env-1", "env-2"]);
  });

  it("gets an operation by id", () => {
    const created = store.create("web-app");
    const fetched = store.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("web-app");
  });

  it("returns undefined for nonexistent id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("lists all operations", () => {
    store.create("app-a");
    store.create("app-b");
    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all.map((o) => o.name).sort()).toEqual(["app-a", "app-b"]);
  });

  it("updates operation name", () => {
    const op = store.create("web-app");
    const updated = store.update(op.id, { name: "api-server" });
    expect(updated.name).toBe("api-server");
    expect(store.get(op.id)!.name).toBe("api-server");
  });

  it("throws when updating nonexistent operation", () => {
    expect(() => store.update("missing", { name: "x" })).toThrow("Operation not found");
  });

  it("deletes an operation", () => {
    const op = store.create("web-app");
    expect(store.delete(op.id)).toBe(true);
    expect(store.get(op.id)).toBeUndefined();
  });

  it("returns false when deleting nonexistent operation", () => {
    expect(store.delete("nonexistent")).toBe(false);
  });

  // --- Environment links ---

  it("adds an environment to an operation", () => {
    const op = store.create("web-app");
    store.addEnvironment(op.id, "env-1");
    expect(store.get(op.id)!.environmentIds).toEqual(["env-1"]);
  });

  it("does not duplicate environment ids", () => {
    const op = store.create("web-app");
    store.addEnvironment(op.id, "env-1");
    store.addEnvironment(op.id, "env-1");
    expect(store.get(op.id)!.environmentIds).toEqual(["env-1"]);
  });

  it("removes an environment from an operation", () => {
    const op = store.create("web-app", ["env-1", "env-2"]);
    store.removeEnvironment(op.id, "env-1");
    expect(store.get(op.id)!.environmentIds).toEqual(["env-2"]);
  });

  // --- Steps ---

  it("addStep appends and sorts by order", () => {
    const op = store.create("web-app");
    const stepB = makeStep({ order: 2, name: "step-b" });
    const stepA = makeStep({ order: 1, name: "step-a" });
    store.addStep(op.id, stepB);
    store.addStep(op.id, stepA);
    const result = store.get(op.id)!;
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].name).toBe("step-a");
    expect(result.steps[1].name).toBe("step-b");
  });

  it("updateStep modifies step fields", () => {
    const op = store.create("web-app");
    const step = makeStep({ order: 0, name: "build" });
    store.addStep(op.id, step);
    store.updateStep(op.id, step.id, { name: "compile", command: "tsc" });
    const updated = store.get(op.id)!.steps[0];
    expect(updated.name).toBe("compile");
    expect(updated.command).toBe("tsc");
  });

  it("updateStep throws for missing step", () => {
    const op = store.create("web-app");
    expect(() => store.updateStep(op.id, "bad-id", { name: "x" })).toThrow("Step not found");
  });

  it("removeStep removes a step by id", () => {
    const op = store.create("web-app");
    const step = makeStep();
    store.addStep(op.id, step);
    store.removeStep(op.id, step.id);
    expect(store.get(op.id)!.steps).toHaveLength(0);
  });

  it("reorderSteps assigns new order values", () => {
    const op = store.create("web-app");
    const s1 = makeStep({ order: 0, name: "first" });
    const s2 = makeStep({ order: 1, name: "second" });
    const s3 = makeStep({ order: 2, name: "third" });
    store.addStep(op.id, s1);
    store.addStep(op.id, s2);
    store.addStep(op.id, s3);

    // Reverse the order
    store.reorderSteps(op.id, [s3.id, s2.id, s1.id]);
    const steps = store.get(op.id)!.steps;
    expect(steps[0].name).toBe("third");
    expect(steps[1].name).toBe("second");
    expect(steps[2].name).toBe("first");
    expect(steps[0].order).toBe(0);
    expect(steps[1].order).toBe(1);
    expect(steps[2].order).toBe(2);
  });

  it("reorderSteps throws for unknown step id", () => {
    const op = store.create("web-app");
    expect(() => store.reorderSteps(op.id, ["bad-id"])).toThrow("Step not found");
  });

  // --- Deploy config ---

  it("updateDeployConfig merges partial config", () => {
    const op = store.create("web-app");
    store.updateDeployConfig(op.id, { healthCheckRetries: 5 });
    const config = store.get(op.id)!.deployConfig;
    expect(config.healthCheckRetries).toBe(5);
    // Other defaults remain
    expect(config.healthCheckEnabled).toBe(DEFAULT_DEPLOY_CONFIG.healthCheckEnabled);
    expect(config.timeoutMs).toBe(DEFAULT_DEPLOY_CONFIG.timeoutMs);
  });

  it("updateDeployConfig throws for missing operation", () => {
    expect(() => store.updateDeployConfig("missing", {})).toThrow("Operation not found");
  });
});

// ---------------------------------------------------------------------------
// OrderStore
// ---------------------------------------------------------------------------

describe("OrderStore", () => {
  let store: OrderStore;

  beforeEach(() => {
    store = new OrderStore();
  });

  it("creates an order with a unique id and timestamp", () => {
    const before = new Date();
    const order = store.create(makeOrderParams());
    expect(order.id).toBeDefined();
    expect(order.createdAt).toBeInstanceOf(Date);
    expect(order.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it("get retrieves a created order", () => {
    const order = store.create(makeOrderParams());
    const fetched = store.get(order.id);
    expect(fetched).toBeDefined();
    expect(fetched!.operationName).toBe("web-app");
  });

  it("returns undefined for nonexistent id", () => {
    expect(store.get("nonexistent")).toBeUndefined();
  });

  it("list returns all orders", () => {
    store.create(makeOrderParams());
    store.create(makeOrderParams({ version: "2.0.0" }));
    expect(store.list()).toHaveLength(2);
  });

  it("getByOperation filters by operationId", () => {
    const opId = crypto.randomUUID();
    store.create(makeOrderParams({ operationId: opId }));
    store.create(makeOrderParams({ operationId: opId }));
    store.create(makeOrderParams()); // different operationId
    expect(store.getByOperation(opId)).toHaveLength(2);
  });

  it("getByPartition filters by partitionId", () => {
    const partId = crypto.randomUUID();
    store.create(makeOrderParams({ partitionId: partId }));
    store.create(makeOrderParams()); // different partitionId
    expect(store.getByPartition(partId)).toHaveLength(1);
  });

  // --- Immutability ---

  it("create returns a defensive copy (mutating return value does not affect store)", () => {
    const order = store.create(makeOrderParams());
    order.version = "hacked";
    const fetched = store.get(order.id)!;
    expect(fetched.version).toBe("1.0.0");
  });

  it("get returns a defensive copy", () => {
    const order = store.create(makeOrderParams());
    const fetched = store.get(order.id)!;
    fetched.version = "hacked";
    const refetched = store.get(order.id)!;
    expect(refetched.version).toBe("1.0.0");
  });

  it("list returns defensive copies", () => {
    store.create(makeOrderParams());
    const list = store.list();
    list[0].version = "hacked";
    const refetch = store.list();
    expect(refetch[0].version).toBe("1.0.0");
  });

  it("input steps are deep-cloned on create (mutating source does not affect stored order)", () => {
    const steps = [makeStep()];
    const params = makeOrderParams({ steps });
    const order = store.create(params);
    // Mutate the original steps array
    steps[0].name = "hacked";
    const fetched = store.get(order.id)!;
    expect(fetched.steps[0].name).not.toBe("hacked");
  });
});

// ---------------------------------------------------------------------------
// SettingsStore
// ---------------------------------------------------------------------------

describe("SettingsStore", () => {
  let store: SettingsStore;

  beforeEach(() => {
    store = new SettingsStore();
  });

  it("returns default settings initially", () => {
    const settings = store.get();
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("get returns a defensive copy", () => {
    const settings = store.get();
    settings.environmentsEnabled = !DEFAULT_APP_SETTINGS.environmentsEnabled;
    const refetch = store.get();
    expect(refetch.environmentsEnabled).toBe(DEFAULT_APP_SETTINGS.environmentsEnabled);
  });

  it("updates environmentsEnabled", () => {
    store.update({ environmentsEnabled: false });
    expect(store.get().environmentsEnabled).toBe(false);
  });

  it("merges agent settings without overwriting other fields", () => {
    store.update({ agent: { conflictPolicy: "strict" } as any });
    const settings = store.get();
    expect(settings.agent.conflictPolicy).toBe("strict");
    // Other agent fields preserved
    expect(settings.agent.defaultHealthCheckRetries).toBe(
      DEFAULT_APP_SETTINGS.agent.defaultHealthCheckRetries,
    );
    expect(settings.agent.defaultTimeoutMs).toBe(
      DEFAULT_APP_SETTINGS.agent.defaultTimeoutMs,
    );
  });

  it("merges deploymentDefaults without overwriting other fields", () => {
    const newConfig = { healthCheckRetries: 5 };
    store.update({
      deploymentDefaults: { defaultDeployConfig: newConfig as any },
    });
    const settings = store.get();
    // The defaultDeployConfig gets shallow-merged at the deploymentDefaults level
    expect(settings.deploymentDefaults.defaultDeployConfig).toEqual(newConfig);
  });

  it("merges envoy settings", () => {
    store.update({ envoy: { url: "http://envoy:4000" } as any });
    const settings = store.get();
    expect(settings.envoy.url).toBe("http://envoy:4000");
    expect(settings.envoy.timeoutMs).toBe(DEFAULT_APP_SETTINGS.envoy.timeoutMs);
  });

  it("update returns a defensive copy", () => {
    const result = store.update({ environmentsEnabled: false });
    result.environmentsEnabled = true;
    expect(store.get().environmentsEnabled).toBe(false);
  });

  it("multiple updates accumulate correctly", () => {
    store.update({ environmentsEnabled: false });
    store.update({ agent: { conflictPolicy: "strict" } as any });
    const settings = store.get();
    expect(settings.environmentsEnabled).toBe(false);
    expect(settings.agent.conflictPolicy).toBe("strict");
  });
});
