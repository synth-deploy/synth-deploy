import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  Partition,
  PartitionId,
  Environment,
  EnvironmentId,
  Operation,
  OperationId,
  OperationInput,
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
  TelemetryEvent,
  TelemetryAction,
  User,
  UserId,
  Role,
  RoleId,
  Permission,
  UserRole,
  Session,
  IdpProvider,
  RoleMappingRule,
  ApiKey,
  ApiKeyId,
  IntakeChannel,
  IntakeChannelType,
  IntakeEvent,
  AlertWebhookChannel,
  AlertWebhookSource,
  FleetDeployment,
  FleetDeploymentStatus,
  FleetProgress,
  RolloutConfig,
  FleetValidationResult,
} from "./types.js";
import { DEFAULT_APP_SETTINGS } from "./types.js";

// ---------------------------------------------------------------------------
// Schema version — bump when table definitions change
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 9;

// ---------------------------------------------------------------------------
// Safe JSON parse — returns fallback on corruption instead of crashing
// ---------------------------------------------------------------------------

export function safeJsonParse<T>(
  json: string | null | undefined,
  fallback: T,
  context?: { table?: string; rowId?: string; column?: string },
): T {
  if (json == null) return fallback;
  try {
    const parsed = JSON.parse(json);
    if (parsed == null) return fallback;
    return parsed;
  } catch {
    const where = context
      ? ` (table=${context.table}, row=${context.rowId}, column=${context.column})`
      : "";
    console.warn(`[Synth] Corrupted JSON skipped${where}: ${String(json).slice(0, 120)}`);
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
        `[Synth] Database integrity check warning for ${dbPath}: ${status}`,
      );
    }
  } catch (err) {
    console.warn(
      `[Synth] Could not run integrity check on ${dbPath}:`,
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
      operation_type TEXT NOT NULL DEFAULT 'deploy',
      artifact_id TEXT,
      artifact_version_id TEXT,
      input_json TEXT,
      intent TEXT,
      lineage TEXT,
      findings TEXT,
      retry_of TEXT,
      envoy_id TEXT,
      environment_id TEXT,
      partition_id TEXT,
      version TEXT,
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
      failure_reason TEXT,
      shelved_at TEXT,
      shelved_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deployments_partition ON deployments(partition_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_artifact ON deployments(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
  `);

  // Migration: drop NOT NULL on environment_id to support partition/envoy-scoped deployments
  const colInfo = db.prepare(`PRAGMA table_info(deployments)`).all() as Array<{ name: string; notnull: number }>;
  const envCol = colInfo.find((c) => c.name === "environment_id");
  if (envCol?.notnull) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE deployments RENAME TO _deployments_old;
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        artifact_version_id TEXT,
        envoy_id TEXT,
        environment_id TEXT,
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
      INSERT INTO deployments SELECT * FROM _deployments_old;
      DROP TABLE _deployments_old;
      CREATE INDEX IF NOT EXISTS idx_deployments_partition ON deployments(partition_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_artifact ON deployments(artifact_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
      PRAGMA foreign_keys = ON;
    `);
  }

  db.exec(`

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

    CREATE TABLE IF NOT EXISTS telemetry_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_telemetry_actor ON telemetry_events(actor);
    CREATE INDEX IF NOT EXISTS idx_telemetry_action ON telemetry_events(action);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      auth_source TEXT DEFAULT 'local',
      external_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idp_providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_mappings (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      idp_group TEXT NOT NULL,
      synth_role TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_role_mappings_provider ON role_mappings(provider_id);

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      permissions TEXT NOT NULL,
      is_built_in INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      assigned_by TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      refresh_token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      user_agent TEXT,
      ip_address TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_suffix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

    CREATE TABLE IF NOT EXISTS envoy_registrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      token TEXT NOT NULL,
      assigned_environments TEXT NOT NULL DEFAULT '[]',
      assigned_partitions TEXT NOT NULL DEFAULT '[]',
      registered_at TEXT NOT NULL,
      last_health_check TEXT,
      last_health_status TEXT,
      cached_hostname TEXT,
      cached_os TEXT,
      cached_summary TEXT,
      cached_readiness TEXT
    );

    CREATE TABLE IF NOT EXISTS intake_channels (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL DEFAULT '{}',
      auth_token TEXT,
      last_polled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS intake_events (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      artifact_id TEXT,
      status TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_intake_events_channel ON intake_events(channel_id);
    CREATE INDEX IF NOT EXISTS idx_intake_events_created ON intake_events(created_at);

    CREATE TABLE IF NOT EXISTS alert_webhook_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      auth_token TEXT NOT NULL,
      default_operation_type TEXT NOT NULL DEFAULT 'maintain',
      default_intent TEXT,
      environment_id TEXT,
      partition_id TEXT,
      envoy_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registry_poller_versions (
      channel_id TEXT NOT NULL,
      version_key TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, version_key)
    );

    CREATE TABLE IF NOT EXISTS fleet_deployments (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      artifact_version_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      envoy_filter TEXT,
      rollout_config TEXT NOT NULL,
      representative_envoy_ids TEXT NOT NULL DEFAULT '[]',
      representative_plan_id TEXT,
      status TEXT NOT NULL,
      validation_result TEXT,
      progress TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fleet_deployments_status ON fleet_deployments(status);
  `);

  // --- Schema version validation & migrations ---
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const versionRow = db.prepare(`SELECT version FROM schema_version LIMIT 1`).get() as
    | { version: number }
    | undefined;

  // Migrate from v4 to v5: add IdP columns and tables
  if (versionRow && versionRow.version < 5) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN auth_source TEXT DEFAULT 'local'`);
    } catch { /* column may already exist */ }
    try {
      db.exec(`ALTER TABLE users ADD COLUMN external_id TEXT`);
    } catch { /* column may already exist */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS idp_providers (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS role_mappings (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        idp_group TEXT NOT NULL,
        synth_role TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_role_mappings_provider ON role_mappings(provider_id);
    `);
    db.prepare(`UPDATE schema_version SET version = ?`).run(5);
    console.log("[Synth] Migrated database schema from v4 to v5 (IdP support)");
  }

  // Migrate from v5 to v6: add user_agent and ip_address to sessions
  if (versionRow && versionRow.version < 6) {
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN user_agent TEXT`);
    } catch { /* column may already exist */ }
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN ip_address TEXT`);
    } catch { /* column may already exist */ }
    db.prepare(`UPDATE schema_version SET version = ?`).run(6);
    console.log("[Synth] Migrated database schema from v5 to v6 (session UA/IP)");
  }

  // Migrate from v6 to v7: add persistent stores for api_keys, envoy_registrations,
  // intake_channels, intake_events, registry_poller_versions, fleet_deployments
  if (versionRow && versionRow.version < 7) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_suffix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

      CREATE TABLE IF NOT EXISTS envoy_registrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        token TEXT NOT NULL,
        assigned_environments TEXT NOT NULL DEFAULT '[]',
        assigned_partitions TEXT NOT NULL DEFAULT '[]',
        registered_at TEXT NOT NULL,
        last_health_check TEXT,
        last_health_status TEXT,
        cached_hostname TEXT,
        cached_os TEXT,
        cached_summary TEXT,
        cached_readiness TEXT
      );

      CREATE TABLE IF NOT EXISTS intake_channels (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL DEFAULT '{}',
        auth_token TEXT,
        last_polled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS intake_events (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        artifact_id TEXT,
        status TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_intake_events_channel ON intake_events(channel_id);
      CREATE INDEX IF NOT EXISTS idx_intake_events_created ON intake_events(created_at);

      CREATE TABLE IF NOT EXISTS alert_webhook_channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        auth_token TEXT NOT NULL,
        default_operation_type TEXT NOT NULL DEFAULT 'maintain',
        default_intent TEXT,
        environment_id TEXT,
        partition_id TEXT,
        envoy_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS registry_poller_versions (
        channel_id TEXT NOT NULL,
        version_key TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, version_key)
      );

      CREATE TABLE IF NOT EXISTS fleet_deployments (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        artifact_version_id TEXT NOT NULL,
        environment_id TEXT NOT NULL,
        envoy_filter TEXT,
        rollout_config TEXT NOT NULL,
        representative_envoy_ids TEXT NOT NULL DEFAULT '[]',
        representative_plan_id TEXT,
        status TEXT NOT NULL,
        validation_result TEXT,
        progress TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fleet_deployments_status ON fleet_deployments(status);
    `);
    db.prepare(`UPDATE schema_version SET version = ?`).run(7);
    console.log("[Synth] Migrated database schema from v6 to v7 (persistent api_keys, envoy_registrations, intake, fleet)");
  }

  // Migrate from v7 to v8: generalize deployments → operations
  // Adds operation_type, input_json, intent, lineage, findings, retry_of columns;
  // makes artifact_id and version nullable to support non-deploy operation types.
  if (versionRow && versionRow.version < 8) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      ALTER TABLE deployments RENAME TO _deployments_v7;
      CREATE TABLE deployments (
        id TEXT PRIMARY KEY,
        operation_type TEXT NOT NULL DEFAULT 'deploy',
        artifact_id TEXT,
        artifact_version_id TEXT,
        input_json TEXT,
        intent TEXT,
        lineage TEXT,
        findings TEXT,
        retry_of TEXT,
        envoy_id TEXT,
        environment_id TEXT,
        partition_id TEXT,
        version TEXT,
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
      INSERT INTO deployments (id, artifact_id, artifact_version_id, envoy_id, environment_id, partition_id, version, status, variables, plan, rollback_plan, execution_record, approved_by, approved_at, debrief_entry_ids, created_at, completed_at, failure_reason)
        SELECT id, artifact_id, artifact_version_id, envoy_id, environment_id, partition_id, version, status, variables, plan, rollback_plan, execution_record, approved_by, approved_at, debrief_entry_ids, created_at, completed_at, failure_reason
        FROM _deployments_v7;
      DROP TABLE _deployments_v7;
      CREATE INDEX IF NOT EXISTS idx_deployments_partition ON deployments(partition_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_artifact ON deployments(artifact_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
      PRAGMA foreign_keys = ON;
    `);
    db.prepare(`UPDATE schema_version SET version = ?`).run(8);
    console.log("[Synth] Migrated database schema from v7 to v8 (operation type generalization)");
  }

  // Migrate from v8 to v9: add shelved_at and shelved_reason columns
  if (versionRow && versionRow.version < 9) {
    try { db.exec(`ALTER TABLE deployments ADD COLUMN shelved_at TEXT`); } catch { /* column may already exist */ }
    try { db.exec(`ALTER TABLE deployments ADD COLUMN shelved_reason TEXT`); } catch { /* column may already exist */ }
    db.prepare(`UPDATE schema_version SET version = ?`).run(9);
    console.log("[Synth] Migrated database schema from v8 to v9 (shelved plan support)");
  }

  if (!versionRow) {
    db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(SCHEMA_VERSION);
  } else if (versionRow.version !== SCHEMA_VERSION) {
    console.warn(
      `[Synth] Schema version mismatch: database has v${versionRow.version}, expected v${SCHEMA_VERSION}`,
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
    countByEnv: Database.Statement;
    findByArtifactVersion: Database.Statement;
    findByArtifactVersionStatus: Database.Statement;
    findRecentByArtifact: Database.Statement;
    findRecentByArtifactStatus: Database.Statement;
    findLatestByEnv: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT INTO deployments (id, operation_type, artifact_id, artifact_version_id, input_json, intent, lineage, findings, retry_of, envoy_id, environment_id, partition_id, version, status, variables, plan, rollback_plan, execution_record, approved_by, approved_at, debrief_entry_ids, created_at, completed_at, failure_reason, shelved_at, shelved_reason)
         VALUES (@id, @operation_type, @artifact_id, @artifact_version_id, @input_json, @intent, @lineage, @findings, @retry_of, @envoy_id, @environment_id, @partition_id, @version, @status, @variables, @plan, @rollback_plan, @execution_record, @approved_by, @approved_at, @debrief_entry_ids, @created_at, @completed_at, @failure_reason, @shelved_at, @shelved_reason)
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
           failure_reason = excluded.failure_reason,
           intent = excluded.intent,
           findings = excluded.findings,
           shelved_at = excluded.shelved_at,
           shelved_reason = excluded.shelved_reason`
      // lineage and retry_of are immutable after creation; not included in ON CONFLICT UPDATE
      ),
      getById: db.prepare(`SELECT * FROM deployments WHERE id = ?`),
      getByPartition: db.prepare(
        `SELECT * FROM deployments WHERE partition_id = ? ORDER BY created_at ASC`,
      ),
      getByArtifact: db.prepare(
        `SELECT * FROM deployments WHERE artifact_id = ? ORDER BY created_at ASC`,
      ),
      list: db.prepare(`SELECT * FROM deployments ORDER BY created_at ASC`),
      countByEnv: db.prepare(
        `SELECT COUNT(*) as cnt FROM deployments WHERE environment_id = ? AND created_at >= ?`,
      ),
      findByArtifactVersion: db.prepare(
        `SELECT * FROM deployments WHERE artifact_id = ? AND version = ? ORDER BY created_at DESC`,
      ),
      findByArtifactVersionStatus: db.prepare(
        `SELECT * FROM deployments WHERE artifact_id = ? AND version = ? AND status = ? ORDER BY created_at DESC`,
      ),
      findRecentByArtifact: db.prepare(
        `SELECT * FROM deployments WHERE artifact_id = ? AND created_at >= ? ORDER BY created_at DESC`,
      ),
      findRecentByArtifactStatus: db.prepare(
        `SELECT * FROM deployments WHERE artifact_id = ? AND created_at >= ? AND status = ? ORDER BY created_at DESC`,
      ),
      findLatestByEnv: db.prepare(
        `SELECT * FROM deployments WHERE environment_id = ? ORDER BY created_at DESC LIMIT 1`,
      ),
    };
  }

  save(deployment: Deployment): void {
    const deployInput = deployment.input?.type === 'deploy' ? deployment.input : undefined;
    this.stmts.upsert.run({
      id: deployment.id,
      operation_type: deployment.input?.type ?? 'deploy',
      artifact_id: deployInput?.artifactId ?? null,
      artifact_version_id: deployInput?.artifactVersionId ?? null,
      input_json: deployment.input?.type !== 'deploy' && deployment.input ? JSON.stringify(deployment.input) : null,
      intent: deployment.intent ?? null,
      lineage: deployment.lineage ?? null,
      findings: deployment.findings ?? null,
      retry_of: deployment.retryOf ?? null,
      envoy_id: deployment.envoyId ?? null,
      environment_id: deployment.environmentId ?? null,
      partition_id: deployment.partitionId ?? null,
      version: deployment.version ?? null,
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
      shelved_at: deployment.shelvedAt?.toISOString() ?? null,
      shelved_reason: deployment.shelvedReason ?? null,
    });
  }

  get(id: OperationId): Operation | undefined {
    const row = this.stmts.getById.get(id) as DeploymentRow | undefined;
    return row ? rowToOperation(row) : undefined;
  }

  getByPartition(partitionId: PartitionId): Operation[] {
    const rows = this.stmts.getByPartition.all(partitionId) as DeploymentRow[];
    return rows.map(rowToOperation);
  }

  getByArtifact(artifactId: string): Operation[] {
    const rows = this.stmts.getByArtifact.all(artifactId) as DeploymentRow[];
    return rows.map(rowToOperation);
  }

  list(): Operation[] {
    const rows = this.stmts.list.all() as DeploymentRow[];
    return rows.map(rowToOperation);
  }

  countByEnvironment(envId: string, since: Date): number {
    const row = this.stmts.countByEnv.get(envId, since.toISOString()) as { cnt: number };
    return row.cnt;
  }

  findByArtifactVersion(artifactId: string, version: string, status?: string): Operation[] {
    const rows = status
      ? (this.stmts.findByArtifactVersionStatus.all(artifactId, version, status) as DeploymentRow[])
      : (this.stmts.findByArtifactVersion.all(artifactId, version) as DeploymentRow[]);
    return rows.map(rowToOperation);
  }

  findRecentByArtifact(artifactId: string, since: Date, status?: string): Operation[] {
    const rows = status
      ? (this.stmts.findRecentByArtifactStatus.all(artifactId, since.toISOString(), status) as DeploymentRow[])
      : (this.stmts.findRecentByArtifact.all(artifactId, since.toISOString()) as DeploymentRow[]);
    return rows.map(rowToOperation);
  }

  findLatestByEnvironment(envId: string): Operation | undefined {
    const row = this.stmts.findLatestByEnv.get(envId) as DeploymentRow | undefined;
    return row ? rowToOperation(row) : undefined;
  }

  findShelvedByContext(artifactId: string | undefined, environmentId: string | undefined, operationType: string): Operation[] {
    const rows = this.db.prepare(
      `SELECT * FROM deployments WHERE status = 'shelved' AND operation_type = ? AND (artifact_id IS ? OR ? IS NULL) AND (environment_id IS ? OR ? IS NULL) ORDER BY shelved_at DESC`
    ).all(operationType, artifactId ?? null, artifactId ?? null, environmentId ?? null, environmentId ?? null) as DeploymentRow[];
    return rows.map(rowToOperation);
  }
}

interface DeploymentRow {
  id: string;
  operation_type: string | null;
  artifact_id: string | null;
  artifact_version_id: string | null;
  input_json: string | null;
  intent: string | null;
  lineage: string | null;
  findings: string | null;
  retry_of: string | null;
  envoy_id: string | null;
  environment_id: string | null;
  partition_id: string | null;
  version: string | null;
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
  shelved_at: string | null;
  shelved_reason: string | null;
}

function rowToOperation(row: DeploymentRow): Operation {
  const opType = (row.operation_type ?? 'deploy') as OperationInput['type'];
  let input: OperationInput;
  if (opType === 'deploy') {
    input = { type: 'deploy', artifactId: row.artifact_id ?? '', ...(row.artifact_version_id ? { artifactVersionId: row.artifact_version_id } : {}) };
  } else if (row.input_json) {
    input = JSON.parse(row.input_json) as OperationInput;
  } else {
    // Should never occur: non-deploy row missing input_json indicates data corruption
    console.warn(`[Synth] rowToOperation: row ${row.id} has operation_type="${opType}" but no input_json — data may be corrupt`);
    throw new Error(`Operation ${row.id} has type "${opType}" but missing input_json`);
  }

  const operation: Operation = {
    id: row.id,
    input,
    ...(row.intent ? { intent: row.intent } : {}),
    ...(row.lineage ? { lineage: row.lineage } : {}),
    ...(row.findings ? { findings: row.findings } : {}),
    ...(row.retry_of ? { retryOf: row.retry_of } : {}),
    environmentId: row.environment_id ?? undefined,
    version: row.version ?? undefined,
    status: row.status as Operation["status"],
    variables: safeJsonParse(row.variables, {}, { table: "deployments", rowId: row.id, column: "variables" }),
    debriefEntryIds: safeJsonParse(row.debrief_entry_ids, [], { table: "deployments", rowId: row.id, column: "debrief_entry_ids" }),
    createdAt: new Date(row.created_at),
  };
  if (row.envoy_id) operation.envoyId = row.envoy_id;
  if (row.partition_id) operation.partitionId = row.partition_id;
  if (row.plan) operation.plan = safeJsonParse(row.plan, undefined, { table: "deployments", rowId: row.id, column: "plan" });
  if (row.rollback_plan) operation.rollbackPlan = safeJsonParse(row.rollback_plan, undefined, { table: "deployments", rowId: row.id, column: "rollback_plan" });
  if (row.execution_record) operation.executionRecord = safeJsonParse(row.execution_record, undefined, { table: "deployments", rowId: row.id, column: "execution_record" });
  if (row.approved_by) operation.approvedBy = row.approved_by;
  if (row.approved_at) operation.approvedAt = new Date(row.approved_at);
  if (row.completed_at) operation.completedAt = new Date(row.completed_at);
  if (row.failure_reason) operation.failureReason = row.failure_reason;
  if (row.shelved_at) operation.shelvedAt = new Date(row.shelved_at);
  if (row.shelved_reason) operation.shelvedReason = row.shelved_reason;
  return operation;
}

// ---------------------------------------------------------------------------
// PersistentSettingsStore
// ---------------------------------------------------------------------------

export class PersistentSettingsStore {
  private stmts: {
    get: Database.Statement;
    upsert: Database.Statement;
  };
  private encryptionKey: Buffer | undefined;

  constructor(private db: Database.Database, encryptionSecret?: string) {
    if (encryptionSecret) {
      this.encryptionKey = deriveEncryptionKey(encryptionSecret);
    }
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

  setSecret(key: string, value: string): void {
    const stored = this.encryptionKey ? encryptValue(value, this.encryptionKey) : value;
    this.stmts.upsert.run({ key: `secret:${key}`, value: stored });
  }

  getSecret(key: string): string | null {
    const row = this.stmts.get.get(`secret:${key}`) as { value: string } | undefined;
    if (!row) return null;
    return this.encryptionKey ? decryptValue(row.value, this.encryptionKey) : row.value;
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
    if (partial.operationDefaults) {
      current.operationDefaults = {
        ...current.operationDefaults,
        ...partial.operationDefaults,
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
      current.llm = current.llm
        ? { ...current.llm, ...partial.llm }
        : partial.llm as AppSettings["llm"];
    }
    if (partial.defaultTheme !== undefined) {
      current.defaultTheme = partial.defaultTheme;
    }
    if (partial.approvalDefaults) {
      current.approvalDefaults = {
        ...current.approvalDefaults,
        ...partial.approvalDefaults,
      };
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

// ---------------------------------------------------------------------------
// Persistent Telemetry Store
// ---------------------------------------------------------------------------

import type { ITelemetryStore } from "./store-interfaces.js";

export class PersistentTelemetryStore implements ITelemetryStore {
  private insertStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT INTO telemetry_events (id, timestamp, actor, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  record(event: Omit<TelemetryEvent, "id" | "timestamp">): TelemetryEvent {
    const id = crypto.randomUUID();
    const timestamp = new Date();
    this.insertStmt.run(
      id,
      timestamp.toISOString(),
      event.actor,
      event.action,
      event.target.type,
      event.target.id,
      JSON.stringify(event.details),
    );
    return { id, timestamp, ...event };
  }

  query(filters: {
    actor?: string;
    action?: TelemetryAction;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): TelemetryEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.actor) { conditions.push("actor = ?"); params.push(filters.actor); }
    if (filters.action) { conditions.push("action = ?"); params.push(filters.action); }
    if (filters.from) { conditions.push("timestamp >= ?"); params.push(filters.from.toISOString()); }
    if (filters.to) { conditions.push("timestamp <= ?"); params.push(filters.to.toISOString()); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const rows = this.db.prepare(
      `SELECT * FROM telemetry_events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as TelemetryRow[];

    return rows.map(rowToTelemetryEvent);
  }

  count(filters?: { actor?: string; action?: TelemetryAction; from?: Date; to?: Date }): number {
    if (!filters) {
      return (this.db.prepare("SELECT COUNT(*) as count FROM telemetry_events").get() as { count: number }).count;
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.actor) { conditions.push("actor = ?"); params.push(filters.actor); }
    if (filters.action) { conditions.push("action = ?"); params.push(filters.action); }
    if (filters.from) { conditions.push("timestamp >= ?"); params.push(filters.from.toISOString()); }
    if (filters.to) { conditions.push("timestamp <= ?"); params.push(filters.to.toISOString()); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT COUNT(*) as count FROM telemetry_events ${where}`).all(...params)[0] as { count: number }).count;
  }
}

interface TelemetryRow {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  details: string | null;
}

function rowToTelemetryEvent(row: TelemetryRow): TelemetryEvent {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp),
    actor: row.actor,
    action: row.action as TelemetryAction,
    target: { type: row.target_type, id: row.target_id },
    details: safeJsonParse(row.details ?? "{}", {}, { table: "telemetry_events", rowId: row.id, column: "details" }),
  };
}

// ---------------------------------------------------------------------------
// PersistentUserStore
// ---------------------------------------------------------------------------

export class PersistentUserStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    getByEmail: Database.Statement;
    getByExternalId: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    deleteById: Database.Statement;
    count: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO users (id, email, name, password_hash, auth_source, external_id, created_at, updated_at)
         VALUES (@id, @email, @name, @password_hash, @auth_source, @external_id, @created_at, @updated_at)`,
      ),
      getById: db.prepare(`SELECT * FROM users WHERE id = ?`),
      getByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
      getByExternalId: db.prepare(`SELECT * FROM users WHERE external_id = ? AND auth_source = ?`),
      list: db.prepare(`SELECT * FROM users ORDER BY created_at ASC`),
      update: db.prepare(
        `UPDATE users SET email = @email, name = @name, password_hash = @password_hash, auth_source = @auth_source, external_id = @external_id, updated_at = @updated_at WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM users WHERE id = ?`),
      count: db.prepare(`SELECT COUNT(*) as cnt FROM users`),
    };
  }

  create(user: User): User {
    this.stmts.insert.run({
      id: user.id,
      email: user.email,
      name: user.name,
      password_hash: user.passwordHash,
      auth_source: user.authSource ?? "local",
      external_id: user.externalId ?? null,
      created_at: user.createdAt.toISOString(),
      updated_at: user.updatedAt.toISOString(),
    });
    return structuredClone(user);
  }

  getById(id: UserId): User | undefined {
    const row = this.stmts.getById.get(id) as UserRow | undefined;
    return row ? rowToUser(row) : undefined;
  }

  getByEmail(email: string): User | undefined {
    const row = this.stmts.getByEmail.get(email) as UserRow | undefined;
    return row ? rowToUser(row) : undefined;
  }

  getByExternalId(externalId: string, provider: string): User | undefined {
    const row = this.stmts.getByExternalId.get(externalId, provider) as UserRow | undefined;
    return row ? rowToUser(row) : undefined;
  }

  list(): User[] {
    const rows = this.stmts.list.all() as UserRow[];
    return rows.map(rowToUser);
  }

  update(id: UserId, updates: Partial<Pick<User, "email" | "name" | "passwordHash" | "authSource" | "externalId" | "updatedAt">>): User {
    const user = this.getById(id);
    if (!user) throw new Error(`User not found: ${id}`);
    const newEmail = updates.email ?? user.email;
    const newName = updates.name ?? user.name;
    const newHash = updates.passwordHash ?? user.passwordHash;
    const newAuthSource = updates.authSource ?? user.authSource ?? "local";
    const newExternalId = updates.externalId ?? user.externalId ?? null;
    const newUpdatedAt = updates.updatedAt ?? new Date();
    this.stmts.update.run({
      id,
      email: newEmail,
      name: newName,
      password_hash: newHash,
      auth_source: newAuthSource,
      external_id: newExternalId,
      updated_at: newUpdatedAt.toISOString(),
    });
    return { ...user, email: newEmail, name: newName, passwordHash: newHash, authSource: newAuthSource as User["authSource"], externalId: newExternalId ?? undefined, updatedAt: newUpdatedAt };
  }

  delete(id: UserId): void {
    this.stmts.deleteById.run(id);
  }

  count(): number {
    const row = this.stmts.count.get() as { cnt: number };
    return row.cnt;
  }
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  auth_source: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id as UserId,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    authSource: (row.auth_source as User["authSource"]) ?? "local",
    externalId: row.external_id ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// PersistentRoleStore
