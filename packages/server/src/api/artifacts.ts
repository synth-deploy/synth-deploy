import type { FastifyInstance } from "fastify";
import type { IArtifactStore, ITelemetryStore } from "@synth-deploy/core";
import { requirePermission } from "../middleware/permissions.js";
import {
  CreateArtifactSchema,
  UpdateArtifactSchema,
  AddAnnotationSchema,
  AddArtifactVersionSchema,
} from "./schemas.js";

export function registerArtifactRoutes(
  app: FastifyInstance,
  artifactStore: IArtifactStore,
  telemetry: ITelemetryStore,
): void {
  // List all artifacts
  app.get("/api/artifacts", { preHandler: [requirePermission("artifact.view")] }, async () => {
    return { artifacts: artifactStore.list() };
  });

  // Create artifact
  app.post("/api/artifacts", { preHandler: [requirePermission("artifact.create")] }, async (request, reply) => {
    const parsed = CreateArtifactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const artifact = artifactStore.create({
      name: parsed.data.name,
      type: parsed.data.type,
      analysis: {
        summary: "",
        dependencies: [],
        configurationExpectations: {},
        deploymentIntent: "",
        confidence: 0,
      },
      annotations: [],
      learningHistory: [],
    });

    telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "artifact.created", target: { type: "artifact", id: artifact.id }, details: { name: parsed.data.name, type: parsed.data.type } });
    return reply.status(201).send({ artifact });
  });

  // Get artifact by ID (with analysis, annotations, learning history)
  app.get<{ Params: { id: string } }>("/api/artifacts/:id", { preHandler: [requirePermission("artifact.view")] }, async (request, reply) => {
    const artifact = artifactStore.get(request.params.id);
    if (!artifact) {
      return reply.status(404).send({ error: "Artifact not found" });
    }

    const versions = artifactStore.getVersions(artifact.id);

    return { artifact, versions };
  });

  // Update artifact metadata
  app.put<{ Params: { id: string } }>("/api/artifacts/:id", { preHandler: [requirePermission("artifact.update")] }, async (request, reply) => {
    const parsed = UpdateArtifactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const artifact = artifactStore.get(request.params.id);
    if (!artifact) {
      return reply.status(404).send({ error: "Artifact not found" });
    }

    try {
      const updated = artifactStore.update(request.params.id, parsed.data as Record<string, unknown>);
      return { artifact: updated };
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes("not found")) {
        return reply.status(404).send({ error: "Artifact not found" });
      }
      app.log.error(err, "Failed to update artifact");
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // Delete artifact
  app.delete<{ Params: { id: string } }>("/api/artifacts/:id", { preHandler: [requirePermission("artifact.delete")] }, async (request, reply) => {
    const artifact = artifactStore.get(request.params.id);
    if (!artifact) {
      return reply.status(404).send({ error: "Artifact not found" });
    }

    artifactStore.delete(request.params.id);
    return reply.status(204).send();
  });

  // Add user annotation/correction
  app.post<{ Params: { id: string } }>(
    "/api/artifacts/:id/annotations",
    { preHandler: [requirePermission("artifact.annotate")] },
    async (request, reply) => {
      const artifact = artifactStore.get(request.params.id);
      if (!artifact) {
        return reply.status(404).send({ error: "Artifact not found" });
      }

      const parsed = AddAnnotationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      const updated = artifactStore.addAnnotation(request.params.id, {
        field: parsed.data.field,
        correction: parsed.data.correction,
        annotatedBy: "operator",
        annotatedAt: new Date(),
      });

      telemetry.record({ actor: (request.user?.email) ?? "anonymous", action: "artifact.annotated", target: { type: "artifact", id: request.params.id }, details: { field: parsed.data.field } });
      return reply.status(201).send({ artifact: updated });
    },
  );

  // List versions for artifact
  app.get<{ Params: { id: string } }>(
    "/api/artifacts/:id/versions",
    { preHandler: [requirePermission("artifact.view")] },
    async (request, reply) => {
      const artifact = artifactStore.get(request.params.id);
      if (!artifact) {
        return reply.status(404).send({ error: "Artifact not found" });
      }

      const versions = artifactStore.getVersions(request.params.id);
      return { versions };
    },
  );

  // Add new version
  app.post<{ Params: { id: string } }>(
    "/api/artifacts/:id/versions",
    { preHandler: [requirePermission("artifact.create")] },
    async (request, reply) => {
      const artifact = artifactStore.get(request.params.id);
      if (!artifact) {
        return reply.status(404).send({ error: "Artifact not found" });
      }

      const parsed = AddArtifactVersionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.message });
      }

      const version = artifactStore.addVersion({
        artifactId: request.params.id,
        version: parsed.data.version,
        source: parsed.data.source,
        metadata: parsed.data.metadata ?? {},
      });

      return reply.status(201).send({ version });
    },
  );

  // Get specific version
  app.get<{ Params: { id: string; versionId: string } }>(
    "/api/artifacts/:id/versions/:versionId",
    { preHandler: [requirePermission("artifact.view")] },
    async (request, reply) => {
      const artifact = artifactStore.get(request.params.id);
      if (!artifact) {
        return reply.status(404).send({ error: "Artifact not found" });
      }

      const versions = artifactStore.getVersions(request.params.id);
      const version = versions.find((v) => v.id === request.params.versionId);
      if (!version) {
        return reply.status(404).send({ error: "Version not found" });
      }

      return { version };
    },
  );
}
