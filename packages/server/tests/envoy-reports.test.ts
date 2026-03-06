import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { DecisionDebrief } from "@synth-deploy/core";
import { InMemoryDeploymentStore } from "../src/agent/synth-agent.js";
import { registerEnvoyReportRoutes } from "../src/api/envoy-reports.js";

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    type: "deployment-result",
    envoyId: "envoy-1",
    deploymentId: "dep-1",
    success: true,
    failureReason: null,
    debriefEntries: [
      {
        id: "entry-1",
        timestamp: new Date().toISOString(),
        partitionId: "part-1",
        deploymentId: "dep-1",
        agent: "envoy",
        decisionType: "deployment-execution",
        decision: "Ran step",
        reasoning: "It was the next step",
        context: {},
      },
    ],
    summary: {
      artifacts: [],
      workspacePath: "/tmp/ws",
      executionDurationMs: 100,
      totalDurationMs: 200,
      verificationPassed: true,
      verificationChecks: [],
    },
    ...overrides,
  };
}

describe("Envoy report ingestion", () => {
  let app: FastifyInstance;
  let debrief: DecisionDebrief;
  let deployments: InMemoryDeploymentStore;

  beforeEach(async () => {
    app = Fastify();
    debrief = new DecisionDebrief();
    deployments = new InMemoryDeploymentStore();
    registerEnvoyReportRoutes(app, debrief, deployments);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("accepts a valid report when deployment belongs to partition", async () => {
    deployments.save({
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
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/envoy/report",
      payload: makeReport(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().accepted).toBe(true);
    expect(res.json().entriesIngested).toBe(1);
  });

  it("rejects report with cross-partition deployment (403)", async () => {
    // Deployment belongs to part-2, but report claims part-1
    deployments.save({
      id: "dep-1",
      operationId: "op-1",
      partitionId: "part-2",
      environmentId: "env-1",
      version: "1.0",
      status: "running",
      variables: {},
      debriefEntryIds: [],
      orderId: null,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/envoy/report",
      payload: makeReport(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain("Partition boundary");
  });

  it("rejects report with unknown deployment (403)", async () => {
    // No deployment saved — dep-1 doesn't exist
    const res = await app.inject({
      method: "POST",
      url: "/api/envoy/report",
      payload: makeReport(),
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects invalid decisionType", async () => {
    deployments.save({
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
    });

    const report = makeReport();
    (report as any).debriefEntries[0].decisionType = "totally-fake-type";

    const res = await app.inject({
      method: "POST",
      url: "/api/envoy/report",
      payload: report,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid");
  });
});