// ---------------------------------------------------------------------------

export class PersistentRoleStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    getByName: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO roles (id, name, permissions, is_built_in, created_at)
         VALUES (@id, @name, @permissions, @is_built_in, @created_at)`,
      ),
      getById: db.prepare(`SELECT * FROM roles WHERE id = ?`),
      getByName: db.prepare(`SELECT * FROM roles WHERE name = ?`),
      list: db.prepare(`SELECT * FROM roles ORDER BY created_at ASC`),
      update: db.prepare(
        `UPDATE roles SET name = @name, permissions = @permissions WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM roles WHERE id = ?`),
    };
  }

  create(role: Role): Role {
    this.stmts.insert.run({
      id: role.id,
      name: role.name,
      permissions: JSON.stringify(role.permissions),
      is_built_in: role.isBuiltIn ? 1 : 0,
      created_at: role.createdAt.toISOString(),
    });
    return structuredClone(role);
  }

  getById(id: RoleId): Role | undefined {
    const row = this.stmts.getById.get(id) as RoleRow | undefined;
    return row ? rowToRole(row) : undefined;
  }

  getByName(name: string): Role | undefined {
    const row = this.stmts.getByName.get(name) as RoleRow | undefined;
    return row ? rowToRole(row) : undefined;
  }

  list(): Role[] {
    const rows = this.stmts.list.all() as RoleRow[];
    return rows.map(rowToRole);
  }

  update(id: RoleId, updates: Partial<Pick<Role, "name" | "permissions">>): Role {
    const role = this.getById(id);
    if (!role) throw new Error(`Role not found: ${id}`);
    const newName = updates.name ?? role.name;
    const newPermissions = updates.permissions ?? role.permissions;
    this.stmts.update.run({
      id,
      name: newName,
      permissions: JSON.stringify(newPermissions),
    });
    return { ...role, name: newName, permissions: newPermissions };
  }

  delete(id: RoleId): void {
    this.stmts.deleteById.run(id);
  }
}

interface RoleRow {
  id: string;
  name: string;
  permissions: string;
  is_built_in: number;
  created_at: string;
}

function rowToRole(row: RoleRow): Role {
  return {
    id: row.id as RoleId,
    name: row.name,
    permissions: safeJsonParse<Permission[]>(row.permissions, [], { table: "roles", rowId: row.id, column: "permissions" }),
    isBuiltIn: row.is_built_in === 1,
    createdAt: new Date(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// PersistentUserRoleStore
// ---------------------------------------------------------------------------

export class PersistentUserRoleStore {
  private stmts: {
    insert: Database.Statement;
    getByUser: Database.Statement;
    deleteOne: Database.Statement;
    deleteAllForUser: Database.Statement;
  };

  private roleStore: PersistentRoleStore;

  constructor(private db: Database.Database, roleStore: PersistentRoleStore) {
    this.roleStore = roleStore;
    this.stmts = {
      insert: db.prepare(
        `INSERT OR REPLACE INTO user_roles (user_id, role_id, assigned_at, assigned_by)
         VALUES (@user_id, @role_id, @assigned_at, @assigned_by)`,
      ),
      getByUser: db.prepare(`SELECT * FROM user_roles WHERE user_id = ?`),
      deleteOne: db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`),
      deleteAllForUser: db.prepare(`DELETE FROM user_roles WHERE user_id = ?`),
    };
  }

  assign(userId: UserId, roleId: RoleId, assignedBy: UserId): UserRole {
    const role = this.roleStore.getById(roleId);
    if (!role) throw new Error(`Role not found: ${roleId}`);
    const assignment: UserRole = {
      userId,
      roleId,
      assignedAt: new Date(),
      assignedBy,
    };
    this.stmts.insert.run({
      user_id: userId,
      role_id: roleId,
      assigned_at: assignment.assignedAt.toISOString(),
      assigned_by: assignedBy,
    });
    return assignment;
  }

  getUserRoles(userId: UserId): Role[] {
    const rows = this.stmts.getByUser.all(userId) as UserRoleRow[];
    const roles: Role[] = [];
    for (const row of rows) {
      const role = this.roleStore.getById(row.role_id as RoleId);
      if (role) roles.push(role);
    }
    return roles;
  }

  getUserPermissions(userId: UserId): Permission[] {
    const roles = this.getUserRoles(userId);
    const permissionSet = new Set<Permission>();
    for (const role of roles) {
      for (const perm of role.permissions) {
        permissionSet.add(perm);
      }
    }
    return [...permissionSet];
  }

  removeRole(userId: UserId, roleId: RoleId): void {
    this.stmts.deleteOne.run(userId, roleId);
  }

  setRoles(userId: UserId, roleIds: RoleId[], assignedBy: UserId): void {
    const txn = this.db.transaction(() => {
      this.stmts.deleteAllForUser.run(userId);
      for (const roleId of roleIds) {
        this.assign(userId, roleId, assignedBy);
      }
    });
    txn();
  }
}

