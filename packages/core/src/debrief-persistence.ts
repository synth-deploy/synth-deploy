import crypto from "node:crypto";
import Database from "better-sqlite3";
import type {
  AgentType,
  DecisionType,
  OperationId,
  DebriefEntry,
  DebriefEntryId,
  PartitionId,
} from "./types.js";
import type { DebriefRecordParams, DebriefWriter, DebriefReader, DebriefPinStore } from "./debrief.js";

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
  actor: string | null;
}

function rowToEntry(row: DebriefRow): DebriefEntry {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp),
    partitionId: row.partition_id,
    operationId: row.deployment_id,
    agent: row.agent as AgentType,
    decisionType: row.decision_type as DecisionType,
    decision: row.decision,
    reasoning: row.reasoning,
    context: JSON.parse(row.context),
    actor: row.actor ?? undefined,
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
 *
 * Full-text search via FTS5 virtual table on decision + reasoning + context.
 * Pin/bookmark via pinned_operations table.
 */
export class PersistentDecisionDebrief implements DebriefWriter, DebriefReader, DebriefPinStore {
  private db: Database.Database;
  private stmts: {
    insert: Database.Statement;
    insertFts: Database.Statement;
    getById: Database.Statement;
    getByOperation: Database.Statement;
    getByPartition: Database.Statement;
    getByType: Database.Statement;
    getByTimeRange: Database.Statement;
    getRecent: Database.Statement;
    search: Database.Statement;
    purgeOlderThan: Database.Statement;
    purgeFts: Database.Statement;
    countOlderThan: Database.Statement;
    pin: Database.Statement;
    unpin: Database.Statement;
    isPinned: Database.Statement;
    getPinned: Database.Statement;
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
        context TEXT NOT NULL DEFAULT '{}',
        actor TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_diary_deployment ON diary_entries(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_diary_partition ON diary_entries(partition_id);
      CREATE INDEX IF NOT EXISTS idx_diary_decision_type ON diary_entries(decision_type);
      CREATE INDEX IF NOT EXISTS idx_diary_timestamp ON diary_entries(timestamp);
    `);

    // Migration: add actor column to existing databases
    try {
      this.db.exec(`ALTER TABLE diary_entries ADD COLUMN actor TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }

    // FTS5 virtual table for full-text search across decision, reasoning, context
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS diary_fts USING fts5(
        id UNINDEXED,
        decision,
        reasoning,
        context,
        content='diary_entries',
        content_rowid='rowid'
      );
    `);

    // Backfill FTS for existing entries that haven't been indexed yet
    this.backfillFts();

    // Pinned operations table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pinned_operations (
        operation_id TEXT PRIMARY KEY,
        pinned_at TEXT NOT NULL
      );
    `);

    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO diary_entries (id, timestamp, partition_id, deployment_id, agent, decision_type, decision, reasoning, context, actor)
        VALUES (@id, @timestamp, @partition_id, @deployment_id, @agent, @decision_type, @decision, @reasoning, @context, @actor)
      `),
      insertFts: this.db.prepare(`
        INSERT INTO diary_fts (rowid, id, decision, reasoning, context)
        SELECT rowid, id, decision, reasoning, context FROM diary_entries WHERE id = ?
      `),
      getById: this.db.prepare(`SELECT * FROM diary_entries WHERE id = ?`),
      getByOperation: this.db.prepare(
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
      search: this.db.prepare(`
        SELECT d.* FROM diary_entries d
        JOIN diary_fts f ON d.id = f.id
        WHERE diary_fts MATCH ?
        ORDER BY d.timestamp DESC
        LIMIT ?
      `),
      purgeOlderThan: this.db.prepare(
        `DELETE FROM diary_entries WHERE timestamp < ?`,
      ),
      purgeFts: this.db.prepare(
        `DELETE FROM diary_fts WHERE id IN (SELECT id FROM diary_entries WHERE timestamp < ?)`,
      ),
      countOlderThan: this.db.prepare(
        `SELECT COUNT(*) as count FROM diary_entries WHERE timestamp < ?`,
      ),
      pin: this.db.prepare(
        `INSERT OR IGNORE INTO pinned_operations (operation_id, pinned_at) VALUES (?, ?)`,
      ),
      unpin: this.db.prepare(
        `DELETE FROM pinned_operations WHERE operation_id = ?`,
      ),
      isPinned: this.db.prepare(
        `SELECT 1 FROM pinned_operations WHERE operation_id = ?`,
      ),
      getPinned: this.db.prepare(
        `SELECT operation_id FROM pinned_operations ORDER BY pinned_at DESC`,
      ),
    };
  }

  private backfillFts(): void {
    try {
      // Incremental: only insert entries missing from FTS
      this.db.exec(`
        INSERT INTO diary_fts (rowid, id, decision, reasoning, context)
        SELECT e.rowid, e.id, e.decision, e.reasoning, e.context
        FROM diary_entries e
        WHERE e.id NOT IN (SELECT id FROM diary_fts)
      `);
    } catch {
      // FTS backfill is best-effort
    }
  }

  record(params: DebriefRecordParams): DebriefEntry {
    const entry: DebriefEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      partitionId: params.partitionId,
      operationId: params.operationId,
      agent: params.agent,
      decisionType: params.decisionType,
      decision: params.decision,
      reasoning: params.reasoning,
      context: params.context ?? {},
      actor: params.actor,
    };

    // Conversational query responses are excluded from the debrief.
    // The Debrief records actions and decisions, not LLM conversation history.
    // The entry object is still returned for caller convenience but is not persisted.
    if (params.isConversation) return entry;

    try {
      this.stmts.insert.run({
        id: entry.id,
        timestamp: entry.timestamp.toISOString(),
        partition_id: entry.partitionId,
        deployment_id: entry.operationId,
        agent: entry.agent,
        decision_type: entry.decisionType,
        decision: entry.decision,
        reasoning: entry.reasoning,
        context: JSON.stringify(entry.context),
        actor: entry.actor ?? null,
      });
      this.stmts.insertFts.run(entry.id);
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

  getByOperation(operationId: OperationId): DebriefEntry[] {
    try {
      const rows = this.stmts.getByOperation.all(operationId) as DebriefRow[];
      return rows.map(rowToEntry);
    } catch (error) {
      console.warn('Debrief read failed', { operation: 'getByOperation', operationId, error });
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

  search(query: string, limit = 50): DebriefEntry[] {
    try {
      // Sanitize query for FTS5: wrap each token in double quotes to treat as literal
      const sanitized = query
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => `"${token.replace(/"/g, '""')}"`)
        .join(" ");
      if (!sanitized) return [];
      const rows = this.stmts.search.all(sanitized, limit) as DebriefRow[];
      return rows.map(rowToEntry);
    } catch (error) {
      console.warn('Debrief search failed', { operation: 'search', query, error });
      return [];
    }
  }

  /**
   * Purge debrief entries older than the given date.
   * Returns the number of entries removed.
   */
  purgeOlderThan(cutoff: Date): number {
    try {
      const countRow = this.stmts.countOlderThan.get(cutoff.toISOString()) as { count: number };
      if (countRow.count === 0) return 0;

      const purge = this.db.transaction(() => {
        this.stmts.purgeFts.run(cutoff.toISOString());
        this.stmts.purgeOlderThan.run(cutoff.toISOString());
      });
      purge();
      return countRow.count;
    } catch (error) {
      console.error('Debrief purge failed', { operation: 'purgeOlderThan', cutoff, error });
      return 0;
    }
  }

  // --- Pin/Bookmark ---

  pinOperation(operationId: OperationId): void {
    this.stmts.pin.run(operationId, new Date().toISOString());
  }

  unpinOperation(operationId: OperationId): void {
    this.stmts.unpin.run(operationId);
  }

  isPinned(operationId: OperationId): boolean {
    return this.stmts.isPinned.get(operationId) != null;
  }

  getPinnedOperationIds(): OperationId[] {
    const rows = this.stmts.getPinned.all() as Array<{ operation_id: string }>;
    return rows.map((r) => r.operation_id);
  }

  close(): void {
    this.db.close();
  }
}
