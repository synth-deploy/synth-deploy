import type { FastifyInstance } from "fastify";
import type { ProjectStore } from "@deploystack/core";

interface EnvironmentStore {
  get(id: string): { id: string; name: string; variables: Record<string, string> } | undefined;
}

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
}
