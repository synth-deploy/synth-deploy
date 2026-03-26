import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DecisionTypeEnum } from "@synth-deploy/core";
import type { DebriefWriter, DecisionType } from "@synth-deploy/core";
import type { DeploymentStore } from "../agent/synth-agent.js";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";

// ---------------------------------------------------------------------------
// Schema — validates incoming Envoy reports
// ---------------------------------------------------------------------------

const DebriefEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  partitionId: z.string().nullable(),
  operationId: z.string().nullable(),
  agent: z.enum(["server", "envoy"]),
  decisionType: DecisionTypeEnum,
  decision: z.string(),
  reasoning: z.string(),
  context: z.record(z.unknown()),
});

const EnvoyReportSchema = z.object({
  type: z.literal("deployment-result"),
  envoyId: z.string(),
  deploymentId: z.string(),
  success: z.boolean(),
  failureReason: z.string().nullable(),
  debriefEntries: z.array(DebriefEntrySchema),
  summary: z.object({
    artifacts: z.array(z.string()),
    workspacePath: z.string(),
    executionDurationMs: z.number(),
    totalDurationMs: z.number(),
    verificationPassed: z.boolean(),
    verificationChecks: z.array(
      z.object({
        name: z.string(),
        passed: z.boolean(),
        detail: z.string(),
      }),
    ),
  }),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Endpoint for Envoys to push reports back to Command.
 *
 * When a Envoy completes a deployment (success or failure), it pushes
 * a report containing its full debrief entries. Command ingests these
 * into its own debrief so there is one unified Debrief that contains
 * both Command's orchestration decisions and the Envoy's execution
 * decisions.
 *
 * This is the Envoy->Command direction of bidirectional communication.
 */
export function registerEnvoyReportRoutes(
  app: FastifyInstance,
  debrief: DebriefWriter,
  deployments: DeploymentStore,
  registry: EnvoyRegistry,
): void {
  app.post("/api/envoy/report", async (request, reply) => {
    const authHeader = (request.headers.authorization ?? "") as string;
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token || !registry.validateToken(token)) {
      return reply.status(401).send({ error: "Invalid or missing envoy token" });
    }

    const parsed = EnvoyReportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid Envoy report",
        details: parsed.error.format(),
      });
    }

    const report = parsed.data;

    // Validate partition boundary: each debrief entry's deploymentId must
    // belong to the claimed partitionId. Reject cross-partition reports.
    for (const entry of report.debriefEntries) {
      if (entry.operationId && entry.partitionId) {
        const deployment = deployments.get(entry.operationId);
        if (!deployment || deployment.partitionId !== entry.partitionId) {
          debrief.record({
            partitionId: entry.partitionId,
            operationId: entry.operationId,
            agent: "server",
            decisionType: "system",
            decision: "Rejected Envoy report: partition boundary violation",
            reasoning: `Deployment ${entry.operationId} does not belong to partition ${entry.partitionId}. Report from envoy ${report.envoyId} rejected.`,
            context: { envoyId: report.envoyId, reportedPartitionId: entry.partitionId },
          });
          return reply.status(403).send({
            error: "Partition boundary violation",
            detail: `Deployment ${entry.operationId} does not belong to partition ${entry.partitionId}`,
          });
        }
      }
    }

    let ingested = 0;

    // Ingest each Envoy debrief entry into Command's debrief.
    // We re-record them (rather than inserting raw) so Command's debrief
    // assigns its own IDs and timestamps. The original Envoy entry data
    // is preserved in the context field for traceability.
    for (const entry of report.debriefEntries) {
      debrief.record({
        partitionId: entry.partitionId,
        operationId: entry.operationId,
        agent: entry.agent as "server" | "envoy",
        decisionType: entry.decisionType as DecisionType,
        decision: entry.decision,
        reasoning: entry.reasoning,
        context: {
          ...entry.context,
          _envoyReport: {
            envoyId: report.envoyId,
            originalEntryId: entry.id,
            originalTimestamp: entry.timestamp,
          },
        },
      });
      ingested++;
    }

    // Update deployment status based on the result
    const deployment = deployments.get(report.deploymentId);
    if (deployment && deployment.status === "running") {
      let finalStatus: typeof deployment.status;
      if (report.success) {
        finalStatus = "succeeded" as typeof deployment.status;
      } else {
        const hadRollback = report.debriefEntries.some((e) => e.decisionType === "rollback-execution");
        finalStatus = (hadRollback ? "rolled_back" : "failed") as typeof deployment.status;
      }
      deployment.status = finalStatus;
      if (!report.success && report.failureReason) {
        deployment.failureReason = report.failureReason;
      }
      deployment.completedAt = new Date();
      deployments.save(deployment);
    }

    return reply.status(200).send({
      accepted: true,
      deploymentId: report.deploymentId,
      envoyId: report.envoyId,
      entriesIngested: ingested,
    });
  });
}