interface UserRoleRow {
  user_id: string;
  role_id: string;
  assigned_at: string;
  assigned_by: string;
}

// ---------------------------------------------------------------------------
// PersistentSessionStore
// ---------------------------------------------------------------------------

export class PersistentSessionStore {
  private stmts: {
    insert: Database.Statement;
    getByToken: Database.Statement;
    getByRefreshToken: Database.Statement;
    deleteByToken: Database.Statement;
    deleteByUserId: Database.Statement;
    deleteExpired: Database.Statement;
    listByUserId: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO sessions (id, user_id, token, refresh_token, expires_at, created_at, user_agent, ip_address)
         VALUES (@id, @user_id, @token, @refresh_token, @expires_at, @created_at, @user_agent, @ip_address)`,
      ),
      getByToken: db.prepare(`SELECT * FROM sessions WHERE token = ?`),
      getByRefreshToken: db.prepare(`SELECT * FROM sessions WHERE refresh_token = ?`),
      deleteByToken: db.prepare(`DELETE FROM sessions WHERE token = ?`),
      deleteByUserId: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
      deleteExpired: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),
      listByUserId: db.prepare(`SELECT * FROM sessions WHERE user_id = ?`),
      deleteById: db.prepare(`DELETE FROM sessions WHERE id = ?`),
    };
  }

  create(session: Session): Session {
    this.stmts.insert.run({
      id: session.id,
      user_id: session.userId,
      token: session.token,
      refresh_token: session.refreshToken,
      expires_at: session.expiresAt.toISOString(),
      created_at: session.createdAt.toISOString(),
      user_agent: session.userAgent ?? null,
      ip_address: session.ipAddress ?? null,
    });
    return structuredClone(session);
  }

  getByToken(token: string): Session | undefined {
    const row = this.stmts.getByToken.get(token) as SessionRow | undefined;
    if (!row) return undefined;
    const session = rowToSession(row);
    if (session.expiresAt < new Date()) {
      this.deleteByToken(token);
      return undefined;
    }
    return session;
  }

  getByRefreshToken(refreshToken: string): Session | undefined {
    const row = this.stmts.getByRefreshToken.get(refreshToken) as SessionRow | undefined;
    return row ? rowToSession(row) : undefined;
  }

  deleteByToken(token: string): void {
    this.stmts.deleteByToken.run(token);
  }

  deleteByUserId(userId: UserId): void {
    this.stmts.deleteByUserId.run(userId);
  }

  deleteExpired(): void {
    this.stmts.deleteExpired.run(new Date().toISOString());
  }

  listByUserId(userId: UserId): Session[] {
    const rows = this.stmts.listByUserId.all(userId) as SessionRow[];
    return rows.map(rowToSession);
  }

  deleteById(id: string): void {
    this.stmts.deleteById.run(id);
  }
}

interface SessionRow {
  id: string;
  user_id: string;
  token: string;
  refresh_token: string;
  expires_at: string;
  created_at: string;
  user_agent: string | null;
  ip_address: string | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id as UserId,
    token: row.token,
    refreshToken: row.refresh_token,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    userAgent: row.user_agent ?? undefined,
    ipAddress: row.ip_address ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// PersistentIdpProviderStore
// ---------------------------------------------------------------------------

interface IdpProviderRow {
  id: string;
  type: string;
  name: string;
  enabled: number;
  config: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Config encryption — AES-256-GCM for client secrets at rest
// ---------------------------------------------------------------------------

function deriveEncryptionKey(secret: string): Buffer {
  return crypto.pbkdf2Sync(secret, "synth-idp-config", 100_000, 32, "sha256");
}

function encryptValue(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv):base64(tag):base64(encrypted)
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptValue(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    // Not in encrypted format — return as-is
    return ciphertext;
  }
  const iv = Buffer.from(parts[0], "base64");
  const tag = Buffer.from(parts[1], "base64");
  const encrypted = Buffer.from(parts[2], "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

function encryptConfigSecrets(config: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  const result = { ...config };
  if (typeof result.clientSecret === "string" && result.clientSecret.length > 0) {
    result.clientSecret = encryptValue(result.clientSecret, key);
    result.__secretEncrypted = true;
  }
  if (typeof result.bindCredential === "string" && result.bindCredential.length > 0) {
    result.bindCredential = encryptValue(result.bindCredential, key);
    result.__bindCredentialEncrypted = true;
  }
  return result;
}

function decryptConfigSecrets(config: Record<string, unknown>, key: Buffer): Record<string, unknown> {
  const result = { ...config };
  if (result.__secretEncrypted && typeof result.clientSecret === "string") {
    result.clientSecret = decryptValue(result.clientSecret, key);
    delete result.__secretEncrypted;
  }
  if (result.__bindCredentialEncrypted && typeof result.bindCredential === "string") {
    result.bindCredential = decryptValue(result.bindCredential, key);
    delete result.__bindCredentialEncrypted;
  }
  return result;
}

function rowToIdpProvider(row: IdpProviderRow, encryptionKey?: Buffer): IdpProvider {
  let config = JSON.parse(row.config);
  if (encryptionKey) {
    config = decryptConfigSecrets(config, encryptionKey);
  }
  return {
    id: row.id,
    type: row.type as IdpProvider["type"],
    name: row.name,
    enabled: row.enabled === 1,
    config,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PersistentIdpProviderStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    deleteById: Database.Statement;
  };
  private encryptionKey: Buffer | undefined;

  constructor(private db: Database.Database, encryptionSecret?: string) {
    if (encryptionSecret) {
      this.encryptionKey = deriveEncryptionKey(encryptionSecret);
    }
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO idp_providers (id, type, name, enabled, config, created_at, updated_at)
         VALUES (@id, @type, @name, @enabled, @config, @created_at, @updated_at)`,
      ),
      getById: db.prepare(`SELECT * FROM idp_providers WHERE id = ?`),
      list: db.prepare(`SELECT * FROM idp_providers ORDER BY created_at ASC`),
      update: db.prepare(
        `UPDATE idp_providers SET name = @name, enabled = @enabled, config = @config, updated_at = @updated_at WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM idp_providers WHERE id = ?`),
    };
  }

  create(provider: IdpProvider): IdpProvider {
    const configForStorage = this.encryptionKey
      ? encryptConfigSecrets(provider.config as Record<string, unknown>, this.encryptionKey)
      : provider.config;
    this.stmts.insert.run({
      id: provider.id,
      type: provider.type,
      name: provider.name,
      enabled: provider.enabled ? 1 : 0,
      config: JSON.stringify(configForStorage),
      created_at: provider.createdAt.toISOString(),
      updated_at: provider.updatedAt.toISOString(),
    });
    return structuredClone(provider);
  }

  getById(id: string): IdpProvider | undefined {
    const row = this.stmts.getById.get(id) as IdpProviderRow | undefined;
    if (!row) return undefined;
    const provider = rowToIdpProvider(row, this.encryptionKey);

    // Ensure secrets are encrypted at rest
    if (this.encryptionKey) {
      const rawConfig = JSON.parse(row.config);
      let needsReEncrypt = false;
      if (typeof rawConfig.clientSecret === "string" && !rawConfig.__secretEncrypted) {
        needsReEncrypt = true;
      }
      if (typeof rawConfig.bindCredential === "string" && !rawConfig.__bindCredentialEncrypted) {
        needsReEncrypt = true;
      }
      if (needsReEncrypt) {
        const encrypted = encryptConfigSecrets(rawConfig, this.encryptionKey);
        this.stmts.update.run({
          id,
          name: row.name,
          enabled: row.enabled,
          config: JSON.stringify(encrypted),
          updated_at: new Date().toISOString(),
        });
      }
    }

    return provider;
  }

  list(): IdpProvider[] {
    const rows = this.stmts.list.all() as IdpProviderRow[];

    // Ensure secrets are encrypted at rest
    if (this.encryptionKey) {
      for (const row of rows) {
        const rawConfig = JSON.parse(row.config);
        let needsReEncrypt = false;
        if (typeof rawConfig.clientSecret === "string" && !rawConfig.__secretEncrypted) {
          needsReEncrypt = true;
        }
        if (typeof rawConfig.bindCredential === "string" && !rawConfig.__bindCredentialEncrypted) {
          needsReEncrypt = true;
        }
        if (needsReEncrypt) {
          const encrypted = encryptConfigSecrets(rawConfig, this.encryptionKey);
          this.stmts.update.run({
            id: row.id,
            name: row.name,
            enabled: row.enabled,
            config: JSON.stringify(encrypted),
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    return rows.map((r) => rowToIdpProvider(r, this.encryptionKey));
  }

  update(id: string, updates: Partial<Pick<IdpProvider, "name" | "enabled" | "config" | "updatedAt">>): IdpProvider {
    const existing = this.getById(id);
    if (!existing) throw new Error(`IdP provider not found: ${id}`);
    const newName = updates.name ?? existing.name;
    const newEnabled = updates.enabled ?? existing.enabled;
    const newConfig = updates.config ?? existing.config;
    const newUpdatedAt = updates.updatedAt ?? new Date();
    const configForStorage = this.encryptionKey
      ? encryptConfigSecrets(newConfig as Record<string, unknown>, this.encryptionKey)
      : newConfig;
    this.stmts.update.run({
      id,
      name: newName,
      enabled: newEnabled ? 1 : 0,
      config: JSON.stringify(configForStorage),
      updated_at: newUpdatedAt.toISOString(),
    });
    return { ...existing, name: newName, enabled: newEnabled, config: newConfig, updatedAt: newUpdatedAt };
  }

  delete(id: string): void {
    this.stmts.deleteById.run(id);
  }

  /** Returns true if an encryption key was provided for at-rest secret encryption. */
  hasEncryptionKey(): boolean {
    return this.encryptionKey !== undefined;
  }
}

// ---------------------------------------------------------------------------
// PersistentRoleMappingStore
// ---------------------------------------------------------------------------

interface RoleMappingRow {
  id: string;
  provider_id: string;
  idp_group: string;
  synth_role: string;
}

function rowToRoleMapping(row: RoleMappingRow): RoleMappingRule {
  return {
    id: row.id,
    providerId: row.provider_id,
    idpGroup: row.idp_group,
    synthRole: row.synth_role,
  };
}

export class PersistentRoleMappingStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    listByProvider: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO role_mappings (id, provider_id, idp_group, synth_role)
         VALUES (@id, @provider_id, @idp_group, @synth_role)`,
      ),
      getById: db.prepare(`SELECT * FROM role_mappings WHERE id = ?`),
      listByProvider: db.prepare(`SELECT * FROM role_mappings WHERE provider_id = ?`),
      deleteById: db.prepare(`DELETE FROM role_mappings WHERE id = ?`),
    };
  }

  create(rule: RoleMappingRule): RoleMappingRule {
    this.stmts.insert.run({
      id: rule.id,
      provider_id: rule.providerId,
      idp_group: rule.idpGroup,
      synth_role: rule.synthRole,
    });
    return structuredClone(rule);
  }

  getById(id: string): RoleMappingRule | undefined {
    const row = this.stmts.getById.get(id) as RoleMappingRow | undefined;
    return row ? rowToRoleMapping(row) : undefined;
  }

  listByProvider(providerId: string): RoleMappingRule[] {
    const rows = this.stmts.listByProvider.all(providerId) as RoleMappingRow[];
    return rows.map(rowToRoleMapping);
  }

  delete(id: string): void {
    this.stmts.deleteById.run(id);
  }
}

// ---------------------------------------------------------------------------
// PersistentApiKeyStore
// ---------------------------------------------------------------------------

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_prefix: string;
  key_suffix: string;
  key_hash: string;
  permissions: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function rowToApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id as ApiKeyId,
    userId: row.user_id as UserId,
    name: row.name,
    keyPrefix: row.key_prefix,
    keySuffix: row.key_suffix,
    keyHash: row.key_hash,
    permissions: safeJsonParse(row.permissions, [], { table: "api_keys", rowId: row.id, column: "permissions" }),
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
  };
}

export class PersistentApiKeyStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    listByUser: Database.Statement;
    updateLastUsed: Database.Statement;
    revoke: Database.Statement;
    updateHash: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO api_keys (id, user_id, name, key_prefix, key_suffix, key_hash, permissions, created_at, last_used_at, revoked_at)
         VALUES (@id, @user_id, @name, @key_prefix, @key_suffix, @key_hash, @permissions, @created_at, @last_used_at, @revoked_at)`,
      ),
      getById: db.prepare(`SELECT * FROM api_keys WHERE id = ?`),
      listByUser: db.prepare(`SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`),
      updateLastUsed: db.prepare(`UPDATE api_keys SET last_used_at = @last_used_at WHERE id = @id`),
      revoke: db.prepare(`UPDATE api_keys SET revoked_at = @revoked_at WHERE id = @id`),
      updateHash: db.prepare(
        `UPDATE api_keys SET key_hash = @key_hash, key_prefix = @key_prefix, key_suffix = @key_suffix WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM api_keys WHERE id = ?`),
    };
  }

  create(key: ApiKey): ApiKey {
    this.stmts.insert.run({
      id: key.id,
      user_id: key.userId,
      name: key.name,
      key_prefix: key.keyPrefix,
      key_suffix: key.keySuffix,
      key_hash: key.keyHash,
      permissions: JSON.stringify(key.permissions),
      created_at: key.createdAt.toISOString(),
      last_used_at: key.lastUsedAt?.toISOString() ?? null,
      revoked_at: key.revokedAt?.toISOString() ?? null,
    });
    return structuredClone(key);
  }

  getById(id: ApiKeyId): ApiKey | undefined {
    const row = this.stmts.getById.get(id) as ApiKeyRow | undefined;
    return row ? rowToApiKey(row) : undefined;
  }

  listByUserId(userId: UserId): ApiKey[] {
    const rows = this.stmts.listByUser.all(userId) as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  updateLastUsed(id: ApiKeyId, at: Date): void {
    this.stmts.updateLastUsed.run({ id, last_used_at: at.toISOString() });
  }

  revoke(id: ApiKeyId): void {
    this.stmts.revoke.run({ id, revoked_at: new Date().toISOString() });
  }

  updateHash(id: ApiKeyId, keyHash: string, keyPrefix: string, keySuffix: string): void {
    this.stmts.updateHash.run({ id, key_hash: keyHash, key_prefix: keyPrefix, key_suffix: keySuffix });
  }

  delete(id: ApiKeyId): void {
    this.stmts.deleteById.run(id);
  }
}

// ---------------------------------------------------------------------------
// PersistentEnvoyRegistry
// ---------------------------------------------------------------------------

interface EnvoyRegistrationRow {
  id: string;
  name: string;
  url: string;
  token: string;
  assigned_environments: string;
  assigned_partitions: string;
  registered_at: string;
  last_health_check: string | null;
  last_health_status: string | null;
  cached_hostname: string | null;
  cached_os: string | null;
  cached_summary: string | null;
  cached_readiness: string | null;
}

/** Shape of an envoy registration persisted to SQLite. */
export interface PersistedEnvoyRegistration {
  id: string;
  name: string;
  url: string;
  token: string;
  assignedEnvironments: string[];
  assignedPartitions: string[];
  registeredAt: string;
  lastHealthCheck: string | null;
  lastHealthStatus: "healthy" | "degraded" | "unreachable" | null;
  cachedHostname: string | null;
  cachedOs: string | null;
  cachedSummary: unknown | null;
  cachedReadiness: unknown | null;
}

function rowToEnvoyRegistration(row: EnvoyRegistrationRow): PersistedEnvoyRegistration {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    token: row.token,
    assignedEnvironments: safeJsonParse(row.assigned_environments, [], { table: "envoy_registrations", rowId: row.id, column: "assigned_environments" }),
    assignedPartitions: safeJsonParse(row.assigned_partitions, [], { table: "envoy_registrations", rowId: row.id, column: "assigned_partitions" }),
    registeredAt: row.registered_at,
    lastHealthCheck: row.last_health_check,
    lastHealthStatus: row.last_health_status as PersistedEnvoyRegistration["lastHealthStatus"],
    cachedHostname: row.cached_hostname,
    cachedOs: row.cached_os,
    cachedSummary: safeJsonParse(row.cached_summary, null, { table: "envoy_registrations", rowId: row.id, column: "cached_summary" }),
    cachedReadiness: safeJsonParse(row.cached_readiness, null, { table: "envoy_registrations", rowId: row.id, column: "cached_readiness" }),
  };
}

export class PersistentEnvoyRegistryStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    updateToken: Database.Statement;
    updateHealth: Database.Statement;
    updateCachedProbe: Database.Statement;
    deleteById: Database.Statement;
    getByToken: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO envoy_registrations (id, name, url, token, assigned_environments, assigned_partitions, registered_at, last_health_check, last_health_status, cached_hostname, cached_os, cached_summary, cached_readiness)
         VALUES (@id, @name, @url, @token, @assigned_environments, @assigned_partitions, @registered_at, @last_health_check, @last_health_status, @cached_hostname, @cached_os, @cached_summary, @cached_readiness)`,
      ),
      getById: db.prepare(`SELECT * FROM envoy_registrations WHERE id = ?`),
      list: db.prepare(`SELECT * FROM envoy_registrations ORDER BY registered_at ASC`),
      update: db.prepare(
        `UPDATE envoy_registrations SET name = @name, url = @url, assigned_environments = @assigned_environments, assigned_partitions = @assigned_partitions WHERE id = @id`,
      ),
      updateToken: db.prepare(`UPDATE envoy_registrations SET token = @token WHERE id = @id`),
      updateHealth: db.prepare(
        `UPDATE envoy_registrations SET last_health_check = @last_health_check, last_health_status = @last_health_status WHERE id = @id`,
      ),
      updateCachedProbe: db.prepare(
        `UPDATE envoy_registrations SET last_health_check = @last_health_check, last_health_status = @last_health_status, cached_hostname = @cached_hostname, cached_os = @cached_os, cached_summary = @cached_summary, cached_readiness = @cached_readiness WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM envoy_registrations WHERE id = ?`),
      getByToken: db.prepare(`SELECT * FROM envoy_registrations WHERE token = ?`),
    };
  }

  insert(reg: PersistedEnvoyRegistration): void {
    this.stmts.insert.run({
      id: reg.id,
      name: reg.name,
      url: reg.url,
      token: reg.token,
      assigned_environments: JSON.stringify(reg.assignedEnvironments),
      assigned_partitions: JSON.stringify(reg.assignedPartitions),
      registered_at: reg.registeredAt,
      last_health_check: reg.lastHealthCheck,
      last_health_status: reg.lastHealthStatus,
      cached_hostname: reg.cachedHostname,
      cached_os: reg.cachedOs,
      cached_summary: reg.cachedSummary ? JSON.stringify(reg.cachedSummary) : null,
      cached_readiness: reg.cachedReadiness ? JSON.stringify(reg.cachedReadiness) : null,
    });
  }

  getById(id: string): PersistedEnvoyRegistration | undefined {
    const row = this.stmts.getById.get(id) as EnvoyRegistrationRow | undefined;
    return row ? rowToEnvoyRegistration(row) : undefined;
  }

  list(): PersistedEnvoyRegistration[] {
    const rows = this.stmts.list.all() as EnvoyRegistrationRow[];
    return rows.map(rowToEnvoyRegistration);
  }

  update(id: string, updates: { name?: string; url?: string; assignedEnvironments?: string[]; assignedPartitions?: string[] }): void {
    const existing = this.getById(id);
    if (!existing) return;
    this.stmts.update.run({
      id,
      name: updates.name ?? existing.name,
      url: updates.url ?? existing.url,
      assigned_environments: JSON.stringify(updates.assignedEnvironments ?? existing.assignedEnvironments),
      assigned_partitions: JSON.stringify(updates.assignedPartitions ?? existing.assignedPartitions),
    });
  }

  updateToken(id: string, token: string): void {
    this.stmts.updateToken.run({ id, token });
  }

  updateHealth(id: string, status: string, timestamp: string): void {
    this.stmts.updateHealth.run({ id, last_health_check: timestamp, last_health_status: status });
  }

  updateCachedProbe(id: string, data: {
    lastHealthCheck: string;
    lastHealthStatus: string;
    cachedHostname: string | null;
    cachedOs: string | null;
    cachedSummary: unknown | null;
    cachedReadiness: unknown | null;
  }): void {
    this.stmts.updateCachedProbe.run({
      id,
      last_health_check: data.lastHealthCheck,
      last_health_status: data.lastHealthStatus,
      cached_hostname: data.cachedHostname,
      cached_os: data.cachedOs,
      cached_summary: data.cachedSummary ? JSON.stringify(data.cachedSummary) : null,
      cached_readiness: data.cachedReadiness ? JSON.stringify(data.cachedReadiness) : null,
    });
  }

  delete(id: string): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }

  getByToken(token: string): PersistedEnvoyRegistration | undefined {
    const row = this.stmts.getByToken.get(token) as EnvoyRegistrationRow | undefined;
    return row ? rowToEnvoyRegistration(row) : undefined;
  }
}

// ---------------------------------------------------------------------------
// PersistentIntakeChannelStore
// ---------------------------------------------------------------------------

interface IntakeChannelRow {
  id: string;
  type: string;
  name: string;
  enabled: number;
  config: string;
  auth_token: string | null;
  last_polled_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToIntakeChannel(row: IntakeChannelRow): IntakeChannel {
  return {
    id: row.id,
    type: row.type as IntakeChannelType,
    name: row.name,
    enabled: row.enabled === 1,
    config: safeJsonParse(row.config, {}, { table: "intake_channels", rowId: row.id, column: "config" }),
    authToken: row.auth_token ?? undefined,
    lastPolledAt: row.last_polled_at ? new Date(row.last_polled_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PersistentIntakeChannelStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    getByToken: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO intake_channels (id, type, name, enabled, config, auth_token, last_polled_at, created_at, updated_at)
         VALUES (@id, @type, @name, @enabled, @config, @auth_token, @last_polled_at, @created_at, @updated_at)`,
      ),
      getById: db.prepare(`SELECT * FROM intake_channels WHERE id = ?`),
      getByToken: db.prepare(`SELECT * FROM intake_channels WHERE auth_token = ?`),
      list: db.prepare(`SELECT * FROM intake_channels ORDER BY created_at ASC`),
      update: db.prepare(
        `UPDATE intake_channels SET name = @name, enabled = @enabled, config = @config, last_polled_at = @last_polled_at, updated_at = @updated_at WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM intake_channels WHERE id = ?`),
    };
  }

  create(channel: Omit<IntakeChannel, "id" | "createdAt" | "updatedAt">): IntakeChannel {
    const id = crypto.randomUUID();
    const now = new Date();
    const full: IntakeChannel = {
      ...channel,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.stmts.insert.run({
      id: full.id,
      type: full.type,
      name: full.name,
      enabled: full.enabled ? 1 : 0,
      config: JSON.stringify(full.config),
      auth_token: full.authToken ?? null,
      last_polled_at: full.lastPolledAt?.toISOString() ?? null,
      created_at: full.createdAt.toISOString(),
      updated_at: full.updatedAt.toISOString(),
    });
    return full;
  }

  get(id: string): IntakeChannel | undefined {
    const row = this.stmts.getById.get(id) as IntakeChannelRow | undefined;
    return row ? rowToIntakeChannel(row) : undefined;
  }

  getByToken(token: string): IntakeChannel | undefined {
    const row = this.stmts.getByToken.get(token) as IntakeChannelRow | undefined;
    return row ? rowToIntakeChannel(row) : undefined;
  }

  list(): IntakeChannel[] {
    const rows = this.stmts.list.all() as IntakeChannelRow[];
    return rows.map(rowToIntakeChannel);
  }

  update(id: string, updates: Partial<Pick<IntakeChannel, "name" | "enabled" | "config" | "lastPolledAt">>): IntakeChannel {
    const existing = this.get(id);
    if (!existing) throw new Error(`Intake channel ${id} not found`);

    const updated: IntakeChannel = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };
    this.stmts.update.run({
      id,
      name: updated.name,
      enabled: updated.enabled ? 1 : 0,
      config: JSON.stringify(updated.config),
      last_polled_at: updated.lastPolledAt?.toISOString() ?? null,
      updated_at: updated.updatedAt.toISOString(),
    });
    return updated;
  }

  delete(id: string): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }
}

