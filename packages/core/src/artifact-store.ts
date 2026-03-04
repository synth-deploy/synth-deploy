import crypto from "node:crypto";
import type {
  Artifact,
  ArtifactId,
  ArtifactAnnotation,
  ArtifactVersion,
  ArtifactVersionId,
} from "./types.js";

/**
 * In-memory artifact store. Supports versions, annotations, and learning history.
 * Interface designed for later migration to persistent storage.
 */
export class ArtifactStore {
  private artifacts: Map<ArtifactId, Artifact> = new Map();
  private versions: Map<ArtifactVersionId, ArtifactVersion> = new Map();

  create(input: Omit<Artifact, "id" | "createdAt" | "updatedAt">): Artifact {
    const now = new Date();
    const artifact: Artifact = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.set(artifact.id, artifact);
    return structuredClone(artifact);
  }

  get(id: ArtifactId): Artifact | undefined {
    const artifact = this.artifacts.get(id);
    return artifact ? structuredClone(artifact) : undefined;
  }

  list(): Artifact[] {
    return [...this.artifacts.values()].map((a) => structuredClone(a));
  }

  update(id: ArtifactId, updates: Partial<Artifact>): Artifact {
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    if (updates.name !== undefined) artifact.name = updates.name;
    if (updates.type !== undefined) artifact.type = updates.type;
    if (updates.analysis !== undefined) artifact.analysis = updates.analysis;
    if (updates.annotations !== undefined) artifact.annotations = updates.annotations;
    if (updates.learningHistory !== undefined) artifact.learningHistory = updates.learningHistory;
    artifact.updatedAt = new Date();
    return structuredClone(artifact);
  }

  addAnnotation(id: ArtifactId, annotation: ArtifactAnnotation): Artifact {
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    artifact.annotations.push(annotation);
    artifact.updatedAt = new Date();
    return structuredClone(artifact);
  }

  addVersion(input: Omit<ArtifactVersion, "id" | "createdAt">): ArtifactVersion {
    const version: ArtifactVersion = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: new Date(),
    };
    this.versions.set(version.id, version);
    return structuredClone(version);
  }

  getVersions(artifactId: ArtifactId): ArtifactVersion[] {
    return [...this.versions.values()]
      .filter((v) => v.artifactId === artifactId)
      .map((v) => structuredClone(v));
  }

  delete(id: ArtifactId): void {
    this.artifacts.delete(id);
    // Remove associated versions
    for (const [vId, v] of this.versions) {
      if (v.artifactId === id) {
        this.versions.delete(vId);
      }
    }
  }
}
