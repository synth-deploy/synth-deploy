import { describe, it, expect, beforeEach } from "vitest";
import {
  DecisionDebrief,
  OrderStore,
  generatePostmortem,
  generateOperationHistory,
} from "@deploystack/core";
import type {
  Partition,
  Environment,
  Deployment,
  DebriefEntry,
  Operation,
} from "@deploystack/core";
import {
  CommandAgent,
  InMemoryDeploymentStore,
} from "../src/agent/command-agent.js";
import type {
  ServiceHealthChecker,
  HealthCheckResult,
} from "../src/agent/health-checker.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class MockHealthChecker implements ServiceHealthChecker {
  private responses: HealthCheckResult[] = [];

  willReturn(...results: HealthCheckResult[]): void {
    this.responses.push(...results);
  }

  async check(): Promise<HealthCheckResult> {
    const next = this.responses.shift();
    if (next) return next;
    return { reachable: true, responseTimeMs: 1, error: null };
  }
}

const HEALTHY: HealthCheckResult = {
  reachable: true,
  responseTimeMs: 5,
  error: null,
};

const CONN_REFUSED: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "ECONNREFUSED: Connection refused",
};

const DNS_FAILURE: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "ENOTFOUND: DNS resolution failed for production.example.com",
};

const TIMEOUT: HealthCheckResult = {
  reachable: false,
  responseTimeMs: null,
  error: "ETIMEDOUT: Connection timed out after 30000ms",
};

function makePartition(overrides: Partial<Partition> = {}): Partition {
  return {
    id: "partition-1",
    name: "Acme Corp",
    variables: {},
    createdAt: new Date(),
    ...overrides,
  };
}

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-prod",
    name: "production",
    variables: {},
    ...overrides,
  };
}

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "web-app",
    name: "web-app",
    environmentIds: ["env-prod"],
    steps: [],
    deployConfig: {
      healthCheckEnabled: true,
      healthCheckRetries: 1,
      timeoutMs: 30000,
      verificationStrategy: "basic",
    },
    ...overrides,
  };
}

/**
 * Test convenience: creates an Order snapshot and triggers deployment in one call.
 * Mirrors the old API where tests passed (trigger, partition, env, operation) directly.
 */
async function testDeploy(
  agent: CommandAgent,
  oldTrigger: { operationId?: string; partitionId?: string; environmentId?: string; version?: string; variables?: Record<string, string> },
  partition?: Partition,
  environment?: Environment,
  operation?: Operation,
) {
  const p = partition ?? makePartition();
  const e = environment ?? makeEnvironment();
  const op = operation ?? makeOperation();
  const version = oldTrigger.version ?? "2.0.0";

  const effectivePartition = oldTrigger.partitionId && oldTrigger.partitionId !== p.id
    ? makePartition({ id: oldTrigger.partitionId })
    : p;

  const order = agent.createOrderSnapshot(version, effectivePartition, e, op);
  const trigger = {
    orderId: order.id,
    partitionId: effectivePartition.id,
    environmentId: e.id,
    triggeredBy: "user" as const,
    ...(oldTrigger.variables ? { variables: oldTrigger.variables } : {}),
  };
  return agent.triggerDeployment(trigger, effectivePartition, e, op, order);
}

// ---------------------------------------------------------------------------
// SCENARIO 1: Simulated Postmortem
// ---------------------------------------------------------------------------
//
// Success condition: Given a deployment that failed, a reviewer should be
// able to read the Diary and understand exactly what the agent decided,
// why it rolled back or continued, and what the suggested fix is,
// without reading any log files.
// ---------------------------------------------------------------------------

