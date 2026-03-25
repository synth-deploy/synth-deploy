import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  DeploymentId,
  PartitionId,
  EnvironmentId,
} from "@synth-deploy/core";
import type {
  EnvoyKnowledgeStore,
  LocalDeploymentRecord,
  EnvironmentSnapshot,
  StoredPlan,
  SystemKnowledgeEntry,
  SystemKnowledgeCategory,
} from "./knowledge-store.js";

// ---------------------------------------------------------------------------
// Schema version — bump when table definitions change
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Safe JSON parse — returns fallback on corruption instead of crashing
// ---------------------------------------------------------------------------

function safeJsonParse<T>(
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
    console.warn(`[Envoy] Corrupted JSON skipped${where}: ${json.slice(0, 120)}`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

function openKnowledgeDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // --- Integrity check ---
  try {
    const result = db.pragma("integrity_check") as { integrity_check: string }[];
    const status = result[0]?.integrity_check ?? "unknown";
    if (status !== "ok") {
      console.warn(
        `[Envoy] Database integrity check warning for ${dbPath}: ${status}`,
      );
    }
  } catch (err) {
    console.warn(
      `[Envoy] Could not run integrity check on ${dbPath}:`,
      err,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS deployment_records (
      deployment_id TEXT PRIMARY KEY,
      partition_id TEXT,
      environment_id TEXT,
      operation_id TEXT,
      version TEXT,
      variables TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      received_at TEXT NOT NULL,
      completed_at TEXT,
      workspace_path TEXT,
      failure_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS environment_snapshots (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      partition_id TEXT NOT NULL,
      current_version TEXT,
      current_deployment_id TEXT,
      active_variables TEXT NOT NULL DEFAULT '{}',
      last_updated TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_env_snapshots_partition_env
      ON environment_snapshots(partition_id, environment_id);

    CREATE TABLE IF NOT EXISTS stored_plans (
      id TEXT PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      artifact_name TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      rollback_plan TEXT NOT NULL,
      outcome TEXT NOT NULL,
      failure_analysis TEXT,
      executed_at TEXT NOT NULL,
      execution_duration_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plans_artifact_type ON stored_plans(artifact_type);
    CREATE INDEX IF NOT EXISTS idx_plans_environment ON stored_plans(environment_id);
    CREATE INDEX IF NOT EXISTS idx_plans_outcome ON stored_plans(outcome);

    CREATE TABLE IF NOT EXISTS system_knowledge (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      last_verified_at TEXT NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(category, key)
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
      `[Envoy] Schema version mismatch: database has v${versionRow.version}, expected v${SCHEMA_VERSION}`,
    );
  }

  return db;
}

// ---------------------------------------------------------------------------
// Row types — what SQLite gives us back
// ---------------------------------------------------------------------------

interface DeploymentRow {
  deployment_id: string;
  partition_id: string;
  environment_id: string;
  operation_id: string;
  version: string;
  variables: string;
  status: string;
  received_at: string;
  completed_at: string | null;
  workspace_path: string;
  failure_reason: string | null;
}

interface EnvironmentSnapshotRow {
  id: string;
  environment_id: string;
  partition_id: string;
  current_version: string | null;
  current_deployment_id: string | null;
  active_variables: string;
  last_updated: string;
}

interface StoredPlanRow {
  id: string;
  deployment_id: string;
  artifact_type: string;
  artifact_name: string;
  environment_id: string;
  plan: string;
  rollback_plan: string;
  outcome: string;
  failure_analysis: string | null;
  executed_at: string;
  execution_duration_ms: number;
}

interface SystemKnowledgeRow {
  id: string;
  category: string;
  key: string;
  value: string;
  discovered_at: string;
  last_verified_at: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Row converters
// ---------------------------------------------------------------------------

function rowToDeploymentRecord(row: DeploymentRow): LocalDeploymentRecord {
  return {
    deploymentId: row.deployment_id,
    partitionId: row.partition_id,
    environmentId: row.environment_id,
    operationId: row.operation_id,
    version: row.version,
    variables: safeJsonParse(row.variables, {}, {
      table: "deployment_records", rowId: row.deployment_id, column: "variables",
    }),
    status: row.status as LocalDeploymentRecord["status"],
    receivedAt: new Date(row.received_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    workspacePath: row.workspace_path,
    failureReason: row.failure_reason,
  };
}

function rowToEnvironmentSnapshot(row: EnvironmentSnapshotRow): EnvironmentSnapshot {
  return {
    id: row.id,
    environmentId: row.environment_id,
    partitionId: row.partition_id,
    currentVersion: row.current_version,
    currentDeploymentId: row.current_deployment_id,
    activeVariables: safeJsonParse(row.active_variables, {}, {
      table: "environment_snapshots", rowId: row.id, column: "active_variables",
    }),
    lastUpdated: new Date(row.last_updated),
  };
}

function rowToStoredPlan(row: StoredPlanRow): StoredPlan {
  const plan: StoredPlan = {
    id: row.id,
    deploymentId: row.deployment_id,
    artifactType: row.artifact_type,
    artifactName: row.artifact_name,
    environmentId: row.environment_id,
    plan: safeJsonParse(row.plan, { scriptedPlan: { platform: "bash", executionScript: "", dryRunScript: null, rollbackScript: null, reasoning: "", stepSummary: [] }, reasoning: "" }, {
      table: "stored_plans", rowId: row.id, column: "plan",
    }),
    rollbackPlan: safeJsonParse(row.rollback_plan, { scriptedPlan: { platform: "bash", executionScript: "", dryRunScript: null, rollbackScript: null, reasoning: "", stepSummary: [] }, reasoning: "" }, {
      table: "stored_plans", rowId: row.id, column: "rollback_plan",
    }),
    outcome: row.outcome as StoredPlan["outcome"],
    executedAt: new Date(row.executed_at),
    executionDurationMs: row.execution_duration_ms,
  };
  if (row.failure_analysis) {
    plan.failureAnalysis = row.failure_analysis;
  }
  return plan;
}

function rowToSystemKnowledge(row: SystemKnowledgeRow): SystemKnowledgeEntry {
  return {
    id: row.id,
    category: row.category as SystemKnowledgeCategory,
    key: row.key,
    value: safeJsonParse(row.value, {}, {
      table: "system_knowledge", rowId: row.id, column: "value",
    }),
    discoveredAt: new Date(row.discovered_at),
    lastVerifiedAt: new Date(row.last_verified_at),
    source: row.source,
  };
}

// ---------------------------------------------------------------------------
// PersistentEnvoyKnowledgeStore — SQLite-backed production store
// ---------------------------------------------------------------------------

/**
 * SQLite-backed implementation of EnvoyKnowledgeStore. This is the
 * production store — it persists everything the Envoy knows across
 * restarts, so the Envoy can reason about historical patterns and
 * recall what worked before.
 *
 * Follows the same patterns as packages/core/src/persistent-stores.ts:
 * prepared statements, safe JSON parsing, WAL mode, schema versioning.
 */
export class PersistentEnvoyKnowledgeStore implements EnvoyKnowledgeStore {
  private db: Database.Database;
  private stmts: {
    // Deployment records
    insertDeployment: Database.Statement;
    updateDeployment: Database.Statement;
    getDeployment: Database.Statement;
    getDeploymentsByPartition: Database.Statement;
    getDeploymentsByEnvironment: Database.Statement;
    listDeployments: Database.Statement;

    // Environment snapshots
    upsertEnvironment: Database.Statement;
    getEnvironment: Database.Statement;
    listEnvironments: Database.Statement;

    // Stored plans
    insertPlan: Database.Statement;
    getSuccessfulPlans: Database.Statement;
    getSuccessfulPlansByEnv: Database.Statement;
    getFailedPlans: Database.Statement;
    getFailedPlansByEnv: Database.Statement;
    getLatestPlan: Database.Statement;

    // System knowledge
    upsertKnowledge: Database.Statement;
    getKnowledgeByCategory: Database.Statement;
    getAllKnowledge: Database.Statement;
  };

  constructor(dbPath: string) {
    this.db = openKnowledgeDatabase(dbPath);

    this.stmts = {
      // Deployment records
      insertDeployment: this.db.prepare(`
        INSERT INTO deployment_records
          (deployment_id, partition_id, environment_id, operation_id, version,
           variables, status, received_at, completed_at, workspace_path, failure_reason)
        VALUES
          (@deployment_id, @partition_id, @environment_id, @operation_id, @version,
           @variables, @status, @received_at, @completed_at, @workspace_path, @failure_reason)
      `),

      updateDeployment: this.db.prepare(`
        UPDATE deployment_records
        SET status = @status, completed_at = @completed_at, failure_reason = @failure_reason
        WHERE deployment_id = @deployment_id
      `),

      getDeployment: this.db.prepare(
        `SELECT * FROM deployment_records WHERE deployment_id = ?`,
      ),

      getDeploymentsByPartition: this.db.prepare(
        `SELECT * FROM deployment_records WHERE partition_id = ? ORDER BY received_at DESC`,
      ),

      getDeploymentsByEnvironment: this.db.prepare(
        `SELECT * FROM deployment_records WHERE partition_id = ? AND environment_id = ? ORDER BY received_at DESC`,
      ),

      listDeployments: this.db.prepare(
        `SELECT * FROM deployment_records ORDER BY received_at DESC`,
      ),

      // Environment snapshots
      upsertEnvironment: this.db.prepare(`
        INSERT INTO environment_snapshots
          (id, environment_id, partition_id, current_version, current_deployment_id,
           active_variables, last_updated)
        VALUES
          (@id, @environment_id, @partition_id, @current_version, @current_deployment_id,
           @active_variables, @last_updated)
        ON CONFLICT(partition_id, environment_id) DO UPDATE SET
          current_version = excluded.current_version,
          current_deployment_id = excluded.current_deployment_id,
          active_variables = excluded.active_variables,
          last_updated = excluded.last_updated
      `),

      getEnvironment: this.db.prepare(
        `SELECT * FROM environment_snapshots WHERE partition_id = ? AND environment_id = ?`,
      ),

      listEnvironments: this.db.prepare(
        `SELECT * FROM environment_snapshots ORDER BY last_updated DESC`,
      ),

      // Stored plans
      insertPlan: this.db.prepare(`
        INSERT INTO stored_plans
          (id, deployment_id, artifact_type, artifact_name, environment_id,
           plan, rollback_plan, outcome, failure_analysis, executed_at, execution_duration_ms)
        VALUES
          (@id, @deployment_id, @artifact_type, @artifact_name, @environment_id,
           @plan, @rollback_plan, @outcome, @failure_analysis, @executed_at, @execution_duration_ms)
      `),

      getSuccessfulPlans: this.db.prepare(
        `SELECT * FROM stored_plans WHERE artifact_type = ? AND outcome = 'succeeded' ORDER BY executed_at DESC`,
      ),

      getSuccessfulPlansByEnv: this.db.prepare(
        `SELECT * FROM stored_plans WHERE artifact_type = ? AND outcome = 'succeeded' AND environment_id = ? ORDER BY executed_at DESC`,
      ),

      getFailedPlans: this.db.prepare(
        `SELECT * FROM stored_plans WHERE artifact_type = ? AND outcome = 'failed' ORDER BY executed_at DESC`,
      ),

      getFailedPlansByEnv: this.db.prepare(
        `SELECT * FROM stored_plans WHERE artifact_type = ? AND outcome = 'failed' AND environment_id = ? ORDER BY executed_at DESC`,
      ),

      getLatestPlan: this.db.prepare(
        `SELECT * FROM stored_plans WHERE artifact_type = ? AND environment_id = ? ORDER BY executed_at DESC LIMIT 1`,
      ),

      // System knowledge
      upsertKnowledge: this.db.prepare(`
        INSERT INTO system_knowledge
          (id, category, key, value, discovered_at, last_verified_at, source)
        VALUES
          (@id, @category, @key, @value, @discovered_at, @last_verified_at, @source)
        ON CONFLICT(category, key) DO UPDATE SET
          value = excluded.value,
          last_verified_at = excluded.last_verified_at,
          source = excluded.source
      `),

      getKnowledgeByCategory: this.db.prepare(
        `SELECT * FROM system_knowledge WHERE category = ? ORDER BY last_verified_at DESC`,
      ),

      getAllKnowledge: this.db.prepare(
        `SELECT * FROM system_knowledge ORDER BY category, key`,
      ),
    };
  }

  // -- Deployment records ---------------------------------------------------

  recordDeployment(params: {
    deploymentId: DeploymentId;
    partitionId: PartitionId;
    environmentId: EnvironmentId;
    operationId: string;
    version: string;
    variables: Record<string, string>;
    workspacePath: string;
  }): LocalDeploymentRecord {
    const now = new Date();
    const record: LocalDeploymentRecord = {
      ...params,
      status: "executing",
      receivedAt: now,
      completedAt: null,
      failureReason: null,
    };

    this.stmts.insertDeployment.run({
      deployment_id: params.deploymentId,
      partition_id: params.partitionId,
      environment_id: params.environmentId,
      operation_id: params.operationId,
      version: params.version,
      variables: JSON.stringify(params.variables),
      status: "executing",
      received_at: now.toISOString(),
      completed_at: null,
      workspace_path: params.workspacePath,
      failure_reason: null,
    });

    return record;
  }

  completeDeployment(
    deploymentId: DeploymentId,
    status: "succeeded" | "failed",
    failureReason: string | null = null,
  ): LocalDeploymentRecord | undefined {
    const row = this.stmts.getDeployment.get(deploymentId) as DeploymentRow | undefined;
    if (!row) return undefined;

    const now = new Date();
    this.stmts.updateDeployment.run({
      deployment_id: deploymentId,
      status,
      completed_at: now.toISOString(),
      failure_reason: failureReason,
    });

    return {
      ...rowToDeploymentRecord(row),
      status,
      completedAt: now,
      failureReason,
    };
  }

  getDeployment(id: DeploymentId): LocalDeploymentRecord | undefined {
    const row = this.stmts.getDeployment.get(id) as DeploymentRow | undefined;
    return row ? rowToDeploymentRecord(row) : undefined;
  }

  getDeploymentsByPartition(partitionId: PartitionId): LocalDeploymentRecord[] {
    const rows = this.stmts.getDeploymentsByPartition.all(partitionId) as DeploymentRow[];
    return rows.map(rowToDeploymentRecord);
  }

  getDeploymentsByEnvironment(
    partitionId: PartitionId,
    environmentId: EnvironmentId,
  ): LocalDeploymentRecord[] {
    const rows = this.stmts.getDeploymentsByEnvironment.all(
      partitionId,
      environmentId,
    ) as DeploymentRow[];
    return rows.map(rowToDeploymentRecord);
  }

  listDeployments(): LocalDeploymentRecord[] {
    const rows = this.stmts.listDeployments.all() as DeploymentRow[];
    return rows.map(rowToDeploymentRecord);
  }

  // -- Environment snapshots ------------------------------------------------

  updateEnvironment(
    partitionId: PartitionId,
    environmentId: EnvironmentId,
    update: {
      currentVersion: string;
      currentDeploymentId: DeploymentId;
      activeVariables: Record<string, string>;
    },
  ): EnvironmentSnapshot {
    // Check for existing to preserve the ID
    const existingRow = this.stmts.getEnvironment.get(
      partitionId,
      environmentId,
    ) as EnvironmentSnapshotRow | undefined;

    const now = new Date();
    const id = existingRow?.id ?? crypto.randomUUID();

    this.stmts.upsertEnvironment.run({
      id,
      environment_id: environmentId,
      partition_id: partitionId,
      current_version: update.currentVersion,
      current_deployment_id: update.currentDeploymentId,
      active_variables: JSON.stringify(update.activeVariables),
      last_updated: now.toISOString(),
    });

    return {
      id,
      environmentId,
      partitionId,
      currentVersion: update.currentVersion,
      currentDeploymentId: update.currentDeploymentId,
      activeVariables: { ...update.activeVariables },
      lastUpdated: now,
    };
  }

  getEnvironment(
    partitionId: PartitionId,
    environmentId: EnvironmentId,
  ): EnvironmentSnapshot | undefined {
    const row = this.stmts.getEnvironment.get(
      partitionId,
      environmentId,
    ) as EnvironmentSnapshotRow | undefined;
    return row ? rowToEnvironmentSnapshot(row) : undefined;
  }

  listEnvironments(): EnvironmentSnapshot[] {
    const rows = this.stmts.listEnvironments.all() as EnvironmentSnapshotRow[];
    return rows.map(rowToEnvironmentSnapshot);
  }

  // -- Plan retention -------------------------------------------------------

  storePlan(plan: StoredPlan): void {
    this.stmts.insertPlan.run({
      id: plan.id,
      deployment_id: plan.deploymentId,
      artifact_type: plan.artifactType,
      artifact_name: plan.artifactName,
      environment_id: plan.environmentId,
      plan: JSON.stringify(plan.plan),
      rollback_plan: JSON.stringify(plan.rollbackPlan),
      outcome: plan.outcome,
      failure_analysis: plan.failureAnalysis ?? null,
      executed_at: plan.executedAt.toISOString(),
      execution_duration_ms: plan.executionDurationMs,
    });
  }

  getSuccessfulPlans(
    artifactType: string,
    environmentId?: string,
  ): StoredPlan[] {
    const rows = environmentId
      ? (this.stmts.getSuccessfulPlansByEnv.all(artifactType, environmentId) as StoredPlanRow[])
      : (this.stmts.getSuccessfulPlans.all(artifactType) as StoredPlanRow[]);
    return rows.map(rowToStoredPlan);
  }

  getFailedPlans(
    artifactType: string,
    environmentId?: string,
  ): StoredPlan[] {
    const rows = environmentId
      ? (this.stmts.getFailedPlansByEnv.all(artifactType, environmentId) as StoredPlanRow[])
      : (this.stmts.getFailedPlans.all(artifactType) as StoredPlanRow[]);
    return rows.map(rowToStoredPlan);
  }

  getLatestPlan(
    artifactType: string,
    environmentId: string,
  ): StoredPlan | undefined {
    const row = this.stmts.getLatestPlan.get(
      artifactType,
      environmentId,
    ) as StoredPlanRow | undefined;
    return row ? rowToStoredPlan(row) : undefined;
  }

  // -- System knowledge -----------------------------------------------------

  recordSystemKnowledge(knowledge: SystemKnowledgeEntry): void {
    this.stmts.upsertKnowledge.run({
      id: knowledge.id,
      category: knowledge.category,
      key: knowledge.key,
      value: JSON.stringify(knowledge.value),
      discovered_at: knowledge.discoveredAt.toISOString(),
      last_verified_at: knowledge.lastVerifiedAt.toISOString(),
      source: knowledge.source,
    });
  }

  getSystemKnowledge(category: string): SystemKnowledgeEntry[] {
    const rows = this.stmts.getKnowledgeByCategory.all(category) as SystemKnowledgeRow[];
    return rows.map(rowToSystemKnowledge);
  }

  getAllSystemKnowledge(): SystemKnowledgeEntry[] {
    const rows = this.stmts.getAllKnowledge.all() as SystemKnowledgeRow[];
    return rows.map(rowToSystemKnowledge);
  }

  // -- Summary for health reporting -----------------------------------------

  getSummary(): {
    totalDeployments: number;
    succeeded: number;
    failed: number;
    executing: number;
    environments: number;
  } {
    const countRow = this.db
      .prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status = 'executing' THEN 1 ELSE 0 END) as executing
        FROM deployment_records`,
      )
      .get() as {
      total: number;
      succeeded: number;
      failed: number;
      executing: number;
    };

    const envCount = this.db
      .prepare(`SELECT COUNT(*) as count FROM environment_snapshots`)
      .get() as { count: number };

    return {
      totalDeployments: countRow.total ?? 0,
      succeeded: countRow.succeeded ?? 0,
      failed: countRow.failed ?? 0,
      executing: countRow.executing ?? 0,
      environments: envCount.count,
    };
  }

  /**
   * Close the database connection. Call this during graceful shutdown.
   */
  close(): void {
    this.db.close();
  }
}
