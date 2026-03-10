/**
 * Intake API routes — channel management, webhook receiver, API intake, events.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { IArtifactStore } from "@synth-deploy/core";
import { requirePermission } from "../middleware/permissions.js";
import type { IntakeChannelStore, IntakeEventStore } from "../intake/intake-store.js";
import type { IntakeProcessor } from "../intake/intake-processor.js";
import type { RegistryPoller } from "../intake/registry-poller.js";
import { parseWebhook } from "../intake/webhook-handlers.js";
import type { RegistryConfig } from "@synth-deploy/core";

/** Extract a semver-like version from a filename. Returns null if none found. */
function extractVersionFromFilename(filename: string): string | null {
  const match = filename.match(/[-_v](\d+\.\d+[\.\d-]*)(?:\.\w+)*$/);
  return match ? match[1] : null;
}

/** Strip version suffix and extension(s) from a filename to get the artifact name. */
function extractNameFromFilename(filename: string): string {
  // Remove all extensions first
  let name = filename;
  // Strip common multi-part extensions like .tar.gz, .tar.bz2
  name = name.replace(/\.tar\.\w+$/, "");
  // Strip remaining single extension
  name = name.replace(/\.\w+$/, "");
  // Strip trailing version suffix: -1.2.3 or _1.2.3 or -v1.2.3
  name = name.replace(/[-_]v?\d+[\d.\-]*$/, "");
  return name || filename;
}

