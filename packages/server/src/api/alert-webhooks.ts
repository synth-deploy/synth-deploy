/**
 * Alert Webhook API routes — channel management + alert receipt endpoint.
 *
 * External monitoring systems (Prometheus AlertManager, PagerDuty, Datadog,
 * Grafana) POST alerts here. Synth parses them, creates operations, and
 * dispatches planning through the normal operation flow.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  IDeploymentStore,
  IEnvironmentStore,
  IPartitionStore,
  ITelemetryStore,
  DebriefWriter,
  AlertWebhookSource,
} from "@synth-deploy/core";
import type { PersistentAlertWebhookStore } from "@synth-deploy/core";
import { requirePermission } from "../middleware/permissions.js";
import { parseAlerts, interpolateIntent } from "../alert-webhooks/alert-parsers.js";
import { EnvoyClient } from "../agent/envoy-client.js";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";

const VALID_SOURCES: AlertWebhookSource[] = ["prometheus", "pagerduty", "datadog", "grafana", "generic"];
const VALID_OP_TYPES = ["maintain", "deploy", "query", "investigate"] as const;

export function registerAlertWebhookRoutes(
  app: FastifyInstance,
  store: PersistentAlertWebhookStore,
  deployments: IDeploymentStore,
  debrief: DebriefWriter,
  environments: IEnvironmentStore,
  partitions: IPartitionStore,
  telemetry: ITelemetryStore,
  envoyRegistry?: EnvoyRegistry,
): void {

  // -----------------------------------------------------------------------
  // Channel management — JWT-protected CRUD
  // -----------------------------------------------------------------------

  app.get(
    "/api/alert-webhooks",
    { preHandler: [requirePermission("settings.manage")] },
    async () => {
      const channels = store.list().map((ch) => ({
        ...ch,
        // Never expose authToken in list responses
        authToken: undefined,
      }));
      return { channels };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/alert-webhooks/:id",
    { preHandler: [requirePermission("settings.manage")] },
    async (request, reply) => {
      const channel = store.get(request.params.id);
      if (!channel) {
        return reply.status(404).send({ error: "Alert webhook channel not found" });
      }
      return { channel: { ...channel, authToken: undefined } };
    },
  );

  app.post(
    "/api/alert-webhooks",
    { preHandler: [requirePermission("settings.manage")] },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const name = body.name as string;
      const source = body.source as string;
      const defaultOperationType = (body.defaultOperationType as string) ?? "maintain";
      const defaultIntent = body.defaultIntent as string | undefined;
      const environmentId = body.environmentId as string | undefined;
      const partitionId = body.partitionId as string | undefined;
      const envoyId = body.envoyId as string | undefined;

      if (!name) {
        return reply.status(400).send({ error: "name is required" });
      }
      if (!source || !VALID_SOURCES.includes(source as AlertWebhookSource)) {
        return reply.status(400).send({ error: `source must be one of: ${VALID_SOURCES.join(", ")}` });
      }
      if (!VALID_OP_TYPES.includes(defaultOperationType as typeof VALID_OP_TYPES[number])) {
        return reply.status(400).send({ error: `defaultOperationType must be one of: ${VALID_OP_TYPES.join(", ")}` });
      }

      const authToken = crypto.randomUUID();
      const channel = store.create({
        name,
        source: source as AlertWebhookSource,
        enabled: true,
        authToken,
        defaultOperationType: defaultOperationType as "maintain" | "deploy" | "query" | "investigate",
        defaultIntent,
        environmentId,
        partitionId,
        envoyId,
      });

      const actor = (request.user as { email?: string })?.email ?? "anonymous";
      telemetry.record({
        actor,
        action: "alert-webhook.created",
        target: { type: "alert-webhook", id: channel.id },
        details: { source, name },
      });

      // Return the full channel including authToken (only on creation)
      return reply.status(201).send({
        channel,
        webhookUrl: `/api/alert-webhooks/receive/${channel.id}`,
      });
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/alert-webhooks/:id",
    { preHandler: [requirePermission("settings.manage")] },
    async (request, reply) => {
      const existing = store.get(request.params.id);
      if (!existing) {
        return reply.status(404).send({ error: "Alert webhook channel not found" });
      }

      const body = request.body as Record<string, unknown>;
      const updates: Record<string, unknown> = {};

      if (body.name !== undefined) updates.name = body.name;
      if (body.source !== undefined) {
        if (!VALID_SOURCES.includes(body.source as AlertWebhookSource)) {
          return reply.status(400).send({ error: `source must be one of: ${VALID_SOURCES.join(", ")}` });
        }
        updates.source = body.source;
      }
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.defaultOperationType !== undefined) {
        if (!VALID_OP_TYPES.includes(body.defaultOperationType as typeof VALID_OP_TYPES[number])) {
          return reply.status(400).send({ error: `defaultOperationType must be one of: ${VALID_OP_TYPES.join(", ")}` });
        }
        updates.defaultOperationType = body.defaultOperationType;
      }
      if (body.defaultIntent !== undefined) updates.defaultIntent = body.defaultIntent;
      if (body.environmentId !== undefined) updates.environmentId = body.environmentId;
      if (body.partitionId !== undefined) updates.partitionId = body.partitionId;
      if (body.envoyId !== undefined) updates.envoyId = body.envoyId;

      const updated = store.update(request.params.id, updates);
      return { channel: { ...updated, authToken: undefined } };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/alert-webhooks/:id",
    { preHandler: [requirePermission("settings.manage")] },
    async (request, reply) => {
      const deleted = store.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: "Alert webhook channel not found" });
      }
      return { deleted: true };
    },
  );

  // -----------------------------------------------------------------------
  // Alert receipt — token-authenticated, JWT-exempt
  // -----------------------------------------------------------------------

  app.post<{ Params: { channelId: string } }>(
    "/api/alert-webhooks/receive/:channelId",
    async (request, reply) => {
      const channel = store.get(request.params.channelId);
      if (!channel) {
        return reply.status(404).send({ error: "Webhook channel not found" });
      }

      if (!channel.enabled) {
        return reply.status(403).send({ error: "Webhook channel is disabled" });
      }

      // Validate auth token from query parameter or header
      const queryToken = (request.query as Record<string, string>).token;
      const headerToken = request.headers["x-webhook-token"] as string | undefined;
      const authHeader = request.headers.authorization;
      const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
      const token = queryToken || headerToken || bearerToken;

      if (!token || token !== channel.authToken) {
        return reply.status(401).send({ error: "Invalid or missing webhook token" });
      }

      // Parse the alert payload
      const alerts = parseAlerts(channel.source, request.body);

      if (alerts.length === 0) {
        return reply.status(200).send({
          received: true,
          operationsCreated: 0,
          reason: "No firing alerts in payload (resolved alerts are ignored)",
        });
      }

      const createdOps: string[] = [];

      for (const alert of alerts) {
        // Deduplication: check for active operations from this channel with the same alert name
        const allOps = deployments.list();
        const activeExisting = allOps.find(
          (op) =>
            op.lineage === `alert-webhook:${channel.id}` &&
            op.intent?.includes(alert.name) &&
            ["pending", "planning", "awaiting_approval", "approved", "running"].includes(op.status),
        );

        if (activeExisting) {
          debrief.record({
            partitionId: channel.partitionId ?? null,
            operationId: activeExisting.id,
            agent: "server",
            decisionType: "alert-webhook-suppressed",
            decision: `Alert "${alert.name}" suppressed — operation ${activeExisting.id} is already in progress (${activeExisting.status})`,
            reasoning: `Deduplication: an operation for this alert from webhook channel "${channel.name}" is already active.`,
            context: { channelId: channel.id, alertName: alert.name, activeOpId: activeExisting.id },
          });
          continue;
        }

        // Build intent from template or alert summary
        const intent = channel.defaultIntent
          ? interpolateIntent(channel.defaultIntent, alert)
          : `[${alert.severity.toUpperCase()}] ${alert.name}: ${alert.summary}`;

        // Resolve environment/partition variables
        const environment = channel.environmentId ? environments.get(channel.environmentId) : undefined;
        const partition = channel.partitionId ? partitions.get(channel.partitionId) : undefined;
        const envVars = environment?.variables ?? {};
        const partitionVars = partition?.variables ?? {};
        const resolved: Record<string, string> = { ...partitionVars, ...envVars };

        const operationInput = channel.defaultOperationType === "deploy"
          ? { type: "deploy" as const, artifactId: "" }
          : channel.defaultOperationType === "investigate"
            ? { type: "investigate" as const, intent }
            : channel.defaultOperationType === "query"
              ? { type: "query" as const, intent }
              : { type: "maintain" as const, intent };

        const operation = {
          id: crypto.randomUUID(),
          input: operationInput,
          intent,
          lineage: `alert-webhook:${channel.id}`,
          triggeredBy: "webhook" as const,
          environmentId: channel.environmentId,
          partitionId: channel.partitionId,
          envoyId: channel.envoyId,
          version: "",
          status: "pending" as const,
          variables: resolved,
          debriefEntryIds: [] as string[],
          createdAt: new Date(),
        };

        deployments.save(operation);
        createdOps.push(operation.id);

        // Record the alert receipt in debrief
        debrief.record({
          partitionId: channel.partitionId ?? null,
          operationId: operation.id,
          agent: "server",
          decisionType: "alert-webhook-received",
          decision: `External alert received from ${channel.source}: "${alert.name}" (${alert.severity})`,
          reasoning: `Webhook channel "${channel.name}" received a ${alert.severity} alert. Intent: ${intent}`,
          context: {
            channelId: channel.id,
            channelName: channel.name,
            source: channel.source,
            alertName: alert.name,
            alertSeverity: alert.severity,
            alertLabels: alert.labels,
            rawPayload: alert.rawPayload,
          },
        });

        telemetry.record({
          actor: `webhook:${channel.name}`,
          action: "alert-webhook.fired",
          target: { type: "deployment" as const, id: operation.id },
          details: { channelId: channel.id, alertName: alert.name, severity: alert.severity },
        });

        // Dispatch planning to an envoy
        if (envoyRegistry) {
          const targetEnvoy = channel.envoyId
            ? envoyRegistry.get(channel.envoyId)
            : environment
              ? envoyRegistry.findForEnvironment(environment.name)
              : envoyRegistry.list()[0];

          if (targetEnvoy) {
            const planningClient = new EnvoyClient(targetEnvoy.url);
            const environmentForPlanning = environment
              ? { id: environment.id, name: environment.name, variables: environment.variables }
              : { id: `direct:${targetEnvoy.id}`, name: targetEnvoy.name, variables: {} };

            planningClient.requestPlan({
              operationId: operation.id,
              operationType: channel.defaultOperationType as "deploy" | "query" | "investigate" | "maintain",
              intent,
              environment: environmentForPlanning,
              partition: partition
                ? { id: partition.id, name: partition.name, variables: partition.variables }
                : undefined,
              version: "",
              resolvedVariables: resolved,
              envoyContext: targetEnvoy.envoyContext ?? undefined,
            }).then((result) => {
              const dep = deployments.get(operation.id);
              if (!dep || dep.status !== "pending") return;

              dep.plan = result.plan;
              dep.rollbackPlan = result.rollbackPlan;
              dep.envoyId = targetEnvoy.id;

              if (result.blocked) {
                dep.status = "failed" as typeof dep.status;
                dep.failureReason = result.blockReason ?? "Plan blocked";
                deployments.save(dep);
              } else {
                dep.status = "awaiting_approval" as typeof dep.status;
                deployments.save(dep);
              }
            }).catch((err) => {
              const dep = deployments.get(operation.id);
              if (!dep || dep.status !== "pending") return;
              dep.status = "failed" as typeof dep.status;
              dep.failureReason = err instanceof Error ? err.message : "Planning failed";
              deployments.save(dep);
            });
          }
        }
      }

      return reply.status(201).send({
        received: true,
        operationsCreated: createdOps.length,
        operationIds: createdOps,
      });
    },
  );
}
