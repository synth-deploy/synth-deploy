import crypto from "node:crypto";
import type { Project, ProjectId, EnvironmentId } from "./types.js";
import { DEFAULT_PIPELINE_CONFIG } from "./types.js";

/**
 * In-memory project store. Same pattern as PartitionStore —
 * interface designed for later migration to persistent storage.
 */
export class ProjectStore {
  private projects: Map<ProjectId, Project> = new Map();

  create(name: string, environmentIds: EnvironmentId[] = []): Project {
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      environmentIds,
      steps: [],
      pipelineConfig: { ...DEFAULT_PIPELINE_CONFIG },
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

  update(id: ProjectId, updates: { name?: string }): Project {
    const project = this.projects.get(id);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    if (updates.name !== undefined) {
      project.name = updates.name;
    }
    return project;
  }

  delete(id: ProjectId): boolean {
    return this.projects.delete(id);
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

  removeEnvironment(id: ProjectId, environmentId: EnvironmentId): Project {
    const project = this.projects.get(id);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    project.environmentIds = project.environmentIds.filter(
      (eid) => eid !== environmentId,
    );
    return project;
  }
}