// ---------------------------------------------------------------------------
// PersistentIntakeEventStore
// ---------------------------------------------------------------------------

interface IntakeEventRow {
  id: string;
  channel_id: string;
  artifact_id: string | null;
  status: string;
  payload: string;
  error: string | null;
  created_at: string;
  processed_at: string | null;
}

function rowToIntakeEvent(row: IntakeEventRow): IntakeEvent {
  return {
    id: row.id,
    channelId: row.channel_id,
    artifactId: row.artifact_id ?? undefined,
    status: row.status as IntakeEvent["status"],
    payload: safeJsonParse(row.payload, {}, { table: "intake_events", rowId: row.id, column: "payload" }),
    error: row.error ?? undefined,
    createdAt: new Date(row.created_at),
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  };
}

/**
 * SQLite-backed intake event store with retention policy.
 * Events are persisted but trimmed to MAX_EVENTS_PER_CHANNEL per channel
 * to prevent unbounded growth. Recent events are preserved; oldest are pruned.
 */
export class PersistentIntakeEventStore {
  private static readonly MAX_EVENTS_PER_CHANNEL = 1000;

  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    update: Database.Statement;
    listByChannel: Database.Statement;
    listRecent: Database.Statement;
    pruneOldest: Database.Statement;
    countByChannel: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO intake_events (id, channel_id, artifact_id, status, payload, error, created_at, processed_at)
         VALUES (@id, @channel_id, @artifact_id, @status, @payload, @error, @created_at, @processed_at)`,
      ),
      getById: db.prepare(`SELECT * FROM intake_events WHERE id = ?`),
      update: db.prepare(
        `UPDATE intake_events SET status = @status, artifact_id = @artifact_id, error = @error, processed_at = @processed_at WHERE id = @id`,
      ),
      listByChannel: db.prepare(
        `SELECT * FROM intake_events WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
      ),
      listRecent: db.prepare(
        `SELECT * FROM intake_events ORDER BY created_at DESC LIMIT ?`,
      ),
      pruneOldest: db.prepare(
        `DELETE FROM intake_events WHERE channel_id = @channel_id AND id NOT IN (
           SELECT id FROM intake_events WHERE channel_id = @channel_id ORDER BY created_at DESC LIMIT @keep
         )`,
      ),
      countByChannel: db.prepare(
        `SELECT COUNT(*) as cnt FROM intake_events WHERE channel_id = ?`,
      ),
    };
  }

  create(event: Omit<IntakeEvent, "id" | "createdAt">): IntakeEvent {
    const id = crypto.randomUUID();
    const full: IntakeEvent = {
      ...event,
      id,
      createdAt: new Date(),
    };
    this.stmts.insert.run({
      id: full.id,
      channel_id: full.channelId,
      artifact_id: full.artifactId ?? null,
      status: full.status,
      payload: JSON.stringify(full.payload),
      error: full.error ?? null,
      created_at: full.createdAt.toISOString(),
      processed_at: full.processedAt?.toISOString() ?? null,
    });

    // Enforce retention policy
    const count = (this.stmts.countByChannel.get(full.channelId) as { cnt: number }).cnt;
    if (count > PersistentIntakeEventStore.MAX_EVENTS_PER_CHANNEL) {
      this.stmts.pruneOldest.run({
        channel_id: full.channelId,
        keep: PersistentIntakeEventStore.MAX_EVENTS_PER_CHANNEL,
      });
    }

    return full;
  }

  get(id: string): IntakeEvent | undefined {
    const row = this.stmts.getById.get(id) as IntakeEventRow | undefined;
    return row ? rowToIntakeEvent(row) : undefined;
  }

  update(id: string, updates: Partial<Pick<IntakeEvent, "status" | "artifactId" | "error" | "processedAt">>): IntakeEvent {
    const existing = this.get(id);
    if (!existing) throw new Error(`Intake event ${id} not found`);

    const updated: IntakeEvent = { ...existing, ...updates };
    this.stmts.update.run({
      id,
      status: updated.status,
      artifact_id: updated.artifactId ?? null,
      error: updated.error ?? null,
      processed_at: updated.processedAt?.toISOString() ?? null,
    });
    return updated;
  }

  listByChannel(channelId: string, limit = 50): IntakeEvent[] {
    const rows = this.stmts.listByChannel.all(channelId, limit) as IntakeEventRow[];
    return rows.map(rowToIntakeEvent);
  }

  listRecent(limit = 50): IntakeEvent[] {
    const rows = this.stmts.listRecent.all(limit) as IntakeEventRow[];
    return rows.map(rowToIntakeEvent);
  }
}

