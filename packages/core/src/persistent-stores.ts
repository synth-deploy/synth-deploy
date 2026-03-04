import crypto from "node:crypto";
import Database from "better-sqlite3";
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
  ArtifactVersionId,
  ArtifactAnalysis,
  LearningHistoryEntry,
  SecurityBoundary,
  SecurityBoundaryType,
  EnvoyId,
} from "./types.js";
import { DEFAULT_APP_SETTINGS } from "./types.js";

// ---------------------------------------------------------------------------
// Schema version — bump when table definitions change
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Safe JSON parse — returns fallback on corruption instead of crashing
// ---------------------------------------------------------------------------

export function safeJsonParse<T>(
  json: string,
  fallback: T,
  context?: { table?: string; rowId?: string; column?: string },
): T {
  try {
    return JSON.parse(json);
  } catch {
    const where = context
      ? ` (table=${context.table}, row=${context.rowId}, column=${context.column})`
      : "";
    console.warn(`[DeployStack] Corrupted JSON skipped${where}: ${json.slice(0, 120)}`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Shared database setup
// ---------------------------------------------------------------------------

export function openEntityDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // --- Integrity check ---
  try {
    const result = db.pragma("integrity_check") as { integrity_check: string }[];
    const status = result[0]?.integrity_check ?? "unknown";
    if (status !== "ok") {
      console.warn(
        `[DeployStack] Database integrity check warning for ${dbPath}: ${status}`,
      );
    }
  } catch (err) {
    console.warn(
      `[DeployStack] Could not run integrity check on ${dbPath}:`,
      err,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS partitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '{}',
      constraints TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS environments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      artifact_version_id TEXT,
      envoy_id TEXT,
      environment_id TEXT NOT NULL,
      partition_id TEXT,
      version TEXT NOT NULL,
      status TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '{}',
      plan TEXT,
      rollback_plan TEXT,
      execution_record TEXT,
      approved_by TEXT,
      approved_at TEXT,
      debrief_entry_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      failure_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deployments_partition ON deployments(partition_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_artifact ON deployments(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      analysis TEXT NOT NULL DEFAULT '{}',
      annotations TEXT NOT NULL DEFAULT '[]',
      learning_history TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifact_versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      version TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact ON artifact_versions(artifact_id);

    CREATE TABLE IF NOT EXISTS envoy_security_boundaries (
      id TEXT PRIMARY KEY,
      envoy_id TEXT NOT NULL,
      boundary_type TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      UNIQUE(envoy_id, boundary_type)
    );
    CREATE INDEX IF NOT EXISTS idx_security_boundaries_envoy ON envoy_security_boundaries(envoy_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // --- Schema version validation ---
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const versionRow = db.prepare(`SELECT version FROM schema_version LIMIT 1`).get() as
    | { version: number }
    | undefined;
  if (!versionRow) {
    db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(SCHEMA_VERSION);
  } else if (versionRow.version !== SCHEMA_VERSION) {
    console.warn(
      `[DeployStack] Schema version mismatch: database has v${versionRow.version}, expected v${SCHEMA_VERSION}`,
    );
  }

  return db;
}

// ---------------------------------------------------------------------------
// PersistentPartitionStore
// ---------------------------------------------------------------------------

export class PersistentPartitionStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    list: Database.Statement;
    updateName: Database.Statement;
    updateVariables: Database.Statement;
    updateConstraints: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO partitions (id, name, variables, constraints, created_at) VALUES (@id, @name, @variables, @constraints, @created_at)`,
      ),
      getById: db.prepare(`SELECT * FROM partitions WHERE id = ?`),
      list: db.prepare(`SELECT * FROM partitions ORDER BY created_at ASC`),
      updateName: db.prepare(`UPDATE partitions SET name = @name WHERE id = @id`),
      updateVariables: db.prepare(`UPDATE partitions SET variables = @variables WHERE id = @id`),
      updateConstraints: db.prepare(`UPDATE partitions SET constraints = @constraints WHERE id = @id`),
      deleteById: db.prepare(`DELETE FROM partitions WHERE id = ?`),
    };
  }

  create(name: string, variables: Record<string, string> = {}): Partition {
    const partition: Partition = {
      id: crypto.randomUUID(),
      name,
      variables,
      createdAt: new Date(),
    };
    this.stmts.insert.run({
      id: partition.id,
      name: partition.name,
      variables: JSON.stringify(partition.variables),
      constraints: null,
      created_at: partition.createdAt.toISOString(),
    });
    return partition;
  }

  get(id: PartitionId): Partition | undefined {
    const row = this.stmts.getById.get(id) as PartitionRow | undefined;
    return row ? rowToPartition(row) : undefined;
  }

  list(): Partition[] {
    const rows = this.stmts.list.all() as PartitionRow[];
    return rows.map(rowToPartition);
  }

  setVariables(id: PartitionId, variables: Record<string, string>): Partition {
    const partition = this.get(id);
    if (!partition) throw new Error(`Partition not found: ${id}`);
    const merged = { ...partition.variables, ...variables };
    this.stmts.updateVariables.run({ variables: JSON.stringify(merged), id });
    return { ...partition, variables: merged };
  }

  update(id: PartitionId, updates: { name?: string; constraints?: Record<string, unknown> }): Partition {
    const partition = this.get(id);
    if (!partition) throw new Error(`Partition not found: ${id}`);
    if (updates.name !== undefined) {
      this.stmts.updateName.run({ name: updates.name, id });
      partition.name = updates.name;
    }
    if (updates.constraints !== undefined) {
      this.stmts.updateConstraints.run({ constraints: JSON.stringify(updates.constraints), id });
      partition.constraints = updates.constraints;
    }
    return partition;
  }

  delete(id: PartitionId): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }
}

interface PartitionRow {
  id: string;
  name: string;
  variables: string;
  constraints: string | null;
  created_at: string;
}

function rowToPartition(row: PartitionRow): Partition {
  const partition: Partition = {
    id: row.id,
    name: row.name,
    variables: safeJsonParse(row.variables, {}, { table: "partitions", rowId: row.id, column: "variables" }),
    createdAt: new Date(row.created_at),
  };
  if (row.constraints) {
    partition.constraints = safeJsonParse(row.constraints, {}, { table: "partitions", rowId: row.id, column: "constraints" });
  }
  return partition;
}

// ---------------------------------------------------------------------------
// PersistentEnvironmentStore
// ---------------------------------------------------------------------------

export class PersistentEnvironmentStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO environments (id, name, variables) VALUES (@id, @name, @variables)`,
      ),
      getById: db.prepare(`SELECT * FROM environments WHERE id = ?`),
      list: db.prepare(`SELECT * FROM environments ORDER BY name ASC`),
      update: db.prepare(
        `UPDATE environments SET name = @name, variables = @variables WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM environments WHERE id = ?`),
    };
  }

  create(name: string, variables: Record<string, string> = {}): Environment {
    const env: Environment = { id: crypto.randomUUID(), name, variables };
    this.stmts.insert.run({
      id: env.id,
      name: env.name,
      variables: JSON.stringify(env.variables),
    });
    return env;
  }

  get(id: EnvironmentId): Environment | undefined {
    const row = this.stmts.getById.get(id) as EnvironmentRow | undefined;
    return row ? rowToEnvironment(row) : undefined;
  }

  list(): Environment[] {
    const rows = this.stmts.list.all() as EnvironmentRow[];
    return rows.map(rowToEnvironment);
  }

  update(
    id: EnvironmentId,
    updates: { name?: string; variables?: Record<string, string> },
  ): Environment {
    const env = this.get(id);
    if (!env) throw new Error(`Environment not found: ${id}`);
    const newName = updates.name ?? env.name;
    const newVars = updates.variables
      ? { ...env.variables, ...updates.variables }
      : env.variables;
    this.stmts.update.run({
      id,
      name: newName,
      variables: JSON.stringify(newVars),
    });
    return { id, name: newName, variables: newVars };
  }

  delete(id: EnvironmentId): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }
}

interface EnvironmentRow {
  id: string;
  name: string;
  variables: string;
}

function rowToEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    name: row.name,
    variables: safeJsonParse(row.variables, {}, { table: "environments", rowId: row.id, column: "variables" }),
  };
}