export function registerIntakeRoutes(
  app: FastifyInstance,
  channelStore: IntakeChannelStore,
  eventStore: IntakeEventStore,
  processor: IntakeProcessor,
  poller: RegistryPoller,
  artifactStore: IArtifactStore,
): void {
  // -----------------------------------------------------------------------
  // Channel management (require settings.manage permission)
  // -----------------------------------------------------------------------

  // List all intake channels
  app.get(
    "/api/intake/channels",
    { preHandler: [requirePermission("settings.manage")] },
    async () => {
      const channels = channelStore.list().map((ch) => ({
        ...ch,
        // Never expose authToken in list responses — only on creation
        authToken: undefined,
      }));
      return { channels };
    },
  );

  // Create a new intake channel
  app.post(
    "/api/intake/channels",
    { preHandler: [requirePermission("settings.manage")] },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const type = body.type as string;
      const name = body.name as string;
      const config = (body.config as Record<string, unknown>) ?? {};
      const enabled = body.enabled !== false;

      if (!type || !name) {
        return reply.status(400).send({ error: "type and name are required" });
      }

      if (!["webhook", "registry", "api", "manual"].includes(type)) {
        return reply.status(400).send({ error: "type must be one of: webhook, registry, api, manual" });
      }

      // Generate an auth token for webhook channels
      const authToken = type === "webhook" || type === "api"
        ? crypto.randomUUID()
        : undefined;

      const channel = channelStore.create({
        type: type as "webhook" | "registry" | "api" | "manual",
        name,
        enabled,
        config,
        authToken,
      });

      // Start polling if it's a registry channel and enabled
      if (type === "registry" && enabled) {
        poller.startPolling(channel);
      }

      return reply.status(201).send({ channel });
    },
  );

  // Update an intake channel
  app.put<{ Params: { id: string } }>(
    "/api/intake/channels/:id",
    { preHandler: [requirePermission("settings.manage")] },
    async (request, reply) => {
      const channel = channelStore.get(request.params.id);
      if (!channel) {
        return reply.status(404).send({ error: "Channel not found" });
      }

      const body = request.body as Record<string, unknown>;
      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (body.config !== undefined) updates.config = body.config;

      const updated = channelStore.update(request.params.id, updates as Parameters<typeof channelStore.update>[1]);

      // Handle registry polling state changes
      if (updated.type === "registry") {
        if (updated.enabled) {
          poller.startPolling(updated);
        } else {
          poller.stopPolling(updated.id);
        }
      }

      return { channel: { ...updated, authToken: undefined } };
    },
  );

  // Delete an intake channel
  app.delete<{ Params: { id: string } }>(
    "/api/intake/channels/:id",
    { preHandler: [requirePermission("settings.manage")] },
    async (request, reply) => {
      const channel = channelStore.get(request.params.id);
      if (!channel) {
        return reply.status(404).send({ error: "Channel not found" });
      }

      // Stop polling if applicable
      if (channel.type === "registry") {
        poller.stopPolling(channel.id);
      }

      channelStore.delete(request.params.id);
      return reply.status(204).send();
    },
  );

  // Test registry connection
  app.post<{ Params: { id: string } }>(
    "/api/intake/channels/:id/test",
    { preHandler: [requirePermission("settings.manage")] },
    async (request, reply) => {
      const channel = channelStore.get(request.params.id);
      if (!channel) {
        return reply.status(404).send({ error: "Channel not found" });
      }

      if (channel.type !== "registry") {
        return reply.status(400).send({ error: "Test is only available for registry channels" });
      }

      const config = channel.config as unknown as RegistryConfig;
      try {
        const baseUrl = config.url.replace(/\/$/, "");
        const headers: Record<string, string> = {};
        if (config.credentials) {
          const auth = Buffer.from(`${config.credentials.username}:${config.credentials.password}`).toString("base64");
          headers["Authorization"] = `Basic ${auth}`;
        }

        let testUrl: string;
        switch (config.type) {
          case "docker":
            testUrl = `${baseUrl}/v2/`;
            break;
          case "npm":
            testUrl = baseUrl || "https://registry.npmjs.org/";
            break;
          case "nuget":
            testUrl = `${baseUrl || "https://api.nuget.org/v3"}/index.json`;
            break;
          default:
            testUrl = baseUrl;
        }

        const res = await fetch(testUrl, { headers, signal: AbortSignal.timeout(10_000) });
        if (res.ok || res.status === 401) {
          // 401 means the registry exists but needs auth — still a valid connection
          return { success: true, status: res.status };
        }
        return { success: false, error: `HTTP ${res.status}: ${res.statusText}` };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Connection failed" };
      }
    },
  );

  // -----------------------------------------------------------------------
  // Webhook receiver — authenticated by channel token in URL, NOT JWT
  // -----------------------------------------------------------------------

  app.post<{ Params: { channelId: string } }>(
    "/api/intake/webhook/:channelId",
    async (request, reply) => {
      const channel = channelStore.get(request.params.channelId);
      if (!channel) {
        return reply.status(404).send({ error: "Channel not found" });
      }

      if (!channel.enabled) {
        return reply.status(403).send({ error: "Channel is disabled" });
      }

      if (channel.type !== "webhook") {
        return reply.status(400).send({ error: "Channel is not a webhook channel" });
      }

      // Validate auth token from query parameter or header
      const queryToken = (request.query as Record<string, string>).token;
      const headerToken = request.headers["x-intake-token"] as string | undefined;
      const token = queryToken || headerToken;

      if (!token || token !== channel.authToken) {
        return reply.status(401).send({ error: "Invalid or missing intake token" });
      }

      // Create intake event
      const event = eventStore.create({
        channelId: channel.id,
        status: "received",
        payload: (request.body as Record<string, unknown>) ?? {},
      });

      // Parse the webhook payload
      const source = (channel.config as Record<string, unknown>).source as string ?? "generic";
      const parsed = parseWebhook(source, request.body);

      if (!parsed) {
        eventStore.update(event.id, {
          status: "failed",
          error: "Could not parse webhook payload",
          processedAt: new Date(),
        });
        return reply.status(422).send({ error: "Could not parse webhook payload", eventId: event.id });
      }

      // Process the payload asynchronously
      eventStore.update(event.id, { status: "processing" });

      try {
        const result = await processor.process(parsed, channel.id);
        eventStore.update(event.id, {
          status: "completed",
          artifactId: result.artifactId,
          processedAt: new Date(),
        });

        return reply.status(201).send({
          eventId: event.id,
          artifactId: result.artifactId,
          versionId: result.versionId,
        });
      } catch (err) {
        eventStore.update(event.id, {
          status: "failed",
          error: err instanceof Error ? err.message : "Processing failed",
          processedAt: new Date(),
        });
        return reply.status(500).send({
          error: "Intake processing failed",
          eventId: event.id,
        });
      }
    },
  );

  // -----------------------------------------------------------------------
  // API intake — JWT authenticated, direct artifact submission
  // -----------------------------------------------------------------------

  app.post(
    "/api/intake/artifacts",
    { preHandler: [requirePermission("artifact.create")] },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const artifactName = body.artifactName as string;
      const artifactType = body.artifactType as string;
      const version = body.version as string;
      const source = (body.source as string) ?? "api";
      const downloadUrl = body.downloadUrl as string | undefined;
      const metadata = (body.metadata as Record<string, unknown>) ?? {};

      if (!artifactName || !version) {
        return reply.status(400).send({ error: "artifactName and version are required" });
      }

      const event = eventStore.create({
        channelId: "api-direct",
        status: "processing",
        payload: body,
      });

      try {
        const result = await processor.process(
          {
            artifactName,
            artifactType: artifactType ?? "unknown",
            version,
            source,
            downloadUrl,
            metadata,
          },
          "api-direct",
        );

        eventStore.update(event.id, {
          status: "completed",
          artifactId: result.artifactId,
          processedAt: new Date(),
        });

        return reply.status(201).send({
          eventId: event.id,
          artifactId: result.artifactId,
          versionId: result.versionId,
        });
      } catch (err) {
        eventStore.update(event.id, {
          status: "failed",
          error: err instanceof Error ? err.message : "Processing failed",
          processedAt: new Date(),
        });
        return reply.status(500).send({
          error: "Intake processing failed",
          eventId: event.id,
        });
      }
    },
  );

  // -----------------------------------------------------------------------
  // Manual upload — form-based artifact submission via UI
  // -----------------------------------------------------------------------

  app.post(
    "/api/intake/manual",
    { preHandler: [requirePermission("artifact.create")] },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const artifactName = body.artifactName as string;
      const artifactType = body.artifactType as string;
      const version = body.version as string;
      const source = (body.source as string) ?? "manual-upload";
      const metadata = (body.metadata as Record<string, unknown>) ?? {};

      if (!artifactName || !artifactType || !version) {
        return reply.status(400).send({ error: "artifactName, artifactType, and version are required" });
      }

      const event = eventStore.create({
        channelId: "manual",
        status: "processing",
        payload: body,
      });

      try {
        const result = await processor.process(
          {
            artifactName,
            artifactType,
            version,
            source,
            metadata,
          },
          "manual",
        );

        eventStore.update(event.id, {
          status: "completed",
          artifactId: result.artifactId,
          processedAt: new Date(),
        });

        return reply.status(201).send({
          eventId: event.id,
          artifactId: result.artifactId,
          versionId: result.versionId,
        });
      } catch (err) {
        eventStore.update(event.id, {
          status: "failed",
          error: err instanceof Error ? err.message : "Processing failed",
          processedAt: new Date(),
        });
        return reply.status(500).send({
          error: "Intake processing failed",
          eventId: event.id,
        });
      }
    },
  );

  // -----------------------------------------------------------------------
  // File upload — multipart/form-data artifact submission
  // -----------------------------------------------------------------------

  app.post(
    "/api/intake/upload",
    { preHandler: [requirePermission("artifact.create")] },
    async (request, reply) => {
      let fileBuffer: Buffer | null = null;
      let originalFilename = "";
      let existingArtifactId: string | undefined;

      try {
        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === "file") {
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
              chunks.push(chunk as Buffer);
            }
            fileBuffer = Buffer.concat(chunks);
            originalFilename = part.filename ?? "unknown";
          } else if (part.type === "field" && part.fieldname === "existingArtifactId") {
            existingArtifactId = String(part.value ?? "").trim() || undefined;
          }
        }
      } catch (err) {
        return reply.status(400).send({ error: "Failed to parse multipart upload" });
      }

      if (!fileBuffer || !originalFilename) {
        return reply.status(400).send({ error: "File is required" });
      }

      // If attaching to an existing artifact, look it up to get the canonical name
      let artifactName: string;
      let artifactType: string;
      if (existingArtifactId) {
        const existing = artifactStore.get(existingArtifactId);
        if (!existing) {
          return reply.status(404).send({ error: "Artifact not found" });
        }
        artifactName = existing.name;
        artifactType = existing.type;
      } else {
        artifactName = extractNameFromFilename(originalFilename);
        artifactType = "unknown";
      }

      const version = extractVersionFromFilename(originalFilename) ?? "unknown";

      const event = eventStore.create({
        channelId: "manual-upload",
        status: "processing",
        payload: { filename: originalFilename, artifactName, version },
      });

      try {
        const result = await processor.process(
          {
            artifactName,
            artifactType,
            version,
            source: "manual-upload",
            metadata: { filename: originalFilename },
            content: fileBuffer,
          },
          "manual-upload",
        );

        eventStore.update(event.id, {
          status: "completed",
          artifactId: result.artifactId,
          processedAt: new Date(),
        });

        return reply.status(201).send({
          eventId: event.id,
          artifactId: result.artifactId,
          versionId: result.versionId,
        });
      } catch (err) {
        eventStore.update(event.id, {
          status: "failed",
          error: err instanceof Error ? err.message : "Processing failed",
          processedAt: new Date(),
        });
        return reply.status(500).send({
          error: "Upload processing failed",
          eventId: event.id,
        });
      }
    },
  );

  // -----------------------------------------------------------------------
  // Events — view recent intake events
  // -----------------------------------------------------------------------

  app.get(
    "/api/intake/events",
    { preHandler: [requirePermission("artifact.view")] },
    async (request) => {
      const query = request.query as Record<string, string>;
      const channelId = query.channelId;
      const limit = parseInt(query.limit ?? "50", 10);

      const events = channelId
        ? eventStore.listByChannel(channelId, limit)
        : eventStore.listRecent(limit);

      return { events };
    },
  );
}
