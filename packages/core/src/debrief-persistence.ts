import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  AgentType,
  DecisionType,
  DeploymentId,
  DebriefEntry,
  DebriefEntryId,
  TenantId,
} from "./types.js";
import type { DebriefRecordParams, DebriefWriter, DebriefReader } from "./debrief.js";

interface DebriefRow {
  id: string;
  timestamp: string;
  tenant_id: string | null;
  deployment_id: string | null;
  agent: string;
  decision_type: string;
  decision: string;
  reasoning: string;
  context: string;
}

function rowToEntry(row: DebriefRow): DebriefEntry {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp),
    tenantId: row.tenant_id,
    deploymentId: row.deployment_id,
    agent: row.agent as AgentType,
    decisionType: row.decision_type as DecisionType,
    decision: row.decision,
    reasoning: row.reasoning,
    context: JSON.parse(row.context),
  };
}

/**
 * SQLite-backed Decision Debrief. Entries survive server restarts.
 *
 * Uses better-sqlite3 for synchronous, single-file persistence --
 * no database server, no async overhead, and the same DebriefWriter/DebriefReader
 * interfaces as the in-memory implementation.
 *
 * Indexes support all four query dimensions:
 *   - by deployment (idx_diary_deployment)
 *   - by tenant (idx_diary_tenant)
 *   - by decision type (idx_diary_decision_type)
 *   - by time range (idx_diary_timestamp)
 */
export class PersistentDecisionDebrief implements DebriefWriter, DebriefReader {
  private db: Database.Database;
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    getByDeployment: Database.Statement;
    getByTenant: Database.Statement;
    getByType: Database.Statement;
    getByTimeRange: Database.Statement;
    getRecent: Database.Statement;
  };

  constructor(dbPath: string) {
    this.db = new Database(dbPath);

    // WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS diary_entries (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        tenant_id TEXT,
        deployment_id TEXT,
        agent TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_diary_deployment ON diary_entries(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_diary_tenant ON diary_entries(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_diary_decision_type ON diary_entries(decision_type);
      CREATE INDEX IF NOT EXISTS idx_diary_timestamp ON diary_entries(timestamp);
    `);

    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO diary_entries (id, timestamp, tenant_id, deployment_id, agent, decision_type, decision, reasoning, context)
        VALUES (@id, @timestamp, @tenant_id, @deployment_id, @agent, @decision_type, @decision, @reasoning, @context)
      `),
      getById: this.db.prepare(`SELECT * FROM diary_entries WHERE id = ?`),
      getByDeployment: this.db.prepare(
        `SELECT * FROM diary_entries WHERE deployment_id = ? ORDER BY timestamp ASC`,
      ),
      getByTenant: this.db.prepare(
        `SELECT * FROM diary_entries WHERE tenant_id = ? ORDER BY timestamp ASC`,
      ),
      getByType: this.db.prepare(
        `SELECT * FROM diary_entries WHERE decision_type = ? ORDER BY timestamp ASC`,
      ),
      getByTimeRange: this.db.prepare(
        `SELECT * FROM diary_entries WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
      ),
      getRecent: this.db.prepare(
        `SELECT * FROM diary_entries ORDER BY timestamp DESC LIMIT ?`,
      ),
    };
  }

  record(params: DebriefRecordParams): DebriefEntry {
    const entry: DebriefEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      tenantId: params.tenantId,
      deploymentId: params.deploymentId,
      agent: params.agent,
      decisionType: params.decisionType,
      decision: params.decision,
      reasoning: params.reasoning,
      context: params.context ?? {},
    };

    this.stmts.insert.run({
      id: entry.id,
      timestamp: entry.timestamp.toISOString(),
      tenant_id: entry.tenantId,
      deployment_id: entry.deploymentId,
      agent: entry.agent,
      decision_type: entry.decisionType,
      decision: entry.decision,
      reasoning: entry.reasoning,
      context: JSON.stringify(entry.context),
    });

    return entry;
  }

  getById(id: DebriefEntryId): DebriefEntry | undefined {
    const row = this.stmts.getById.get(id) as DebriefRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  getByDeployment(deploymentId: DeploymentId): DebriefEntry[] {
    const rows = this.stmts.getByDeployment.all(deploymentId) as DebriefRow[];
    return rows.map(rowToEntry);
  }

  getByTenant(tenantId: TenantId): DebriefEntry[] {
    const rows = this.stmts.getByTenant.all(tenantId) as DebriefRow[];
    return rows.map(rowToEntry);
  }

  getByType(decisionType: DecisionType): DebriefEntry[] {
    const rows = this.stmts.getByType.all(decisionType) as DebriefRow[];
    return rows.map(rowToEntry);
  }

  getByTimeRange(from: Date, to: Date): DebriefEntry[] {
    const rows = this.stmts.getByTimeRange.all(
      from.toISOString(),
      to.toISOString(),
    ) as DebriefRow[];
    return rows.map(rowToEntry);
  }

  getRecent(limit = 50): DebriefEntry[] {
    const rows = this.stmts.getRecent.all(limit) as DebriefRow[];
    return rows.map(rowToEntry);
  }

  close(): void {
    this.db.close();
  }
}