describe("Simulated Postmortem — failed deployment read experience", () => {
  let diary: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new CommandAgent(diary, deployments, new OrderStore(), healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
  });

  it("health check failure postmortem — reviewer understands what happened without logs", async () => {
    // Scenario: deployment fails because target environment is unreachable
    healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);

    const deployment = await testDeploy(agent, {});

    expect(deployment.status).toBe("failed");

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    // 1. Reviewer can identify WHAT was being deployed
    expect(postmortem.summary).toContain("web-app");
    expect(postmortem.summary).toContain("v2.0.0");
    expect(postmortem.summary).toContain("production");
    expect(postmortem.summary).toContain("Acme Corp");
    expect(postmortem.summary).toContain("FAILED");

    // 2. Reviewer can see every decision in chronological order
    expect(postmortem.timeline.length).toBeGreaterThanOrEqual(3);
    const steps = postmortem.timeline.map((t) => t.step);
    expect(steps).toContain("pipeline-plan");
    expect(steps).toContain("configuration-resolved");
    expect(steps).toContain("health-check");

    // 3. Reviewer can understand WHY it failed
    expect(postmortem.failureAnalysis).not.toBeNull();
    expect(postmortem.failureAnalysis!.failedStep).toBe(
      "preflight-health-check",
    );
    expect(postmortem.failureAnalysis!.whatHappened).toContain(
      "Deployment failed",
    );
    expect(postmortem.failureAnalysis!.whyItFailed).toContain(
      "ECONNREFUSED",
    );

    // 4. Reviewer gets a SUGGESTED FIX
    expect(postmortem.failureAnalysis!.suggestedFix.length).toBeGreaterThan(
      10,
    );
    expect(
      postmortem.failureAnalysis!.suggestedFix.toLowerCase(),
    ).toContain("verify");

    // 5. The formatted output is self-contained
    expect(postmortem.formatted).toContain("# Deployment Postmortem");
    expect(postmortem.formatted).toContain("## Summary");
    expect(postmortem.formatted).toContain("## Decision Timeline");
    expect(postmortem.formatted).toContain("## Failure Analysis");
    expect(postmortem.formatted).toContain("### Suggested Fix");
    expect(postmortem.formatted).toContain("## Outcome");
  });

  it("DNS failure postmortem — immediate abort explained clearly", async () => {
    healthChecker.willReturn(DNS_FAILURE);

    const deployment = await testDeploy(agent, {});

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    // The postmortem should explain that DNS failures don't benefit from retry
    expect(postmortem.failureAnalysis).not.toBeNull();
    expect(postmortem.failureAnalysis!.whyItFailed).toContain("DNS");
    expect(postmortem.failureAnalysis!.suggestedFix.toLowerCase()).toContain(
      "dns",
    );

    // Timeline should show the abort happened without retry
    const healthEntries = postmortem.timeline.filter(
      (t) => t.step === "health-check",
    );
    expect(healthEntries.length).toBeGreaterThanOrEqual(1);
    const abortEntry = healthEntries.find((h) =>
      h.decision.toLowerCase().includes("abort"),
    );
    expect(abortEntry).toBeDefined();
  });

  it("configuration block postmortem — cross-env conflict explained", async () => {
    // Two connectivity variables pointing cross-environment → should block
    const partition = makePartition({
      variables: {
        DB_HOST: "staging-db.internal",
        API_ENDPOINT: "https://staging-api.example.com",
      },
    });
    const env = makeEnvironment({
      name: "production",
      variables: {
        DB_HOST: "prod-db.internal",
        API_ENDPOINT: "https://prod-api.example.com",
      },
    });

    healthChecker.willReturn(HEALTHY);

    const deployment = await testDeploy(agent, {}, partition, env);

    expect(deployment.status).toBe("failed");

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    // Should explain the configuration block
    expect(postmortem.failureAnalysis).not.toBeNull();
    expect(postmortem.failureAnalysis!.failedStep).toBe(
      "resolve-configuration",
    );

    // Conflicts should be surfaced
    expect(postmortem.configuration.conflictCount).toBeGreaterThan(0);
    expect(postmortem.configuration.conflicts.length).toBeGreaterThan(0);

    // Suggested fix should mention verifying variable bindings
    expect(postmortem.failureAnalysis!.suggestedFix.length).toBeGreaterThan(
      10,
    );

    // Formatted output should contain conflict details
    expect(postmortem.formatted).toContain("Conflicts");
  });

  it("successful deployment postmortem — no failure analysis, clean outcome", async () => {
    healthChecker.willReturn(HEALTHY);

    const deployment = await testDeploy(agent, {});

    expect(deployment.status).toBe("succeeded");

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    expect(postmortem.summary).toContain("SUCCEEDED");
    expect(postmortem.failureAnalysis).toBeNull();
    expect(postmortem.outcome).toContain("completed");

    // Should NOT contain failure analysis section in formatted output
    expect(postmortem.formatted).not.toContain("## Failure Analysis");
    expect(postmortem.formatted).toContain("## Outcome");
  });

  it("retry-then-succeed postmortem — shows the full decision chain", async () => {
    // First health check fails (connection refused), retry succeeds
    healthChecker.willReturn(CONN_REFUSED, HEALTHY);

    const deployment = await testDeploy(agent, {});

    expect(deployment.status).toBe("succeeded");

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    // Timeline should show the retry decision chain
    const healthEntries = postmortem.timeline.filter(
      (t) => t.step === "health-check",
    );
    expect(healthEntries.length).toBeGreaterThanOrEqual(2);

    // Should show retry decision and recovery
    const retryEntry = healthEntries.find((h) =>
      h.decision.toLowerCase().includes("retry"),
    );
    const recoveryEntry = healthEntries.find((h) =>
      h.decision.toLowerCase().includes("recovered"),
    );
    expect(retryEntry).toBeDefined();
    expect(recoveryEntry).toBeDefined();

    // No failure analysis — deployment ultimately succeeded
    expect(postmortem.failureAnalysis).toBeNull();
    expect(postmortem.summary).toContain("SUCCEEDED");
  });

  it("postmortem formatted output is self-contained — readable without any other document", async () => {
    healthChecker.willReturn(CONN_REFUSED, CONN_REFUSED);

    const deployment = await testDeploy(
      agent,
      { version: "3.1.0" },
      makePartition({ name: "Widget Inc" }),
      makeEnvironment({ name: "staging" }),
    );

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    const text = postmortem.formatted;

    // Contains all identifying information
    expect(text).toContain("web-app");
    expect(text).toContain("3.1.0");
    expect(text).toContain("staging");
    expect(text).toContain("Widget Inc");
    expect(text).toContain(deployment.id);

    // Contains timing information
    expect(text).toContain("Started:");
    expect(text).toContain("Completed:");
    expect(text).toContain("Duration:");

    // Contains the decision timeline with reasoning
    expect(text).toContain("PIPELINE-PLAN");
    expect(text).toContain("Decision:");
    expect(text).toContain("Reasoning:");

    // Contains suggested fix
    expect(text).toContain("Suggested Fix");

    // A reviewer reading this text can answer:
    // - What was deployed? (operation, version, environment, partition)
    // - What did the agent decide? (timeline)
    // - Why did it fail? (failure analysis)
    // - What should I do? (suggested fix)
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 2: Simulated Onboarding Read
// ---------------------------------------------------------------------------
//
// Success condition: Given an operation with 10 deployments in its history,
// a new engineer should be able to read the Diary and understand the
// operation's configuration decisions and deployment patterns.
// ---------------------------------------------------------------------------

describe("Simulated Onboarding — operation history read experience", () => {
  let diary: DecisionDebrief;
  let deploymentStore: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deploymentStore = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new CommandAgent(diary, deploymentStore, new OrderStore(), healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
  });

  async function runDeploymentHistory(): Promise<Deployment[]> {
    const partition = makePartition({
      id: "acme",
      name: "Acme Corp",
      variables: { APP_ENV: "production", LOG_LEVEL: "warn" },
    });
    const prodEnv = makeEnvironment({
      id: "env-prod",
      name: "production",
      variables: { APP_ENV: "production", LOG_LEVEL: "info" },
    });
    const stagingEnv = makeEnvironment({
      id: "env-staging",
      name: "staging",
      variables: { APP_ENV: "staging", LOG_LEVEL: "debug" },
    });

    const prodOperation = makeOperation({ environmentIds: ["env-prod"] });
    const stagingOperation = makeOperation({ environmentIds: ["env-staging"] });

    const results: Deployment[] = [];

    // Deployment 1: v1.0.0 to staging — clean success
    healthChecker.willReturn(HEALTHY);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "1.0.0" }, partition, stagingEnv, stagingOperation),
    );

    // Deployment 2: v1.0.0 to production — clean success
    healthChecker.willReturn(HEALTHY);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "1.0.0" }, partition, prodEnv, prodOperation),
    );

    // Deployment 3: v1.1.0 to staging — with LOG_LEVEL conflict
    healthChecker.willReturn(HEALTHY);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "1.1.0", variables: { LOG_LEVEL: "error" } }, partition, stagingEnv, stagingOperation),
    );

    // Deployment 4: v1.1.0 to production — health check fails then recovers
    healthChecker.willReturn(CONN_REFUSED, HEALTHY);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "1.1.0" }, partition, prodEnv, prodOperation),
    );

    // Deployment 5: v1.2.0 to staging — clean
    healthChecker.willReturn(HEALTHY);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "1.2.0" }, partition, stagingEnv, stagingOperation),
    );

    // Deployment 6: v1.2.0 to production — DNS failure
    healthChecker.willReturn(DNS_FAILURE);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "1.2.0" }, partition, prodEnv, prodOperation),
    );

    // Deployment 7: v1.2.0 to production retry — succeeds after fix
    healthChecker.willReturn(HEALTHY);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "1.2.0" }, partition, prodEnv, prodOperation),
    );

    // Deployment 8: v2.0.0 to staging — clean
    healthChecker.willReturn(HEALTHY);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "2.0.0" }, partition, stagingEnv, stagingOperation),
    );

    // Deployment 9: v2.0.0 to production — with variable conflict
    healthChecker.willReturn(HEALTHY);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "2.0.0", variables: { LOG_LEVEL: "debug" } }, partition, prodEnv, prodOperation),
    );

    // Deployment 10: v2.1.0 to staging — clean
    healthChecker.willReturn(HEALTHY);
    results.push(
      await testDeploy(agent, { partitionId: "acme", version: "2.1.0" }, partition, stagingEnv, stagingOperation),
    );

    return results;
  }

  it("new engineer can see overall operation health at a glance", async () => {
    const deploymentResults = await runDeploymentHistory();
    const allEntries = diary.getByPartition("acme");
    const history = generateOperationHistory(allEntries, deploymentResults);

    // Overview tells the engineer the big picture
    expect(history.overview.totalDeployments).toBe(10);
    expect(history.overview.succeeded).toBe(9);
    expect(history.overview.failed).toBe(1);
    expect(history.overview.successRate).toBe("90%");

    // Environments used
    expect(history.overview.environments).toContain("production");
    expect(history.overview.environments).toContain("staging");

    // Versions deployed
    expect(history.overview.versions).toContain("1.0.0");
    expect(history.overview.versions).toContain("1.1.0");
    expect(history.overview.versions).toContain("1.2.0");
    expect(history.overview.versions).toContain("2.0.0");
    expect(history.overview.versions).toContain("2.1.0");
  });

  it("new engineer can trace every deployment outcome", async () => {
    const deploymentResults = await runDeploymentHistory();
    const allEntries = diary.getByPartition("acme");
    const history = generateOperationHistory(allEntries, deploymentResults);

    // All 10 deployments are listed
    expect(history.deployments).toHaveLength(10);

    // Each deployment has version, environment, outcome, and key decision
    for (const d of history.deployments) {
      expect(d.version).toBeTruthy();
      expect(d.environment).toBeTruthy();
      expect(["succeeded", "failed"]).toContain(d.outcome);
      expect(d.keyDecision.length).toBeGreaterThan(5);
    }

    // Deployment 6 (v1.2.0 to production) was the failure
    const failedDeploys = history.deployments.filter(
      (d) => d.outcome === "failed",
    );
    expect(failedDeploys).toHaveLength(1);
    expect(failedDeploys[0].version).toBe("1.2.0");
    expect(failedDeploys[0].environment).toBe("production");
  });

  it("new engineer can see configuration patterns and recurring issues", async () => {
    const deploymentResults = await runDeploymentHistory();
    const allEntries = diary.getByPartition("acme");
    const history = generateOperationHistory(allEntries, deploymentResults);

    // Configuration patterns are surfaced
    expect(history.configurationPatterns.length).toBeGreaterThan(0);

    // Should see variable conflict pattern
    const conflictPattern = history.configurationPatterns.find((p) =>
      p.pattern.toLowerCase().includes("conflict") ||
      p.pattern.toLowerCase().includes("override"),
    );
    expect(conflictPattern).toBeDefined();
    expect(conflictPattern!.occurrences).toBeGreaterThanOrEqual(1);
    expect(conflictPattern!.detail.length).toBeGreaterThan(10);
  });

  it("new engineer can understand per-environment behavior", async () => {
    const deploymentResults = await runDeploymentHistory();
    const allEntries = diary.getByPartition("acme");
    const history = generateOperationHistory(allEntries, deploymentResults);

    // Environment notes present for both environments
    expect(history.environmentNotes.length).toBe(2);

    const prodNotes = history.environmentNotes.find(
      (n) => n.environment === "production",
    );
    const stagingNotes = history.environmentNotes.find(
      (n) => n.environment === "staging",
    );

    expect(prodNotes).toBeDefined();
    expect(stagingNotes).toBeDefined();

    // Production had failures
    expect(prodNotes!.deploymentCount).toBe(5);
    // 4 succeeded, 1 failed = 80%
    expect(prodNotes!.successRate).toBe("80%");
    // Production should have notes about failures
    const hasFailureNote = prodNotes!.notes.some((n) =>
      n.toLowerCase().includes("failure"),
    );
    expect(hasFailureNote).toBe(true);

    // Staging was clean
    expect(stagingNotes!.deploymentCount).toBe(5);
    expect(stagingNotes!.successRate).toBe("100%");
  });

  it("new engineer can read the formatted output and understand everything", async () => {
    const deploymentResults = await runDeploymentHistory();
    const allEntries = diary.getByPartition("acme");
    const history = generateOperationHistory(allEntries, deploymentResults);

    const text = history.formatted;

    // Structure is present
    expect(text).toContain("# Operation Deployment History");
    expect(text).toContain("## Overview");
    expect(text).toContain("## Deployment Timeline");
    expect(text).toContain("## Configuration Patterns");
    expect(text).toContain("## Environment Notes");

    // Key stats are visible
    expect(text).toContain("Total deployments: 10");
    expect(text).toContain("9 succeeded");
    expect(text).toContain("1 failed");
    expect(text).toContain("90%");

    // Deployment timeline entries are numbered
    expect(text).toContain("1. v1.0.0");
    expect(text).toContain("10. v2.1.0");

    // Environment breakdown is present
    expect(text).toContain("### production");
    expect(text).toContain("### staging");

    // A new engineer reading this text can answer:
    // - How many deployments has this operation had? (10)
    // - What's the success rate? (90%)
    // - Which environments are used? (production, staging)
    // - What versions have been deployed? (1.0.0 through 2.1.0)
    // - Are there recurring configuration issues? (yes, variable conflicts)
    // - Which environment has problems? (production — 80% vs staging 100%)
    // - What kind of failures occur? (DNS, health check issues)
  });

  it("deployment timeline shows outcome markers (OK vs FAILED) for quick scanning", async () => {
    const deploymentResults = await runDeploymentHistory();
    const allEntries = diary.getByPartition("acme");
    const history = generateOperationHistory(allEntries, deploymentResults);

    const text = history.formatted;

    // Quick-scan markers
    const okCount = (text.match(/-- OK/g) || []).length;
    const failedCount = (text.match(/-- FAILED/g) || []).length;

    expect(okCount).toBe(9);
    expect(failedCount).toBe(1);
  });

  it("deployment timeline shows conflict counts where they occurred", async () => {
    const deploymentResults = await runDeploymentHistory();
    const allEntries = diary.getByPartition("acme");
    const history = generateOperationHistory(allEntries, deploymentResults);

    // Deployments with conflicts should have conflict counts
    const deploymentsWithConflicts = history.deployments.filter(
      (d) => d.conflictCount > 0,
    );
    expect(deploymentsWithConflicts.length).toBeGreaterThan(0);

    // The formatted text should show conflict markers
    const text = history.formatted;
    expect(text).toContain("conflict");
  });

  it("handles an operation with zero deployments gracefully", () => {
    const history = generateOperationHistory([], []);

    expect(history.overview.totalDeployments).toBe(0);
    expect(history.overview.successRate).toBe("N/A");
    expect(history.deployments).toHaveLength(0);
    expect(history.configurationPatterns).toHaveLength(0);
    expect(history.environmentNotes).toHaveLength(0);

    expect(history.formatted).toContain("Total deployments: 0");
  });
});