// ---------------------------------------------------------------------------
// PersistentRegistryPollerVersionStore
// ---------------------------------------------------------------------------

/**
 * Persists known registry versions so restarts don't re-trigger deployments
 * for already-seen artifact versions.
 */
export class PersistentRegistryPollerVersionStore {
  private stmts: {
    upsert: Database.Statement;
    listByChannel: Database.Statement;
    deleteByChannel: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT OR IGNORE INTO registry_poller_versions (channel_id, version_key, first_seen_at) VALUES (@channel_id, @version_key, @first_seen_at)`,
      ),
      listByChannel: db.prepare(
        `SELECT version_key FROM registry_poller_versions WHERE channel_id = ?`,
      ),
      deleteByChannel: db.prepare(
        `DELETE FROM registry_poller_versions WHERE channel_id = ?`,
      ),
    };
  }

  /** Record a version as known. Returns true if it was newly inserted (not previously seen). */
  addVersion(channelId: string, versionKey: string): boolean {
    const result = this.stmts.upsert.run({
      channel_id: channelId,
      version_key: versionKey,
      first_seen_at: new Date().toISOString(),
    });
    return result.changes > 0;
  }

  /** Load all known version keys for a channel. */
  getKnownVersions(channelId: string): Set<string> {
    const rows = this.stmts.listByChannel.all(channelId) as { version_key: string }[];
    return new Set(rows.map((r) => r.version_key));
  }

  /** Remove all known versions for a channel (e.g., when channel is deleted). */
  clearChannel(channelId: string): void {
    this.stmts.deleteByChannel.run(channelId);
  }
}

// ---------------------------------------------------------------------------
// PersistentFleetDeploymentStore
// ---------------------------------------------------------------------------

interface FleetDeploymentRow {
  id: string;
  artifact_id: string;
  artifact_version_id: string;
  environment_id: string;
  envoy_filter: string | null;
  rollout_config: string;
  representative_envoy_ids: string;
  representative_plan_id: string | null;
  status: string;
  validation_result: string | null;
  progress: string;
  created_at: string;
  updated_at: string;
}

function rowToFleetDeployment(row: FleetDeploymentRow): FleetDeployment {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    artifactVersionId: row.artifact_version_id,
    environmentId: row.environment_id,
    envoyFilter: row.envoy_filter ? safeJsonParse(row.envoy_filter, [], { table: "fleet_deployments", rowId: row.id, column: "envoy_filter" }) : undefined,
    rolloutConfig: safeJsonParse(row.rollout_config, {} as RolloutConfig, { table: "fleet_deployments", rowId: row.id, column: "rollout_config" }),
    representativeEnvoyIds: safeJsonParse(row.representative_envoy_ids, [], { table: "fleet_deployments", rowId: row.id, column: "representative_envoy_ids" }),
    representativePlanId: row.representative_plan_id ?? undefined,
    status: row.status as FleetDeploymentStatus,
    validationResult: row.validation_result ? safeJsonParse(row.validation_result, undefined, { table: "fleet_deployments", rowId: row.id, column: "validation_result" }) : undefined,
    progress: safeJsonParse(row.progress, { totalEnvoys: 0, validated: 0, executing: 0, succeeded: 0, failed: 0, pending: 0 } as FleetProgress, { table: "fleet_deployments", rowId: row.id, column: "progress" }),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * SQLite-backed fleet deployment store.
 *
 * Note: In-flight fleet operations that are mid-execution when the server
 * crashes cannot be resumed — their status is persisted, but the active
 * orchestration state (batch progress, in-flight envoy connections) is
 * ephemeral. On restart, in-flight operations will appear as stale entries
 * that users can inspect and manually re-trigger. Terminal states (completed,
 * failed, rolled_back) are fully durable.
 */
export class PersistentFleetDeploymentStore {
  private stmts: {
    upsert: Database.Statement;
    getById: Database.Statement;
    list: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      upsert: db.prepare(
        `INSERT INTO fleet_deployments (id, artifact_id, artifact_version_id, environment_id, envoy_filter, rollout_config, representative_envoy_ids, representative_plan_id, status, validation_result, progress, created_at, updated_at)
         VALUES (@id, @artifact_id, @artifact_version_id, @environment_id, @envoy_filter, @rollout_config, @representative_envoy_ids, @representative_plan_id, @status, @validation_result, @progress, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           validation_result = excluded.validation_result,
           progress = excluded.progress,
           representative_envoy_ids = excluded.representative_envoy_ids,
           representative_plan_id = excluded.representative_plan_id,
           updated_at = excluded.updated_at`,
      ),
      getById: db.prepare(`SELECT * FROM fleet_deployments WHERE id = ?`),
      list: db.prepare(`SELECT * FROM fleet_deployments ORDER BY created_at DESC`),
      deleteById: db.prepare(`DELETE FROM fleet_deployments WHERE id = ?`),
    };
  }

  create(deployment: FleetDeployment): FleetDeployment {
    this.stmts.upsert.run({
      id: deployment.id,
      artifact_id: deployment.artifactId,
      artifact_version_id: deployment.artifactVersionId,
      environment_id: deployment.environmentId,
      envoy_filter: deployment.envoyFilter ? JSON.stringify(deployment.envoyFilter) : null,
      rollout_config: JSON.stringify(deployment.rolloutConfig),
      representative_envoy_ids: JSON.stringify(deployment.representativeEnvoyIds),
      representative_plan_id: deployment.representativePlanId ?? null,
      status: deployment.status,
      validation_result: deployment.validationResult ? JSON.stringify(deployment.validationResult) : null,
      progress: JSON.stringify(deployment.progress),
      created_at: deployment.createdAt.toISOString(),
      updated_at: deployment.updatedAt.toISOString(),
    });
    return deployment;
  }

  getById(id: string): FleetDeployment | undefined {
    const row = this.stmts.getById.get(id) as FleetDeploymentRow | undefined;
    return row ? rowToFleetDeployment(row) : undefined;
  }

  update(deployment: FleetDeployment): FleetDeployment {
    deployment.updatedAt = new Date();
    this.stmts.upsert.run({
      id: deployment.id,
      artifact_id: deployment.artifactId,
      artifact_version_id: deployment.artifactVersionId,
      environment_id: deployment.environmentId,
      envoy_filter: deployment.envoyFilter ? JSON.stringify(deployment.envoyFilter) : null,
      rollout_config: JSON.stringify(deployment.rolloutConfig),
      representative_envoy_ids: JSON.stringify(deployment.representativeEnvoyIds),
      representative_plan_id: deployment.representativePlanId ?? null,
      status: deployment.status,
      validation_result: deployment.validationResult ? JSON.stringify(deployment.validationResult) : null,
      progress: JSON.stringify(deployment.progress),
      created_at: deployment.createdAt.toISOString(),
      updated_at: deployment.updatedAt.toISOString(),
    });
    return deployment;
  }

  list(): FleetDeployment[] {
    const rows = this.stmts.list.all() as FleetDeploymentRow[];
    return rows.map(rowToFleetDeployment);
  }

  delete(id: string): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }
}

// ---------------------------------------------------------------------------
// PersistentAlertWebhookStore — external monitoring webhook channels
// ---------------------------------------------------------------------------

interface AlertWebhookRow {
  id: string;
  name: string;
  source: string;
  enabled: number;
  auth_token: string;
  default_operation_type: string;
  default_intent: string | null;
  environment_id: string | null;
  partition_id: string | null;
  envoy_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToAlertWebhookChannel(row: AlertWebhookRow): AlertWebhookChannel {
  return {
    id: row.id,
    name: row.name,
    source: row.source as AlertWebhookSource,
    enabled: row.enabled === 1,
    authToken: row.auth_token,
    defaultOperationType: row.default_operation_type as AlertWebhookChannel["defaultOperationType"],
    defaultIntent: row.default_intent ?? undefined,
    environmentId: row.environment_id ?? undefined,
    partitionId: row.partition_id ?? undefined,
    envoyId: row.envoy_id ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class PersistentAlertWebhookStore {
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    getByToken: Database.Statement;
    list: Database.Statement;
    update: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(private db: Database.Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO alert_webhook_channels (id, name, source, enabled, auth_token, default_operation_type, default_intent, environment_id, partition_id, envoy_id, created_at, updated_at)
         VALUES (@id, @name, @source, @enabled, @auth_token, @default_operation_type, @default_intent, @environment_id, @partition_id, @envoy_id, @created_at, @updated_at)`,
      ),
      getById: db.prepare(`SELECT * FROM alert_webhook_channels WHERE id = ?`),
      getByToken: db.prepare(`SELECT * FROM alert_webhook_channels WHERE auth_token = ?`),
      list: db.prepare(`SELECT * FROM alert_webhook_channels ORDER BY created_at ASC`),
      update: db.prepare(
        `UPDATE alert_webhook_channels SET name = @name, source = @source, enabled = @enabled, default_operation_type = @default_operation_type, default_intent = @default_intent, environment_id = @environment_id, partition_id = @partition_id, envoy_id = @envoy_id, updated_at = @updated_at WHERE id = @id`,
      ),
      deleteById: db.prepare(`DELETE FROM alert_webhook_channels WHERE id = ?`),
    };
  }

  create(channel: Omit<AlertWebhookChannel, "id" | "createdAt" | "updatedAt">): AlertWebhookChannel {
    const id = crypto.randomUUID();
    const now = new Date();
    const full: AlertWebhookChannel = { ...channel, id, createdAt: now, updatedAt: now };
    this.stmts.insert.run({
      id: full.id,
      name: full.name,
      source: full.source,
      enabled: full.enabled ? 1 : 0,
      auth_token: full.authToken,
      default_operation_type: full.defaultOperationType,
      default_intent: full.defaultIntent ?? null,
      environment_id: full.environmentId ?? null,
      partition_id: full.partitionId ?? null,
      envoy_id: full.envoyId ?? null,
      created_at: full.createdAt.toISOString(),
      updated_at: full.updatedAt.toISOString(),
    });
    return full;
  }

  get(id: string): AlertWebhookChannel | undefined {
    const row = this.stmts.getById.get(id) as AlertWebhookRow | undefined;
    return row ? rowToAlertWebhookChannel(row) : undefined;
  }

  getByToken(token: string): AlertWebhookChannel | undefined {
    const row = this.stmts.getByToken.get(token) as AlertWebhookRow | undefined;
    return row ? rowToAlertWebhookChannel(row) : undefined;
  }

  list(): AlertWebhookChannel[] {
    const rows = this.stmts.list.all() as AlertWebhookRow[];
    return rows.map(rowToAlertWebhookChannel);
  }

  update(id: string, updates: Partial<Omit<AlertWebhookChannel, "id" | "authToken" | "createdAt" | "updatedAt">>): AlertWebhookChannel {
    const existing = this.get(id);
    if (!existing) throw new Error(`Alert webhook channel ${id} not found`);

    const updated: AlertWebhookChannel = { ...existing, ...updates, updatedAt: new Date() };
    this.stmts.update.run({
      id,
      name: updated.name,
      source: updated.source,
      enabled: updated.enabled ? 1 : 0,
      default_operation_type: updated.defaultOperationType,
      default_intent: updated.defaultIntent ?? null,
      environment_id: updated.environmentId ?? null,
      partition_id: updated.partitionId ?? null,
      envoy_id: updated.envoyId ?? null,
      updated_at: updated.updatedAt.toISOString(),
    });
    return updated;
  }

  delete(id: string): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }
}
