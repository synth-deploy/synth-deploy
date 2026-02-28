import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DebriefWriter, DecisionType } from "@deploystack/core";

// ---------------------------------------------------------------------------
// Schema — validates incoming Envoy reports
// ---------------------------------------------------------------------------

const DebriefEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  partitionId: z.string().nullable(),
  deploymentId: z.string().nullable(),
  agent: z.enum(["server", "envoy"]),
  decisionType: z.string(),
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
 * Endpoint for Envoys to push reports back to the Server.
 *
 * When a Envoy completes a deployment (success or failure), it pushes
 * a report containing its full debrief entries. The Server ingests these
 * into its own debrief so there is one unified Debrief that contains
 * both the Server's orchestration decisions and the Envoy's execution
 * decisions.
 *
 * This is the Envoy->Server direction of bidirectional communication.
 */
export function registerEnvoyReportRoutes(
  app: FastifyInstance,
  debrief: DebriefWriter,
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
    let ingested = 0;

    // Ingest each Envoy debrief entry into the Server's debrief.
    // We re-record them (rather than inserting raw) so the Server's debrief
    // assigns its own IDs and timestamps. The original Envoy entry data
    // is preserved in the context field for traceability.
    for (const entry of report.debriefEntries) {
      debrief.record({
        partitionId: entry.partitionId,
        deploymentId: entry.deploymentId,
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

    return reply.status(200).send({
      accepted: true,
      deploymentId: report.deploymentId,
      envoyId: report.envoyId,
      entriesIngested: ingested,
    });
  });
}
