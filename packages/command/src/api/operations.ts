import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { IOperationStore, IEnvironmentStore, DeploymentStep } from "@deploystack/core";
import {
  CreateOperationSchema, UpdateOperationSchema, AddEnvironmentSchema,
  CreateStepSchema, UpdateStepSchema, ReorderStepsSchema, UpdateDeployConfigSchema,
} from "./schemas.js";

export function registerOperationRoutes(
  app: FastifyInstance,
  operations: IOperationStore,
  environments: IEnvironmentStore,
): void {
  // Create an operation
  app.post("/api/operations", async (request, reply) => {
    const parsed = CreateOperationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    // Validate environment IDs if provided
    const envIds = parsed.data.environmentIds ?? [];
    for (const envId of envIds) {
      if (!environments.get(envId)) {
        return reply.status(404).send({ error: `Environment not found: ${envId}` });
      }
    }

    const operation = operations.create(parsed.data.name.trim(), envIds);
    return reply.status(201).send({ operation });
  });

  // List all operations
  app.get("/api/operations", async () => {
    return { operations: operations.list() };
  });

  // Get operation by ID
  app.get<{ Params: { id: string } }>("/api/operations/:id", async (request, reply) => {
    const operation = operations.get(request.params.id);
    if (!operation) {
      return reply.status(404).send({ error: "Operation not found" });
    }

    // Resolve environment names for display
    const envDetails = operation.environmentIds
      .map((eid) => environments.get(eid))
      .filter(Boolean);

    return { operation, environments: envDetails };
  });

  // Update operation
  app.put<{ Params: { id: string } }>("/api/operations/:id", async (request, reply) => {
    const parsed = UpdateOperationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
    }

    try {
      const operation = operations.update(request.params.id, {
        name: parsed.data.name?.trim(),
      });
      return { operation };
    } catch {
      return reply.status(404).send({ error: "Operation not found" });
    }
  });

  // Delete operation
  app.delete<{ Params: { id: string } }>("/api/operations/:id", async (request, reply) => {
    const operation = operations.get(request.params.id);
    if (!operation) {
      return reply.status(404).send({ error: "Operation not found" });
    }
    operations.delete(request.params.id);
    return { deleted: true };
  });

  // --- Environment links ---

  // Add environment to operation
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/environments",
    async (request, reply) => {
      const parsed = AddEnvironmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
      }
      const { environmentId } = parsed.data;

      if (!environments.get(environmentId)) {
        return reply.status(404).send({ error: `Environment not found: ${environmentId}` });
      }

      try {
        const operation = operations.addEnvironment(request.params.id, environmentId);
        return { operation };
      } catch {
        return reply.status(404).send({ error: "Operation not found" });
      }
    },
  );

  // Remove environment from operation
  app.delete<{ Params: { id: string; envId: string } }>(
    "/api/operations/:id/environments/:envId",
    async (request, reply) => {
      try {
        const operation = operations.removeEnvironment(
          request.params.id,
          request.params.envId,
        );
        return { operation };
      } catch {
        return reply.status(404).send({ error: "Operation not found" });
      }
    },
  );

  // --- Deployment steps ---

  // List steps
  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/steps",
    async (request, reply) => {
      const operation = operations.get(request.params.id);
      if (!operation) {
        return reply.status(404).send({ error: "Operation not found" });
      }
      return { steps: operation.steps };
    },
  );

  // Create step
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/steps",
    async (request, reply) => {
      const operation = operations.get(request.params.id);
      if (!operation) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const parsed = CreateStepSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
      }

      const step: DeploymentStep = {
        id: crypto.randomUUID(),
        name: parsed.data.name.trim(),
        type: parsed.data.type,
        command: parsed.data.command.trim(),
        order: parsed.data.order ?? operation.steps.length,
      };

      operations.addStep(request.params.id, step);

      return reply.status(201).send({ step });
    },
  );

  // Update step
  app.put<{ Params: { id: string; stepId: string } }>(
    "/api/operations/:id/steps/:stepId",
    async (request, reply) => {
      const operation = operations.get(request.params.id);
      if (!operation) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const step = operation.steps.find((s) => s.id === request.params.stepId);
      if (!step) {
        return reply.status(404).send({ error: "Step not found" });
      }

      const parsed = UpdateStepSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
      }

      const updates: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) updates.name = parsed.data.name.trim();
      if (parsed.data.type !== undefined) updates.type = parsed.data.type;
      if (parsed.data.command !== undefined) updates.command = parsed.data.command.trim();
      if (parsed.data.order !== undefined) updates.order = parsed.data.order;

      const updated = operations.updateStep(request.params.id, request.params.stepId, updates);

      return { step: updated.steps.find((s) => s.id === request.params.stepId) };
    },
  );

  // Reorder steps
  app.post<{ Params: { id: string } }>(
    "/api/operations/:id/steps/reorder",
    async (request, reply) => {
      const operation = operations.get(request.params.id);
      if (!operation) {
        return reply.status(404).send({ error: "Operation not found" });
      }

      const parsed = ReorderStepsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
      }
      const { stepIds } = parsed.data;

      // Validate all step IDs exist
      const stepMap = new Map(operation.steps.map((s) => [s.id, s]));
      for (const sid of stepIds) {
        if (!stepMap.has(sid)) {
          return reply.status(400).send({ error: `Step not found: ${sid}` });
        }
      }

      const updated = operations.reorderSteps(request.params.id, stepIds);

      return { steps: updated.steps };
    },
  );

  // Delete step
  app.delete<{ Params: { id: string; stepId: string } }>(
    "/api/operations/:id/steps/:stepId",
    async (request, reply) => {
      try {
        operations.removeStep(request.params.id, request.params.stepId);
        return { deleted: true };
      } catch {
        return reply.status(404).send({ error: "Operation or step not found" });
      }
    },
  );

  // --- Deployment configuration ---

  // Get deploy config
  app.get<{ Params: { id: string } }>(
    "/api/operations/:id/deploy-config",
    async (request, reply) => {
      const operation = operations.get(request.params.id);
      if (!operation) {
        return reply.status(404).send({ error: "Operation not found" });
      }
      return { deployConfig: operation.deployConfig };
    },
  );

  // Update deploy config
  app.put<{ Params: { id: string } }>(
    "/api/operations/:id/deploy-config",
    async (request, reply) => {
      const parsed = UpdateDeployConfigSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid input", details: parsed.error.format() });
      }

      try {
        const operation = operations.updateDeployConfig(request.params.id, parsed.data);
        return { deployConfig: operation.deployConfig };
      } catch {
        return reply.status(404).send({ error: "Operation not found" });
      }
    },
  );
}
