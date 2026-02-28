import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ProjectStore, EnvironmentStore, DeploymentStep, DeploymentStepType, DeployConfig } from "@deploystack/core";

export function registerProjectRoutes(
  app: FastifyInstance,
  projects: ProjectStore,
  environments: EnvironmentStore,
): void {
  // Create a project
  app.post("/api/projects", async (request, reply) => {
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

    const project = projects.create(name.trim(), envIds);
    return reply.status(201).send({ project });
  });

  // List all projects
  app.get("/api/projects", async () => {
    return { projects: projects.list() };
  });

  // Get project by ID
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = projects.get(request.params.id);
    if (!project) {
      return reply.status(404).send({ error: "Project not found" });
    }

    // Resolve environment names for display
    const envDetails = project.environmentIds
      .map((eid) => environments.get(eid))
      .filter(Boolean);

    return { project, environments: envDetails };
  });

  // Update project
  app.put<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const { name } = request.body as { name?: string };

    try {
      const project = projects.update(request.params.id, {
        name: name?.trim(),
      });
      return { project };
    } catch {
      return reply.status(404).send({ error: "Project not found" });
    }
  });

  // Delete project
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = projects.get(request.params.id);
    if (!project) {
      return reply.status(404).send({ error: "Project not found" });
    }
    projects.delete(request.params.id);
    return { deleted: true };
  });

  // --- Environment links ---

  // Add environment to project
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/environments",
    async (request, reply) => {
      const { environmentId } = request.body as { environmentId?: string };

      if (!environmentId) {
        return reply.status(400).send({ error: "environmentId is required" });
      }

      if (!environments.get(environmentId)) {
        return reply.status(404).send({ error: `Environment not found: ${environmentId}` });
      }

      try {
        const project = projects.addEnvironment(request.params.id, environmentId);
        return { project };
      } catch {
        return reply.status(404).send({ error: "Project not found" });
      }
    },
  );

  // Remove environment from project
  app.delete<{ Params: { id: string; envId: string } }>(
    "/api/projects/:id/environments/:envId",
    async (request, reply) => {
      try {
        const project = projects.removeEnvironment(
          request.params.id,
          request.params.envId,
        );
        return { project };
      } catch {
        return reply.status(404).send({ error: "Project not found" });
      }
    },
  );

  // --- Deployment steps ---

  // List steps
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/steps",
    async (request, reply) => {
      const project = projects.get(request.params.id);
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }
      return { steps: project.steps };
    },
  );

  // Create step
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/steps",
    async (request, reply) => {
      const project = projects.get(request.params.id);
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
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
        order: order ?? project.steps.length,
      };

      project.steps.push(step);
      project.steps.sort((a, b) => a.order - b.order);

      return reply.status(201).send({ step });
    },
  );

  // Update step
  app.put<{ Params: { id: string; stepId: string } }>(
    "/api/projects/:id/steps/:stepId",
    async (request, reply) => {
      const project = projects.get(request.params.id);
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const step = project.steps.find((s) => s.id === request.params.stepId);
      if (!step) {
        return reply.status(404).send({ error: "Step not found" });
      }

      const { name, type, command, order } = request.body as {
        name?: string;
        type?: DeploymentStepType;
        command?: string;
        order?: number;
      };

      if (name !== undefined) step.name = name.trim();
      if (type !== undefined) step.type = type;
      if (command !== undefined) step.command = command.trim();
      if (order !== undefined) step.order = order;

      project.steps.sort((a, b) => a.order - b.order);

      return { step };
    },
  );

  // Reorder steps
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/steps/reorder",
    async (request, reply) => {
      const project = projects.get(request.params.id);
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const { stepIds } = request.body as { stepIds?: string[] };
      if (!stepIds || !Array.isArray(stepIds)) {
        return reply.status(400).send({ error: "stepIds array is required" });
      }

      // Validate all step IDs exist
      const stepMap = new Map(project.steps.map((s) => [s.id, s]));
      for (const sid of stepIds) {
        if (!stepMap.has(sid)) {
          return reply.status(400).send({ error: `Step not found: ${sid}` });
        }
      }

      // Renumber steps 0..N-1 in the provided order
      for (let i = 0; i < stepIds.length; i++) {
        stepMap.get(stepIds[i])!.order = i;
      }
      project.steps.sort((a, b) => a.order - b.order);

      return { steps: project.steps };
    },
  );

  // Delete step
  app.delete<{ Params: { id: string; stepId: string } }>(
    "/api/projects/:id/steps/:stepId",
    async (request, reply) => {
      const project = projects.get(request.params.id);
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const idx = project.steps.findIndex((s) => s.id === request.params.stepId);
      if (idx === -1) {
        return reply.status(404).send({ error: "Step not found" });
      }

      project.steps.splice(idx, 1);
      return { deleted: true };
    },
  );

  // --- Deployment configuration ---

  // Get deploy config
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/deploy-config",
    async (request, reply) => {
      const project = projects.get(request.params.id);
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }
      return { deployConfig: project.deployConfig };
    },
  );

  // Update deploy config
  app.put<{ Params: { id: string } }>(
    "/api/projects/:id/deploy-config",
    async (request, reply) => {
      const project = projects.get(request.params.id);
      if (!project) {
        return reply.status(404).send({ error: "Project not found" });
      }

      const updates = request.body as Partial<DeployConfig>;
      project.deployConfig = { ...project.deployConfig, ...updates };

      return { deployConfig: project.deployConfig };
    },
  );
}
