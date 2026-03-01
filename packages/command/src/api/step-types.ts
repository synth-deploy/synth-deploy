import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { IStepTypeStore, StepTypeDefinition, StepTypeExport } from "@deploystack/core";
import { listPredefinedStepTypes, getPredefinedStepType } from "@deploystack/core";
import { CreateStepTypeSchema, ImportStepTypeSchema } from "./schemas.js";

export function registerStepTypeRoutes(
  app: FastifyInstance,
  stepTypes: IStepTypeStore,
): void {
  // List all step types (predefined + custom for optional partition)
  app.get<{ Querystring: { partitionId?: string } }>(
    "/api/step-types",
    async (request) => {
      const predefined = listPredefinedStepTypes();
      const custom = stepTypes.list(request.query.partitionId);
      return { stepTypes: [...predefined, ...custom] };
    },
  );

  // Get a single step type by ID
  app.get<{ Params: { id: string } }>(
    "/api/step-types/:id",
    async (request, reply) => {
      // Check predefined first, then custom
      const predefined = getPredefinedStepType(request.params.id);
      if (predefined) return { stepType: predefined };

      const custom = stepTypes.get(request.params.id);
      if (custom) return { stepType: custom };

      return reply.status(404).send({ error: "Step type not found" });
    },
  );

  // Create a custom step type
  app.post("/api/step-types", async (request, reply) => {
    const parsed = CreateStepTypeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    const stepType: StepTypeDefinition = {
      id: crypto.randomUUID(),
      name: parsed.data.name.trim(),
      category: parsed.data.category,
      description: parsed.data.description.trim(),
      parameters: parsed.data.parameters,
      commandTemplate: parsed.data.commandTemplate,
      source: "custom",
      partitionId: parsed.data.partitionId,
    };

    stepTypes.create(stepType);
    return reply.status(201).send({ stepType });
  });

  // Delete a custom step type
  app.delete<{ Params: { id: string } }>(
    "/api/step-types/:id",
    async (request, reply) => {
      // Cannot delete predefined step types
      if (getPredefinedStepType(request.params.id)) {
        return reply.status(400).send({ error: "Cannot delete predefined step types" });
      }

      const deleted = stepTypes.delete(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: "Step type not found" });
      }
      return { deleted: true };
    },
  );

  // Export a step type
  app.get<{ Params: { id: string } }>(
    "/api/step-types/:id/export",
    async (request, reply) => {
      const predefined = getPredefinedStepType(request.params.id);
      const custom = predefined ? undefined : stepTypes.get(request.params.id);
      const stepType = predefined ?? custom;

      if (!stepType) {
        return reply.status(404).send({ error: "Step type not found" });
      }

      const exported: StepTypeExport = {
        formatVersion: 1,
        stepType: {
          id: stepType.id,
          name: stepType.name,
          category: stepType.category,
          description: stepType.description,
          parameters: stepType.parameters,
          commandTemplate: stepType.commandTemplate,
        },
      };

      return exported;
    },
  );

  // Import a step type
  app.post("/api/step-types/import", async (request, reply) => {
    const parsed = ImportStepTypeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid import format", details: parsed.error.format() });
    }

    const { stepType: importedType, partitionId } = parsed.data;

    // Check for ID collision with predefined types
    if (getPredefinedStepType(importedType.id)) {
      return reply.status(409).send({ error: "A predefined step type with this ID already exists" });
    }

    // Check for existing custom type with same ID
    if (stepTypes.get(importedType.id)) {
      return reply.status(409).send({ error: "A custom step type with this ID already exists" });
    }

    const stepType: StepTypeDefinition = {
      ...importedType,
      source: "community",
      partitionId,
    };

    stepTypes.create(stepType);
    return reply.status(201).send({ stepType });
  });
}
