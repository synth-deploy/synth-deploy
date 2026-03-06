import { describe, it, expect, vi, afterEach } from "vitest";
import { DecisionDebrief } from "@synth-deploy/core";
import { InMemoryDeploymentStore } from "../src/agent/command-agent.js";
import { markStaleDeployments } from "../src/agent/stale-deployment-detector.js";
import type { Deployment } from "@synth-deploy/core";

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep-1",
    operationId: "op-1",
    partitionId: "part-1",
    environmentId: "env-1",
    version: "1.0",
    status: "running",
    variables: {},
    debriefEntryIds: [],
    orderId: null,
    createdAt: new Date(),
    completedAt: null,
    failureReason: null,
    ...overrides,
  };
}

describe("markStaleDeployments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks running deployments older than threshold as failed", () => {
    const deployments = new InMemoryDeploymentStore();
    const debrief = new DecisionDebrief();

    // Deployment created 35 minutes ago
    const oldDate = new Date(Date.now() - 35 * 60 * 1000);
    deployments.save(makeDeployment({ createdAt: oldDate }));

    const count = markStaleDeployments(deployments, debrief, 30 * 60 * 1000);

    expect(count).toBe(1);
    expect(deployments.get("dep-1")?.status).toBe("failed");
    expect(debrief.getRecent(1)[0].decisionType).toBe("deployment-failure");
  });

  it("does not touch running deployments within threshold", () => {
    const deployments = new InMemoryDeploymentStore();
    const debrief = new DecisionDebrief();

    // Deployment created 5 minutes ago
    const recentDate = new Date(Date.now() - 5 * 60 * 1000);
    deployments.save(makeDeployment({ createdAt: recentDate }));

    const count = markStaleDeployments(deployments, debrief, 30 * 60 * 1000);

    expect(count).toBe(0);
    expect(deployments.get("dep-1")?.status).toBe("running");
  });

  it("does not touch completed deployments", () => {
    const deployments = new InMemoryDeploymentStore();
    const debrief = new DecisionDebrief();

    const oldDate = new Date(Date.now() - 60 * 60 * 1000);
    deployments.save(makeDeployment({ status: "completed" as any, createdAt: oldDate }));

    const count = markStaleDeployments(deployments, debrief, 30 * 60 * 1000);

    expect(count).toBe(0);
  });

  it("handles multiple stale deployments", () => {
    const deployments = new InMemoryDeploymentStore();
    const debrief = new DecisionDebrief();

    const oldDate = new Date(Date.now() - 45 * 60 * 1000);
    deployments.save(makeDeployment({ id: "d1", createdAt: oldDate }));
    deployments.save(makeDeployment({ id: "d2", createdAt: oldDate }));

    const count = markStaleDeployments(deployments, debrief, 30 * 60 * 1000);

    expect(count).toBe(2);
    expect(deployments.get("d1")?.status).toBe("failed");
    expect(deployments.get("d2")?.status).toBe("failed");
  });
});
