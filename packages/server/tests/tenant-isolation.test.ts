import { describe, it, expect, beforeEach } from "vitest";
import {
  DecisionDiary,
  TenantManager,
} from "@deploystack/core";
import type { Environment, DiaryEntry } from "@deploystack/core";
import {
  ServerAgent,
  InMemoryDeploymentStore,
} from "../src/agent/server-agent.js";
import type {
  ServiceHealthChecker,
  HealthCheckResult,
} from "../src/agent/health-checker.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class MockHealthChecker implements ServiceHealthChecker {
  private responses: HealthCheckResult[] = [];
  async check(): Promise<HealthCheckResult> {
    const next = this.responses.shift();
    if (next) return next;
    return { reachable: true, responseTimeMs: 1, error: null };
  }
  willReturn(...results: HealthCheckResult[]): void {
    this.responses.push(...results);
  }
}

const HEALTHY: HealthCheckResult = {
  reachable: true,
  responseTimeMs: 1,
  error: null,
};

const CONN_REFUSED: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "ECONNREFUSED: Connection refused",
};

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-prod",
    name: "production",
    variables: {},
    ...overrides,
  };
}

function findDecisions(entries: DiaryEntry[], substr: string): DiaryEntry[] {
  return entries.filter((e) =>
    e.decision.toLowerCase().includes(substr.toLowerCase()),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tenant Isolation", () => {
  let diary: DecisionDiary;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: ServerAgent;
  let manager: TenantManager;

  beforeEach(() => {
    diary = new DecisionDiary();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new ServerAgent(diary, deployments, healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
    manager = new TenantManager(deployments, diary);
  });

  // -----------------------------------------------------------------------
  // 1. Variable isolation — setting vars on A does not touch B
  // -----------------------------------------------------------------------

  describe("variable isolation", () => {
    it("setting variables on Tenant A has zero effect on Tenant B", () => {
      const tenantA = manager.createTenant("Acme Corp", {
        DB_HOST: "acme-db",
        LOG_LEVEL: "warn",
      });
      const tenantB = manager.createTenant("Beta Inc", {
        DB_HOST: "beta-db",
        LOG_LEVEL: "info",
      });

      // Mutate A's variables
      tenantA.setVariables({ DB_HOST: "acme-db-v2", NEW_VAR: "only-acme" });

      // B is completely unaffected
      expect(tenantB.getVariables()).toEqual({
        DB_HOST: "beta-db",
        LOG_LEVEL: "info",
      });

      // A has the updated values
      expect(tenantA.getVariables()).toEqual({
        DB_HOST: "acme-db-v2",
        LOG_LEVEL: "warn",
        NEW_VAR: "only-acme",
      });
    });

    it("getVariables returns a copy — external mutation cannot corrupt internal state", () => {
      const tenant = manager.createTenant("Acme Corp", { DB_HOST: "acme-db" });

      const vars = tenant.getVariables();
      vars.DB_HOST = "CORRUPTED";
      vars.INJECTED = "malicious";

      // Internal state is untouched
      expect(tenant.getVariables()).toEqual({ DB_HOST: "acme-db" });
    });
  });

  // -----------------------------------------------------------------------
  // 2. Deployment visibility — A's deployments invisible to B
  // -----------------------------------------------------------------------

  describe("deployment visibility isolation", () => {
    it("Tenant A deployments are invisible to Tenant B", async () => {
      const tenantA = manager.createTenant("Acme Corp");
      const tenantB = manager.createTenant("Beta Inc");
      const env = makeEnvironment();

      // Deploy to Tenant A
      const triggerA = {
        projectId: "web-app",
        tenantId: tenantA.id,
        environmentId: env.id,
        version: "1.0.0",
      };
      const resultA = await agent.triggerDeployment(
        triggerA,
        tenantA.toTenant(),
        env,
      );
      expect(resultA.status).toBe("succeeded");

      // Tenant A sees its deployment
      expect(tenantA.getDeployments()).toHaveLength(1);
      expect(tenantA.getDeployments()[0].id).toBe(resultA.id);

      // Tenant B sees nothing
      expect(tenantB.getDeployments()).toHaveLength(0);
    });

    it("Tenant B cannot access Tenant A deployment by ID", async () => {
      const tenantA = manager.createTenant("Acme Corp");
      const tenantB = manager.createTenant("Beta Inc");
      const env = makeEnvironment();

      const resultA = await agent.triggerDeployment(
        {
          projectId: "web-app",
          tenantId: tenantA.id,
          environmentId: env.id,
          version: "1.0.0",
        },
        tenantA.toTenant(),
        env,
      );

      // Tenant A can access by ID
      expect(tenantA.getDeployment(resultA.id)).toBeDefined();
      expect(tenantA.getDeployment(resultA.id)!.id).toBe(resultA.id);

      // Tenant B cannot access A's deployment — returns undefined
      expect(tenantB.getDeployment(resultA.id)).toBeUndefined();
    });

    it("multiple deployments across tenants stay fully partitioned", async () => {
      const tenantA = manager.createTenant("Acme Corp");
      const tenantB = manager.createTenant("Beta Inc");
      const env = makeEnvironment();

      // Deploy 3 times to A, 2 times to B
      for (let i = 0; i < 3; i++) {
        await agent.triggerDeployment(
          {
            projectId: "web-app",
            tenantId: tenantA.id,
            environmentId: env.id,
            version: `a-${i}`,
          },
          tenantA.toTenant(),
          env,
        );
      }
      for (let i = 0; i < 2; i++) {
        await agent.triggerDeployment(
          {
            projectId: "web-app",
            tenantId: tenantB.id,
            environmentId: env.id,
            version: `b-${i}`,
          },
          tenantB.toTenant(),
          env,
        );
      }

      expect(tenantA.getDeployments()).toHaveLength(3);
      expect(tenantB.getDeployments()).toHaveLength(2);

      // Every deployment in A belongs to A
      for (const d of tenantA.getDeployments()) {
        expect(d.tenantId).toBe(tenantA.id);
      }
      // Every deployment in B belongs to B
      for (const d of tenantB.getDeployments()) {
        expect(d.tenantId).toBe(tenantB.id);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 3. Diary isolation — A's diary entries invisible to B
  // -----------------------------------------------------------------------

  describe("diary entry isolation", () => {
    it("Tenant A diary entries are invisible to Tenant B", async () => {
      const tenantA = manager.createTenant("Acme Corp");
      const tenantB = manager.createTenant("Beta Inc");
      const env = makeEnvironment();

      await agent.triggerDeployment(
        {
          projectId: "web-app",
          tenantId: tenantA.id,
          environmentId: env.id,
          version: "1.0.0",
        },
        tenantA.toTenant(),
        env,
      );

      // A has diary entries
      const entriesA = tenantA.getDiaryEntries();
      expect(entriesA.length).toBeGreaterThan(0);

      // B has none
      expect(tenantB.getDiaryEntries()).toHaveLength(0);

      // Every entry in A is tagged with A's tenantId
      for (const entry of entriesA) {
        expect(entry.tenantId).toBe(tenantA.id);
      }
    });
  });

  // -----------------------------------------------------------------------
  // 4. Error containment — failure in A doesn't affect B
  // -----------------------------------------------------------------------

  describe("error containment", () => {
    it("deployment failure on Tenant A does not prevent Tenant B deployment", async () => {
      const tenantA = manager.createTenant("Acme Corp");
      const tenantB = manager.createTenant("Beta Inc");
      const env = makeEnvironment();

      // Tenant A: deployment fails (health check fails)
      healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);
      const resultA = await agent.triggerDeployment(
        {
          projectId: "web-app",
          tenantId: tenantA.id,
          environmentId: env.id,
          version: "1.0.0",
        },
        tenantA.toTenant(),
        env,
      );
      expect(resultA.status).toBe("failed");

      // Tenant B: deployment succeeds — A's failure had no effect
      const resultB = await agent.triggerDeployment(
        {
          projectId: "web-app",
          tenantId: tenantB.id,
          environmentId: env.id,
          version: "1.0.0",
        },
        tenantB.toTenant(),
        env,
      );
      expect(resultB.status).toBe("succeeded");

      // Each tenant sees only their own result
      expect(tenantA.getDeployments()).toHaveLength(1);
      expect(tenantA.getDeployments()[0].status).toBe("failed");

      expect(tenantB.getDeployments()).toHaveLength(1);
      expect(tenantB.getDeployments()[0].status).toBe("succeeded");
    });

    it("A's failure diary entries don't leak into B's diary", async () => {
      const tenantA = manager.createTenant("Acme Corp");
      const tenantB = manager.createTenant("Beta Inc");
      const env = makeEnvironment();

      // A fails
      healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);
      await agent.triggerDeployment(
        {
          projectId: "web-app",
          tenantId: tenantA.id,
          environmentId: env.id,
          version: "1.0.0",
        },
        tenantA.toTenant(),
        env,
      );

      // B succeeds
      await agent.triggerDeployment(
        {
          projectId: "web-app",
          tenantId: tenantB.id,
          environmentId: env.id,
          version: "1.0.0",
        },
        tenantB.toTenant(),
        env,
      );

      // A has failure entries
      const failEntries = findDecisions(
        tenantA.getDiaryEntries(),
        "failed",
      );
      expect(failEntries.length).toBeGreaterThan(0);

      // B has zero failure entries
      const bFailEntries = findDecisions(
        tenantB.getDiaryEntries(),
        "failed",
      );
      expect(bFailEntries).toHaveLength(0);

      // B only has success-path entries
      const bSuccess = findDecisions(
        tenantB.getDiaryEntries(),
        "completed successfully",
      );
      expect(bSuccess).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // 5. TenantManager access control
  // -----------------------------------------------------------------------

  describe("manager access control", () => {
    it("getTenant returns undefined for non-existent tenant", () => {
      expect(manager.getTenant("does-not-exist")).toBeUndefined();
    });

    it("listTenants exposes metadata only — not data access paths", () => {
      manager.createTenant("Acme Corp", { SECRET: "s3cret" });
      manager.createTenant("Beta Inc");

      const list = manager.listTenants();
      expect(list).toHaveLength(2);

      // List contains id and name only
      for (const item of list) {
        expect(Object.keys(item)).toEqual(["id", "name"]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Variable precedence resolution
// ---------------------------------------------------------------------------

describe("Variable Precedence Resolution", () => {
  let diary: DecisionDiary;
  let deployments: InMemoryDeploymentStore;
  let manager: TenantManager;

  beforeEach(() => {
    diary = new DecisionDiary();
    deployments = new InMemoryDeploymentStore();
    manager = new TenantManager(deployments, diary);
  });

  it("tenant-level values override environment defaults", () => {
    const tenant = manager.createTenant("Acme Corp", {
      LOG_LEVEL: "error",
      DB_HOST: "acme-db",
    });
    const env = makeEnvironment({
      variables: { LOG_LEVEL: "warn", APP_ENV: "production" },
    });

    const { resolved, precedenceLog } = tenant.resolveVariables(env);

    expect(resolved.LOG_LEVEL).toBe("error"); // tenant wins
    expect(resolved.APP_ENV).toBe("production"); // env only
    expect(resolved.DB_HOST).toBe("acme-db"); // tenant only

    // Precedence log records the override
    const logOverride = precedenceLog.find((e) => e.variable === "LOG_LEVEL");
    expect(logOverride).toBeDefined();
    expect(logOverride!.source).toBe("tenant");
    expect(logOverride!.resolvedValue).toBe("error");
    expect(logOverride!.overrode).toEqual({
      value: "warn",
      source: "environment",
    });
    expect(logOverride!.reason).toContain("overrides");
    expect(logOverride!.reason).toContain("environment");
  });

  it("trigger overrides both tenant and environment", () => {
    const tenant = manager.createTenant("Acme Corp", {
      LOG_LEVEL: "error",
    });
    const env = makeEnvironment({
      variables: { LOG_LEVEL: "warn", APP_ENV: "production" },
    });

    const { resolved, precedenceLog } = tenant.resolveVariables(env, {
      LOG_LEVEL: "debug",
      APP_ENV: "staging",
    });

    expect(resolved.LOG_LEVEL).toBe("debug"); // trigger > tenant
    expect(resolved.APP_ENV).toBe("staging"); // trigger > environment

    // LOG_LEVEL trigger overrode tenant
    const logLevel = precedenceLog.find((e) => e.variable === "LOG_LEVEL");
    expect(logLevel!.source).toBe("trigger");
    expect(logLevel!.overrode).toEqual({ value: "error", source: "tenant" });

    // APP_ENV trigger overrode environment
    const appEnv = precedenceLog.find((e) => e.variable === "APP_ENV");
    expect(appEnv!.source).toBe("trigger");
    expect(appEnv!.overrode).toEqual({
      value: "production",
      source: "environment",
    });
  });

  it("full three-layer resolution: trigger > tenant > environment", () => {
    const tenant = manager.createTenant("Acme Corp", {
      DB_HOST: "acme-db",
      LOG_LEVEL: "error",
    });
    const env = makeEnvironment({
      variables: {
        APP_ENV: "production",
        LOG_LEVEL: "warn",
        REGION: "us-east-1",
      },
    });

    const { resolved, precedenceLog } = tenant.resolveVariables(env, {
      LOG_LEVEL: "debug",
    });

    // Full merged result
    expect(resolved).toEqual({
      APP_ENV: "production", // env only
      LOG_LEVEL: "debug", // trigger > tenant > env
      REGION: "us-east-1", // env only
      DB_HOST: "acme-db", // tenant only
    });

    // Every variable has a log entry
    expect(precedenceLog).toHaveLength(4);

    // LOG_LEVEL: trigger wins over tenant
    const logLevel = precedenceLog.find((e) => e.variable === "LOG_LEVEL")!;
    expect(logLevel.source).toBe("trigger");
    expect(logLevel.overrode!.source).toBe("tenant");
    expect(logLevel.overrode!.value).toBe("error");

    // REGION: environment default, no override
    const region = precedenceLog.find((e) => e.variable === "REGION")!;
    expect(region.source).toBe("environment");
    expect(region.overrode).toBeNull();
    expect(region.reason).toContain("no higher-level override");

    // DB_HOST: tenant-only
    const dbHost = precedenceLog.find((e) => e.variable === "DB_HOST")!;
    expect(dbHost.source).toBe("tenant");
    expect(dbHost.overrode).toBeNull();
    expect(dbHost.reason).toContain("not defined at environment level");
  });

  it("non-conflicting variables from all levels merge correctly", () => {
    const tenant = manager.createTenant("Acme Corp", {
      TENANT_ONLY: "t-val",
    });
    const env = makeEnvironment({
      variables: { ENV_ONLY: "e-val" },
    });

    const { resolved, precedenceLog } = tenant.resolveVariables(env, {
      TRIGGER_ONLY: "tr-val",
    });

    expect(resolved).toEqual({
      ENV_ONLY: "e-val",
      TENANT_ONLY: "t-val",
      TRIGGER_ONLY: "tr-val",
    });

    // No overrides — all variables come from distinct levels
    for (const entry of precedenceLog) {
      expect(entry.overrode).toBeNull();
    }
  });

  it("same value at multiple levels is not reported as an override", () => {
    const tenant = manager.createTenant("Acme Corp", {
      APP_ENV: "production",
    });
    const env = makeEnvironment({
      variables: { APP_ENV: "production" },
    });

    const { resolved, precedenceLog } = tenant.resolveVariables(env);

    expect(resolved.APP_ENV).toBe("production");

    // Tenant "wins" by precedence but value is the same — no override reported
    const appEnv = precedenceLog.find((e) => e.variable === "APP_ENV")!;
    expect(appEnv.source).toBe("tenant");
    expect(appEnv.overrode).toBeNull();
  });

  it("precedence log entries have plain-language reason for every conflict", () => {
    const tenant = manager.createTenant("Acme Corp", {
      DB_HOST: "acme-db",
      LOG_LEVEL: "error",
    });
    const env = makeEnvironment({
      variables: { DB_HOST: "default-db", LOG_LEVEL: "warn", REGION: "us-east-1" },
    });

    const { precedenceLog } = tenant.resolveVariables(env, {
      LOG_LEVEL: "debug",
    });

    // Every entry has a non-empty reason
    for (const entry of precedenceLog) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }

    // Overrides explain what was overridden
    const dbHost = precedenceLog.find((e) => e.variable === "DB_HOST")!;
    expect(dbHost.reason).toContain("overrides");
    expect(dbHost.reason).toContain("environment");

    const logLevel = precedenceLog.find((e) => e.variable === "LOG_LEVEL")!;
    expect(logLevel.reason).toContain("takes precedence");
    expect(logLevel.reason).toContain("tenant");
  });
});

// ---------------------------------------------------------------------------
// Variable precedence integrated with ServerAgent + Decision Diary
// ---------------------------------------------------------------------------

describe("Precedence Recording in Decision Diary", () => {
  let diary: DecisionDiary;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: ServerAgent;
  let manager: TenantManager;

  beforeEach(() => {
    diary = new DecisionDiary();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new ServerAgent(diary, deployments, healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
    manager = new TenantManager(deployments, diary);
  });

  it("ServerAgent records variable conflicts to the diary with full reasoning", async () => {
    const tenant = manager.createTenant("Acme Corp", {
      LOG_LEVEL: "error",
    });
    const env = makeEnvironment({
      variables: { LOG_LEVEL: "warn", APP_ENV: "production" },
    });

    const result = await agent.triggerDeployment(
      {
        projectId: "web-app",
        tenantId: tenant.id,
        environmentId: env.id,
        version: "1.0.0",
        variables: { LOG_LEVEL: "debug" },
      },
      tenant.toTenant(),
      env,
    );

    expect(result.status).toBe("succeeded");

    // The agent's diary entries record the conflict resolution
    const entries = tenant.getDiaryEntries();
    const configEntries = findDecisions(entries, "Configuration resolved");
    expect(configEntries).toHaveLength(1);
    expect(configEntries[0].reasoning).toContain("conflict");
    expect(configEntries[0].reasoning).toContain("precedence");

    // The standard override was recorded
    const overrideEntries = findDecisions(entries, "precedence rules");
    expect(overrideEntries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scale: 50 tenants
// ---------------------------------------------------------------------------

describe("Scale: 50 Tenants", () => {
  let diary: DecisionDiary;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: ServerAgent;
  let manager: TenantManager;

  beforeEach(() => {
    diary = new DecisionDiary();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new ServerAgent(diary, deployments, healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
    manager = new TenantManager(deployments, diary);
  });

  it("creates 50 tenants without performance degradation", () => {
    const start = performance.now();

    const tenants = Array.from({ length: 50 }, (_, i) =>
      manager.createTenant(`Tenant-${i}`, {
        DB_HOST: `db-${i}.internal`,
        APP_ENV: "production",
        TENANT_ID: `t-${i}`,
      }),
    );

    const elapsed = performance.now() - start;

    expect(manager.size).toBe(50);
    expect(tenants).toHaveLength(50);

    // Creation of 50 tenants should complete in well under 1 second
    expect(elapsed).toBeLessThan(1000);

    // Each tenant has unique id
    const ids = new Set(tenants.map((t) => t.id));
    expect(ids.size).toBe(50);
  });

  it("50 tenants maintain full isolation across deployments", async () => {
    const env = makeEnvironment({
      variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    });

    // Create 50 tenants with distinct variables
    const tenants = Array.from({ length: 50 }, (_, i) =>
      manager.createTenant(`Tenant-${i}`, {
        DB_HOST: `db-${i}.internal`,
        TENANT_MARKER: `marker-${i}`,
      }),
    );

    // Deploy to all 50 tenants
    const start = performance.now();
    const results = await Promise.all(
      tenants.map((tenant) =>
        agent.triggerDeployment(
          {
            projectId: "web-app",
            tenantId: tenant.id,
            environmentId: env.id,
            version: "1.0.0",
          },
          tenant.toTenant(),
          env,
        ),
      ),
    );
    const elapsed = performance.now() - start;

    // All 50 succeed
    for (const result of results) {
      expect(result.status).toBe("succeeded");
    }

    // 50 deployments in under 5 seconds (generous bound)
    expect(elapsed).toBeLessThan(5000);

    // Isolation: each tenant sees exactly 1 deployment
    for (let i = 0; i < 50; i++) {
      const tenantDeployments = tenants[i].getDeployments();
      expect(tenantDeployments).toHaveLength(1);
      expect(tenantDeployments[0].tenantId).toBe(tenants[i].id);

      // Variables resolved with this tenant's specific values
      expect(tenantDeployments[0].variables.DB_HOST).toBe(
        `db-${i}.internal`,
      );
      expect(tenantDeployments[0].variables.TENANT_MARKER).toBe(
        `marker-${i}`,
      );
      expect(tenantDeployments[0].variables.APP_ENV).toBe("production");
    }
  });

  it("tenant lookup is O(1) — constant time regardless of count", () => {
    // Create 50 tenants
    const tenants = Array.from({ length: 50 }, (_, i) =>
      manager.createTenant(`Tenant-${i}`),
    );

    // Lookup the 1st, 25th, and 50th tenant — all should be fast
    const ids = [tenants[0].id, tenants[24].id, tenants[49].id];
    const times: number[] = [];

    for (const id of ids) {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        manager.getTenant(id);
      }
      times.push(performance.now() - start);
    }

    // All 1000 lookups per tenant should be sub-millisecond territory
    // (generous bound: 50ms for 1000 lookups)
    for (const t of times) {
      expect(t).toBeLessThan(50);
    }

    // No dramatic variance — first and last should be within 10x of each other
    const ratio = Math.max(...times) / Math.min(...times);
    expect(ratio).toBeLessThan(10);
  });

  it("diary entries stay partitioned across all 50 tenants", async () => {
    const env = makeEnvironment();

    const tenants = Array.from({ length: 50 }, (_, i) =>
      manager.createTenant(`Tenant-${i}`),
    );

    // Deploy to all 50
    await Promise.all(
      tenants.map((tenant) =>
        agent.triggerDeployment(
          {
            projectId: "web-app",
            tenantId: tenant.id,
            environmentId: env.id,
            version: "1.0.0",
          },
          tenant.toTenant(),
          env,
        ),
      ),
    );

    // The full diary has entries for all 50
    const allEntries = diary.getRecent(10000);
    expect(allEntries.length).toBeGreaterThan(0);

    // But each container only sees its own
    for (let i = 0; i < 50; i++) {
      const entries = tenants[i].getDiaryEntries();
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.tenantId).toBe(tenants[i].id);
      }
    }

    // No tenant sees another tenant's entries
    for (let i = 0; i < 50; i++) {
      const myEntries = tenants[i].getDiaryEntries();
      for (const entry of myEntries) {
        // This entry should NOT appear in any other tenant's view
        for (let j = 0; j < 50; j++) {
          if (j === i) continue;
          const otherEntries = tenants[j].getDiaryEntries();
          const leaked = otherEntries.find((e) => e.id === entry.id);
          expect(leaked).toBeUndefined();
        }
      }
    }
  });

  it("variable resolution at scale — 50 tenants with different overrides", () => {
    const env = makeEnvironment({
      variables: {
        APP_ENV: "production",
        LOG_LEVEL: "warn",
        REGION: "us-east-1",
      },
    });

    const tenants = Array.from({ length: 50 }, (_, i) =>
      manager.createTenant(`Tenant-${i}`, {
        LOG_LEVEL: i % 2 === 0 ? "error" : "info",
        DB_HOST: `db-${i}.internal`,
      }),
    );

    const start = performance.now();

    for (let i = 0; i < 50; i++) {
      const { resolved, precedenceLog } = tenants[i].resolveVariables(env);

      // Correct precedence applied
      expect(resolved.APP_ENV).toBe("production"); // env
      expect(resolved.REGION).toBe("us-east-1"); // env
      expect(resolved.DB_HOST).toBe(`db-${i}.internal`); // tenant
      expect(resolved.LOG_LEVEL).toBe(i % 2 === 0 ? "error" : "info"); // tenant overrides env

      // LOG_LEVEL override recorded
      const logEntry = precedenceLog.find((e) => e.variable === "LOG_LEVEL")!;
      expect(logEntry.source).toBe("tenant");
      expect(logEntry.overrode).toEqual({ value: "warn", source: "environment" });
      expect(logEntry.reason).toContain("overrides");
    }

    const elapsed = performance.now() - start;
    // 50 resolutions in under 500ms
    expect(elapsed).toBeLessThan(500);
  });
});
