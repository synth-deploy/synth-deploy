/**
 * Store interfaces — consumed by route handlers, MCP tools, and agents.
 * Both in-memory and persistent implementations satisfy these interfaces.
 */

import type {
  Partition,
  PartitionId,
  Environment,
  EnvironmentId,
  Deployment,
  DeploymentId,
  AppSettings,
  Artifact,
  ArtifactId,
  ArtifactAnnotation,
  ArtifactVersion,
  SecurityBoundary,
  EnvoyId,
  User,
  UserId,
  Role,
  RoleId,
  Permission,
  UserRole,
  Session,
} from "./types.js";

export interface IPartitionStore {
  create(name: string, variables?: Record<string, string>): Partition;
  get(id: PartitionId): Partition | undefined;
  list(): Partition[];
  setVariables(id: PartitionId, variables: Record<string, string>): Partition;
  update(id: PartitionId, updates: { name?: string; constraints?: Record<string, unknown> }): Partition;
  delete(id: PartitionId): boolean;
}

export interface IEnvironmentStore {
  create(name: string, variables?: Record<string, string>): Environment;
  get(id: EnvironmentId): Environment | undefined;
  list(): Environment[];
  update(
    id: EnvironmentId,
    updates: { name?: string; variables?: Record<string, string> },
  ): Environment;
  delete(id: EnvironmentId): boolean;
}

export interface IArtifactStore {
  create(artifact: Omit<Artifact, "id" | "createdAt" | "updatedAt">): Artifact;
  get(id: ArtifactId): Artifact | undefined;
  list(): Artifact[];
  update(id: ArtifactId, updates: Partial<Artifact>): Artifact;
  addAnnotation(id: ArtifactId, annotation: ArtifactAnnotation): Artifact;
  addVersion(version: Omit<ArtifactVersion, "id" | "createdAt">): ArtifactVersion;
  getVersions(artifactId: ArtifactId): ArtifactVersion[];
  delete(id: ArtifactId): void;
}

export interface ISecurityBoundaryStore {
  set(envoyId: EnvoyId, boundaries: SecurityBoundary[]): void;
  get(envoyId: EnvoyId): SecurityBoundary[];
  delete(envoyId: EnvoyId): void;
}

export interface IDeploymentStore {
  save(deployment: Deployment): void;
  get(id: DeploymentId): Deployment | undefined;
  getByPartition(partitionId: PartitionId): Deployment[];
  getByArtifact(artifactId: string): Deployment[];
  list(): Deployment[];
}

export interface ISettingsStore {
  get(): AppSettings;
  update(partial: Partial<AppSettings>): AppSettings;
}

// --- Auth store interfaces ---

export interface IUserStore {
  create(user: User): User;
  getById(id: UserId): User | undefined;
  getByEmail(email: string): User | undefined;
  list(): User[];
  update(id: UserId, updates: Partial<Pick<User, "email" | "name" | "passwordHash" | "updatedAt">>): User;
  delete(id: UserId): void;
  count(): number;
}

export interface IRoleStore {
  create(role: Role): Role;
  getById(id: RoleId): Role | undefined;
  getByName(name: string): Role | undefined;
  list(): Role[];
  update(id: RoleId, updates: Partial<Pick<Role, "name" | "permissions">>): Role;
  delete(id: RoleId): void;
}

export interface IUserRoleStore {
  assign(userId: UserId, roleId: RoleId, assignedBy: UserId): UserRole;
  getUserRoles(userId: UserId): Role[];
  getUserPermissions(userId: UserId): Permission[];
  removeRole(userId: UserId, roleId: RoleId): void;
  setRoles(userId: UserId, roleIds: RoleId[], assignedBy: UserId): void;
}

export interface ISessionStore {
  create(session: Session): Session;
  getByToken(token: string): Session | undefined;
  getByRefreshToken(refreshToken: string): Session | undefined;
  deleteByToken(token: string): void;
  deleteByUserId(userId: UserId): void;
  deleteExpired(): void;
}
