import crypto from "node:crypto";
import type { Project, ProjectId, EnvironmentId } from "./types.js";

/**
 * In-memory project store. Same pattern as TenantStore —
 * interface designed for later migration to persistent storage.
 */
export class ProjectStore {
  private projects: Map<ProjectId, Project> = new Map();

  create(name: string, environmentIds: EnvironmentId[] = []): Project {
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      environmentIds,
    };
    this.projects.set(project.id, project);
    return project;
  }

  get(id: ProjectId): Project | undefined {
    return this.projects.get(id);
  }

  list(): Project[] {
    return [...this.projects.values()];
  }

  addEnvironment(id: ProjectId, environmentId: EnvironmentId): Project {
    const project = this.projects.get(id);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    if (!project.environmentIds.includes(environmentId)) {
      project.environmentIds.push(environmentId);
    }
    return project;
  }
}