// ---------------------------------------------------------------------------
// PersistentDeploymentStore
// ---------------------------------------------------------------------------

export class PersistentDeploymentStore {
  private stmts: {
    upsert: Database.Statement;
    getById: Database.Statement;
    getByPartition: Database.Statement;
    getByArtifact: Database.Statement;
    list: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT INTO deployments (id, artifact_id, artifact_version_id, envoy_id, environment_id, partition_id, version, status, variables, plan, rollback_plan, execution_record, approved_by, approved_at, debrief_entry_ids, created_at, completed_at, failure_reason)
         VALUES (@id, @artifact_id, @artifact_version_id, @envoy_id, @environment_id, @partition_id, @version, @status, @variables, @plan, @rollback_plan, @execution_record, @approved_by, @approved_at, @debrief_entry_ids, @created_at, @completed_at, @failure_reason)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           variables = excluded.variables,
           plan = excluded.plan,
           rollback_plan = excluded.rollback_plan,
           execution_record = excluded.execution_record,
           approved_by = excluded.approved_by,
           approved_at = excluded.approved_at,
           debrief_entry_ids = excluded.debrief_entry_ids,
           completed_at = excluded.completed_at,
           failure_reason = excluded.failure_reason`,
      ),
      getById: db.prepare(`SELECT * FROM deployments WHERE id = ?`),
      getByPartition: db.prepare(
        `SELECT * FROM deployments WHERE partition_id = ? ORDER BY created_at ASC`,
      ),
      getByArtifact: db.prepare(
        `SELECT * FROM deployments WHERE artifact_id = ? ORDER BY created_at ASC`,
      ),
      list: db.prepare(`SELECT * FROM deployments ORDER BY created_at ASC`),
    };
  }

  save(deployment: Deployment): void {
    this.stmts.upsert.run({
      id: deployment.id,
      artifact_id: deployment.artifactId,
      artifact_version_id: deployment.artifactVersionId ?? null,
      envoy_id: deployment.envoyId ?? null,
      environment_id: deployment.environmentId,
      partition_id: deployment.partitionId ?? null,
      version: deployment.version,
      status: deployment.status,
      variables: JSON.stringify(deployment.variables),
      plan: deployment.plan ? JSON.stringify(deployment.plan) : null,
      rollback_plan: deployment.rollbackPlan ? JSON.stringify(deployment.rollbackPlan) : null,
      execution_record: deployment.executionRecord ? JSON.stringify(deployment.executionRecord) : null,
      approved_by: deployment.approvedBy ?? null,
      approved_at: deployment.approvedAt?.toISOString() ?? null,
      debrief_entry_ids: JSON.stringify(deployment.debriefEntryIds),
      created_at: deployment.createdAt.toISOString(),
      completed_at: deployment.completedAt?.toISOString() ?? null,
      failure_reason: deployment.failureReason ?? null,
    });
  }

  get(id: DeploymentId): Deployment | undefined {
    const row = this.stmts.getById.get(id) as DeploymentRow | undefined;
    return row ? rowToDeployment(row) : undefined;
  }

  getByPartition(partitionId: PartitionId): Deployment[] {
    const rows = this.stmts.getByPartition.all(partitionId) as DeploymentRow[];
    return rows.map(rowToDeployment);
  }

  getByArtifact(artifactId: string): Deployment[] {
    const rows = this.stmts.getByArtifact.all(artifactId) as DeploymentRow[];
    return rows.map(rowToDeployment);
  }

  list(): Deployment[] {
    const rows = this.stmts.list.all() as DeploymentRow[];
    return rows.map(rowToDeployment);
  }
}

interface DeploymentRow {
  id: string;
  artifact_id: string;
  artifact_version_id: string | null;
  envoy_id: string | null;
  environment_id: string;
  partition_id: string | null;
  version: string;
  status: string;
  variables: string;
  plan: string | null;
  rollback_plan: string | null;
  execution_record: string | null;
  approved_by: string | null;
  approved_at: string | null;
  debrief_entry_ids: string;
  created_at: string;
  completed_at: string | null;
  failure_reason: string | null;
}

function rowToDeployment(row: DeploymentRow): Deployment {
  const deployment: Deployment = {
    id: row.id,
    artifactId: row.artifact_id,
    environmentId: row.environment_id,
    version: row.version,
    status: row.status as Deployment["status"],
    variables: safeJsonParse(row.variables, {}, { table: "deployments", rowId: row.id, column: "variables" }),
    debriefEntryIds: safeJsonParse(row.debrief_entry_ids, [], { table: "deployments", rowId: row.id, column: "debrief_entry_ids" }),
    createdAt: new Date(row.created_at),
  };
  if (row.artifact_version_id) deployment.artifactVersionId = row.artifact_version_id;
  if (row.envoy_id) deployment.envoyId = row.envoy_id;
  if (row.partition_id) deployment.partitionId = row.partition_id;
  if (row.plan) deployment.plan = safeJsonParse(row.plan, undefined, { table: "deployments", rowId: row.id, column: "plan" });
  if (row.rollback_plan) deployment.rollbackPlan = safeJsonParse(row.rollback_plan, undefined, { table: "deployments", rowId: row.id, column: "rollback_plan" });
  if (row.execution_record) deployment.executionRecord = safeJsonParse(row.execution_record, undefined, { table: "deployments", rowId: row.id, column: "execution_record" });
  if (row.approved_by) deployment.approvedBy = row.approved_by;
  if (row.approved_at) deployment.approvedAt = new Date(row.approved_at);
  if (row.completed_at) deployment.completedAt = new Date(row.completed_at);
  if (row.failure_reason) deployment.failureReason = row.failure_reason;
  return deployment;
}

// ---------------------------------------------------------------------------
// PersistentSettingsStore
// ---------------------------------------------------------------------------

export class PersistentSettingsStore {
  private stmts: {
    get: Database.Statement;
    upsert: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      get: db.prepare(`SELECT value FROM settings WHERE key = ?`),
      upsert: db.prepare(
        `INSERT INTO settings (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ),
    };

