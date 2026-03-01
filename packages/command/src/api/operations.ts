import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { IOperationStore, IEnvironmentStore, DeploymentStep, DeploymentStepType, DeployConfig } from "@deploystack/core";

export function registerOperationRoutes(
  app: FastifyInstance,
  operations: IOperationStore,
  environments: IEnvironmentStore,
): void {
  // Create an operation
  app.post("/api/operations", async (request, reply) => {
    const { name, environmentIds } = request.body as {
      name?: string;
      environmentIds?: string[];
    };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.status(400).send({ error: "name is required" });
    }

    // Validate environment IDs if provided
    const envIds = environmentIds ?? [];
    for (const envId of envIds) {
      if (!environments.get(envId)) {
        return reply.status(404).send({ error: `Environment not found: ${envId}` });
      }
    }

    const operation = operations.create(name.trim(), envIds);
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
    const { name } = request.body as { name?: string };

    try {
      const operation = operations.update(request.params.id, {
        name: name?.trim(),
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
      const { environmentId } = request.body as { environmentId?: string };

      if (!environmentId) {
        return reply.status(400).send({ error: "environmentId is required" });
      }

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

      const { name, type, command, order } = request.body as {
        name?: string;
        type?: DeploymentStepType;
        command?: string;
        order?: number;
      };

      if (!name || !type || !command) {
        return reply
          .status(400)
          .send({ error: "name, type, and command are required" });
      }

      const validTypes: DeploymentStepType[] = ["pre-deploy", "post-deploy", "verification"];
      if (!validTypes.includes(type)) {
        return reply
          .status(400)
          .send({ error: `type must be one of: ${validTypes.join(", ")}` });
      }

      const step: DeploymentStep = {
        id: crypto.randomUUID(),
        name: name.trim(),
        type,
        command: command.trim(),
        order: order ?? operation.steps.length,
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

      const { name, type, command, order } = request.body as {
        name?: string;
        type?: DeploymentStepType;
        command?: string;
        order?: number;
      };

      const updates: { name?: string; type?: DeploymentStepType; command?: string; order?: number } = {};
      if (name !== undefined) updates.name = name.trim();
      if (type !== undefined) updates.type = type;
      if (command !== undefined) updates.command = command.trim();
      if (order !== undefined) updates.order = order;

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

      const { stepIds } = request.body as { stepIds?: string[] };
      if (!stepIds || !Array.isArray(stepIds)) {
        return reply.status(400).send({ error: "stepIds array is required" });
      }

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
      try {
        const updates = request.body as Partial<DeployConfig>;
        const operation = operations.updateDeployConfig(request.params.id, updates);
        return { deployConfig: operation.deployConfig };
      } catch {
        return reply.status(404).send({ error: "Operation not found" });
      }
    },
  );
}
