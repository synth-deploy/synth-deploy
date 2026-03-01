import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  AgentType,
  DecisionType,
  DeploymentId,
  DebriefEntry,
  DebriefEntryId,
  PartitionId,
} from "./types.js";
import type { DebriefRecordParams, DebriefWriter, DebriefReader } from "./debrief.js";

interface DebriefRow {
  id: string;
  timestamp: string;
  partition_id: string | null;
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
    partitionId: row.partition_id,
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
 *   - by partition (idx_diary_partition)
 *   - by decision type (idx_diary_decision_type)
 *   - by time range (idx_diary_timestamp)
 */
export class PersistentDecisionDebrief implements DebriefWriter, DebriefReader {
  private db: Database.Database;
  private stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    getByDeployment: Database.Statement;
    getByPartition: Database.Statement;
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
        partition_id TEXT,
        deployment_id TEXT,
        agent TEXT NOT NULL,
        decision_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        reasoning TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_diary_deployment ON diary_entries(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_diary_partition ON diary_entries(partition_id);
      CREATE INDEX IF NOT EXISTS idx_diary_decision_type ON diary_entries(decision_type);
      CREATE INDEX IF NOT EXISTS idx_diary_timestamp ON diary_entries(timestamp);
    `);

    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO diary_entries (id, timestamp, partition_id, deployment_id, agent, decision_type, decision, reasoning, context)
        VALUES (@id, @timestamp, @partition_id, @deployment_id, @agent, @decision_type, @decision, @reasoning, @context)
      `),
      getById: this.db.prepare(`SELECT * FROM diary_entries WHERE id = ?`),
      getByDeployment: this.db.prepare(
        `SELECT * FROM diary_entries WHERE deployment_id = ? ORDER BY timestamp ASC`,
      ),
      getByPartition: this.db.prepare(
        `SELECT * FROM diary_entries WHERE partition_id = ? ORDER BY timestamp ASC`,
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
      partitionId: params.partitionId,
      deploymentId: params.deploymentId,
      agent: params.agent,
      decisionType: params.decisionType,
      decision: params.decision,
      reasoning: params.reasoning,
      context: params.context ?? {},
    };

    try {
      this.stmts.insert.run({
        id: entry.id,
        timestamp: entry.timestamp.toISOString(),
        partition_id: entry.partitionId,
        deployment_id: entry.deploymentId,
        agent: entry.agent,
        decision_type: entry.decisionType,
        decision: entry.decision,
        reasoning: entry.reasoning,
        context: JSON.stringify(entry.context),
      });
    } catch (error) {
      console.error('Debrief persistence failed', { operation: 'record', entryId: entry.id, error });
      throw new Error(`Failed to persist debrief entry ${entry.id}: ${(error as Error).message}`);
    }

    return entry;
  }

  getById(id: DebriefEntryId): DebriefEntry | undefined {
    try {
      const row = this.stmts.getById.get(id) as DebriefRow | undefined;
      return row ? rowToEntry(row) : undefined;
    } catch (error) {
      console.warn('Debrief read failed', { operation: 'getById', id, error });
      return undefined;
    }
  }

  getByDeployment(deploymentId: DeploymentId): DebriefEntry[] {
    try {
      const rows = this.stmts.getByDeployment.all(deploymentId) as DebriefRow[];
      return rows.map(rowToEntry);
    } catch (error) {
      console.warn('Debrief read failed', { operation: 'getByDeployment', deploymentId, error });
      return [];
    }
  }

  getByPartition(partitionId: PartitionId): DebriefEntry[] {
    try {
      const rows = this.stmts.getByPartition.all(partitionId) as DebriefRow[];
      return rows.map(rowToEntry);
    } catch (error) {
      console.warn('Debrief read failed', { operation: 'getByPartition', partitionId, error });
      return [];
    }
  }

  getByType(decisionType: DecisionType): DebriefEntry[] {
    try {
      const rows = this.stmts.getByType.all(decisionType) as DebriefRow[];
      return rows.map(rowToEntry);
    } catch (error) {
      console.warn('Debrief read failed', { operation: 'getByType', decisionType, error });
      return [];
    }
  }

  getByTimeRange(from: Date, to: Date): DebriefEntry[] {
    try {
      const rows = this.stmts.getByTimeRange.all(
        from.toISOString(),
        to.toISOString(),
      ) as DebriefRow[];
      return rows.map(rowToEntry);
    } catch (error) {
      console.warn('Debrief read failed', { operation: 'getByTimeRange', from, to, error });
      return [];
    }
  }

  getRecent(limit = 50): DebriefEntry[] {
    try {
      const rows = this.stmts.getRecent.all(limit) as DebriefRow[];
      return rows.map(rowToEntry);
    } catch (error) {
      console.warn('Debrief read failed', { operation: 'getRecent', limit, error });
      return [];
    }
  }

  close(): void {
    this.db.close();
  }
}