    // Seed defaults if no settings row exists
    const existing = this.stmts.get.get("app") as { value: string } | undefined;
    if (!existing) {
      this.stmts.upsert.run({
        key: "app",
        value: JSON.stringify(DEFAULT_APP_SETTINGS),
      });
    }
  }

  get(): AppSettings {
    const row = this.stmts.get.get("app") as { value: string } | undefined;
    return row
      ? safeJsonParse(row.value, structuredClone(DEFAULT_APP_SETTINGS), { table: "settings", rowId: "app", column: "value" })
      : structuredClone(DEFAULT_APP_SETTINGS);
  }

  update(partial: Partial<AppSettings>): AppSettings {
    const current = this.get();
    if (partial.environmentsEnabled !== undefined) {
      current.environmentsEnabled = partial.environmentsEnabled;
    }
    if (partial.agent) {
      current.agent = { ...current.agent, ...partial.agent };
    }
    if (partial.deploymentDefaults) {
      current.deploymentDefaults = {
        ...current.deploymentDefaults,
        ...partial.deploymentDefaults,
      };
    }
    if (partial.envoy) {
      current.envoy = { ...current.envoy, ...partial.envoy };
    }
    if ("coBranding" in partial) {
      current.coBranding = partial.coBranding ?? undefined;
    }
    if (partial.mcpServers !== undefined) {
      current.mcpServers = partial.mcpServers;
    }
    if (partial.llm !== undefined) {
      current.llm = partial.llm;
    }
    this.stmts.upsert.run({ key: "app", value: JSON.stringify(current) });
    return structuredClone(current);
  }
}

