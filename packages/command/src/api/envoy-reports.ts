import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DecisionTypeEnum } from "@deploystack/core";
import type { DebriefWriter, DecisionType } from "@deploystack/core";
import type { DeploymentStore } from "../agent/command-agent.js";

// ---------------------------------------------------------------------------
// Schema — validates incoming Envoy reports
// ---------------------------------------------------------------------------

const DebriefEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  partitionId: z.string().nullable(),
  deploymentId: z.string().nullable(),
  agent: z.enum(["command", "envoy"]),
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
): void {
  app.post("/api/envoy/report", async (request, reply) => {
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
      if (entry.deploymentId && entry.partitionId) {
        const deployment = deployments.get(entry.deploymentId);
        if (!deployment || deployment.partitionId !== entry.partitionId) {
          debrief.record({
            partitionId: entry.partitionId,
            deploymentId: entry.deploymentId,
            agent: "command",
            decisionType: "system",
            decision: "Rejected Envoy report: partition boundary violation",
            reasoning: `Deployment ${entry.deploymentId} does not belong to partition ${entry.partitionId}. Report from envoy ${report.envoyId} rejected.`,
            context: { envoyId: report.envoyId, reportedPartitionId: entry.partitionId },
          });
          return reply.status(403).send({
            error: "Partition boundary violation",
            detail: `Deployment ${entry.deploymentId} does not belong to partition ${entry.partitionId}`,
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
        deploymentId: entry.deploymentId,
        agent: entry.agent as "command" | "envoy",
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

    return reply.status(200).send({
      accepted: true,
      deploymentId: report.deploymentId,
      envoyId: report.envoyId,
      entriesIngested: ingested,
    });
  });
}