// ---------------------------------------------------------------------------
// Postmortem structural guarantees
// ---------------------------------------------------------------------------

describe("Postmortem report — structural guarantees", () => {
  let diary: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;
  let healthChecker: MockHealthChecker;
  let agent: CommandAgent;

  beforeEach(() => {
    diary = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    healthChecker = new MockHealthChecker();
    agent = new CommandAgent(diary, deployments, new OrderStore(), healthChecker, {
      healthCheckBackoffMs: 1,
      executionDelayMs: 1,
    });
  });

  it("timeline entries are sorted chronologically", async () => {
    healthChecker.willReturn(CONN_REFUSED, HEALTHY);

    const deployment = await testDeploy(agent, {});

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    for (let i = 1; i < postmortem.timeline.length; i++) {
      expect(
        postmortem.timeline[i].timestamp.getTime(),
      ).toBeGreaterThanOrEqual(
        postmortem.timeline[i - 1].timestamp.getTime(),
      );
    }
  });

  it("configuration section accurately reflects variable and conflict counts", async () => {
    const partition = makePartition({
      variables: { LOG_LEVEL: "error", APP_ENV: "production" },
    });
    const env = makeEnvironment({
      variables: { LOG_LEVEL: "warn", APP_ENV: "production", DB_POOL: "10" },
    });
    healthChecker.willReturn(HEALTHY);

    const deployment = await testDeploy(agent, { variables: { LOG_LEVEL: "debug" } }, partition, env);

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    // LOG_LEVEL has three-way conflict (env → partition → trigger), total vars = 3
    expect(postmortem.configuration.variableCount).toBeGreaterThanOrEqual(3);
    expect(postmortem.configuration.conflictCount).toBeGreaterThanOrEqual(1);
  });

  it("failure analysis is null for successful deployments", async () => {
    healthChecker.willReturn(HEALTHY);

    const deployment = await testDeploy(agent, {});

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    expect(postmortem.failureAnalysis).toBeNull();
  });

  it("failure analysis includes the failed step name", async () => {
    healthChecker.willReturn(DNS_FAILURE);

    const deployment = await testDeploy(agent, {});

    const entries = diary.getByDeployment(deployment.id);
    const postmortem = generatePostmortem(entries, deployment);

    expect(postmortem.failureAnalysis).not.toBeNull();
    expect(postmortem.failureAnalysis!.failedStep).toBe(
      "preflight-health-check",
    );
  });
});