// ---------------------------------------------------------------------------
// PersistentArtifactStore
// ---------------------------------------------------------------------------

export class PersistentArtifactStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    deleteById: Database.Statement;
    insertVersion: Database.Statement;
    getVersions: Database.Statement;
    deleteVersions: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO artifacts (id, name, type, analysis, annotations, learning_history, created_at, updated_at)
         VALUES (@id, @name, @type, @analysis, @annotations, @learning_history, @created_at, @updated_at)`,
      ),
      getById: db.prepare(`SELECT * FROM artifacts WHERE id = ?`),
      list: db.prepare(`SELECT * FROM artifacts ORDER BY created_at ASC`),
      update: db.prepare(
        `UPDATE artifacts SET name = @name, type = @type, analysis = @analysis, annotations = @annotations, learning_history = @learning_history, updated_at = @updated_at WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM artifacts WHERE id = ?`),
      insertVersion: db.prepare(
        `INSERT INTO artifact_versions (id, artifact_id, version, source, metadata, created_at)
         VALUES (@id, @artifact_id, @version, @source, @metadata, @created_at)`,
      ),
      getVersions: db.prepare(
        `SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY created_at ASC`,
      ),
      deleteVersions: db.prepare(`DELETE FROM artifact_versions WHERE artifact_id = ?`),
    };
  }

  create(input: Omit<Artifact, "id" | "createdAt" | "updatedAt">): Artifact {
    const now = new Date();
    const artifact: Artifact = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.stmts.insert.run({
      id: artifact.id,
      name: artifact.name,
      type: artifact.type,
      analysis: JSON.stringify(artifact.analysis),
      annotations: JSON.stringify(serializeAnnotations(artifact.annotations)),
      learning_history: JSON.stringify(serializeLearningHistory(artifact.learningHistory)),
      created_at: artifact.createdAt.toISOString(),
      updated_at: artifact.updatedAt.toISOString(),
    });
    return artifact;
  }

  get(id: ArtifactId): Artifact | undefined {
    const row = this.stmts.getById.get(id) as ArtifactRow | undefined;
    return row ? rowToArtifact(row) : undefined;
  }

  list(): Artifact[] {
    const rows = this.stmts.list.all() as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  update(id: ArtifactId, updates: Partial<Artifact>): Artifact {
    const artifact = this.get(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    if (updates.name !== undefined) artifact.name = updates.name;
    if (updates.type !== undefined) artifact.type = updates.type;
    if (updates.analysis !== undefined) artifact.analysis = updates.analysis;
    if (updates.annotations !== undefined) artifact.annotations = updates.annotations;
    if (updates.learningHistory !== undefined) artifact.learningHistory = updates.learningHistory;
    artifact.updatedAt = new Date();
    this.stmts.update.run({
      id,
      name: artifact.name,
      type: artifact.type,
      analysis: JSON.stringify(artifact.analysis),
      annotations: JSON.stringify(serializeAnnotations(artifact.annotations)),
      learning_history: JSON.stringify(serializeLearningHistory(artifact.learningHistory)),
      updated_at: artifact.updatedAt.toISOString(),
    });
    return artifact;
  }

  addAnnotation(id: ArtifactId, annotation: ArtifactAnnotation): Artifact {
    const artifact = this.get(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    artifact.annotations.push(annotation);
    artifact.updatedAt = new Date();
    this.stmts.update.run({
      id,
      name: artifact.name,
      type: artifact.type,
      analysis: JSON.stringify(artifact.analysis),
      annotations: JSON.stringify(serializeAnnotations(artifact.annotations)),
      learning_history: JSON.stringify(serializeLearningHistory(artifact.learningHistory)),
      updated_at: artifact.updatedAt.toISOString(),
    });
    return artifact;
  }

  addVersion(input: Omit<ArtifactVersion, "id" | "createdAt">): ArtifactVersion {
    const version: ArtifactVersion = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: new Date(),
    };
    this.stmts.insertVersion.run({
      id: version.id,
      artifact_id: version.artifactId,
      version: version.version,
      source: version.source,
      metadata: JSON.stringify(version.metadata),
      created_at: version.createdAt.toISOString(),
    });
    return version;
  }

  getVersions(artifactId: ArtifactId): ArtifactVersion[] {
    const rows = this.stmts.getVersions.all(artifactId) as ArtifactVersionRow[];
    return rows.map(rowToArtifactVersion);
  }

  delete(id: ArtifactId): void {
    this.stmts.deleteVersions.run(id);
    this.stmts.deleteById.run(id);
  }
}

interface ArtifactRow {
  id: string;
  name: string;
  type: string;
  analysis: string;
  annotations: string;
  learning_history: string;
  created_at: string;
  updated_at: string;
}

interface ArtifactVersionRow {
  id: string;
  artifact_id: string;
  version: string;
  source: string;
  metadata: string;
  created_at: string;
}

function serializeAnnotations(annotations: ArtifactAnnotation[]): unknown[] {
  return annotations.map((a) => ({
    ...a,
    annotatedAt: a.annotatedAt instanceof Date ? a.annotatedAt.toISOString() : a.annotatedAt,
  }));
}

function serializeLearningHistory(history: LearningHistoryEntry[]): unknown[] {
  return history.map((h) => ({
    ...h,
    timestamp: h.timestamp instanceof Date ? h.timestamp.toISOString() : h.timestamp,
  }));
}

function rowToArtifact(row: ArtifactRow): Artifact {
  const rawAnnotations = safeJsonParse<Array<Record<string, unknown>>>(
    row.annotations, [], { table: "artifacts", rowId: row.id, column: "annotations" },
  );
  const annotations: ArtifactAnnotation[] = rawAnnotations.map((a) => ({
    field: a.field as string,
    correction: a.correction as string,
    annotatedBy: a.annotatedBy as string,
    annotatedAt: new Date(a.annotatedAt as string),
  }));

  const rawHistory = safeJsonParse<Array<Record<string, unknown>>>(
    row.learning_history, [], { table: "artifacts", rowId: row.id, column: "learning_history" },
  );
  const learningHistory: LearningHistoryEntry[] = rawHistory.map((h) => ({
    timestamp: new Date(h.timestamp as string),
    event: h.event as string,
    details: h.details as string,
  }));

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    analysis: safeJsonParse<ArtifactAnalysis>(
      row.analysis,
      { summary: "", dependencies: [], configurationExpectations: {}, confidence: 0 },
      { table: "artifacts", rowId: row.id, column: "analysis" },
    ),
    annotations,
    learningHistory,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function rowToArtifactVersion(row: ArtifactVersionRow): ArtifactVersion {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    version: row.version,
    source: row.source,
    metadata: safeJsonParse(row.metadata, {}, { table: "artifact_versions", rowId: row.id, column: "metadata" }),
    createdAt: new Date(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// PersistentSecurityBoundaryStore
// ---------------------------------------------------------------------------

export class PersistentSecurityBoundaryStore {
  private stmts: {
    upsert: Database.Statement;
    getByEnvoy: Database.Statement;
    deleteByEnvoy: Database.Statement;
    deleteByEnvoyAndType: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT INTO envoy_security_boundaries (id, envoy_id, boundary_type, config)
         VALUES (@id, @envoy_id, @boundary_type, @config)
         ON CONFLICT(envoy_id, boundary_type) DO UPDATE SET
           config = excluded.config`,
      ),
      getByEnvoy: db.prepare(
        `SELECT * FROM envoy_security_boundaries WHERE envoy_id = ? ORDER BY boundary_type ASC`,
      ),
      deleteByEnvoy: db.prepare(`DELETE FROM envoy_security_boundaries WHERE envoy_id = ?`),
      deleteByEnvoyAndType: db.prepare(
        `DELETE FROM envoy_security_boundaries WHERE envoy_id = ? AND boundary_type = ?`,
      ),
    };
  }

  set(envoyId: EnvoyId, boundaries: SecurityBoundary[]): void {
    const txn = this.db.transaction(() => {
      this.stmts.deleteByEnvoy.run(envoyId);
      for (const b of boundaries) {
        this.stmts.upsert.run({
          id: b.id ?? crypto.randomUUID(),
          envoy_id: envoyId,
          boundary_type: b.boundaryType,
          config: JSON.stringify(b.config),
        });
      }
    });
    txn();
  }

  get(envoyId: EnvoyId): SecurityBoundary[] {
    const rows = this.stmts.getByEnvoy.all(envoyId) as SecurityBoundaryRow[];
    return rows.map(rowToSecurityBoundary);
  }

  delete(envoyId: EnvoyId): void {
    this.stmts.deleteByEnvoy.run(envoyId);
  }
}

interface SecurityBoundaryRow {
  id: string;
  envoy_id: string;
  boundary_type: string;
  config: string;
}

function rowToSecurityBoundary(row: SecurityBoundaryRow): SecurityBoundary {
  return {
    id: row.id,
    envoyId: row.envoy_id,
    boundaryType: row.boundary_type as SecurityBoundaryType,
    config: safeJsonParse(row.config, {}, { table: "envoy_security_boundaries", rowId: row.id, column: "config" }),
  };
}
