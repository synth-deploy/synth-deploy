import crypto from "node:crypto";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorrectionRecord {
  timestamp: Date;
  field: string;
  from: string;
  to: string;
  artifactId: string;
}

export interface AnalysisPattern {
  id: string;
  source: string;
  artifactType: string;
  namePattern: string;
  corrections: CorrectionRecord[];
  derivedAnalysis: DerivedAnalysis;
  confidence: number;
  appliedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The subset of ArtifactAnalysis fields that can be derived from pattern
 * corrections. Each field is optional — only corrected fields are stored.
 */
export interface DerivedAnalysis {
  summary?: string;
  dependencies?: string[];
  configurationExpectations?: Record<string, string>;
  deploymentIntent?: string;
}

export interface PatternMatch {
  pattern: AnalysisPattern;
  /** "auto" when confidence >= 0.7 and >= 2 corrections; "suggest" otherwise */
  mode: "auto" | "suggest";
}

// ---------------------------------------------------------------------------
// Confidence calculation
// ---------------------------------------------------------------------------

const INITIAL_CORRECTION_CONFIDENCE = 0.5;
const CONSISTENT_CORRECTION_BOOST = 0.15;
const CONTRADICTION_RESET_CONFIDENCE = 0.5;
const MAX_CONFIDENCE = 0.95;

/**
 * Recomputes confidence from a correction history.
 *
 *   - First correction: 0.5
 *   - Each subsequent correction that agrees with the current value: +0.15
 *   - A contradictory correction (same field, different `to` value as the
 *     last correction for that field) resets to 0.5
 *   - Capped at 0.95
 */
export function computeConfidence(corrections: CorrectionRecord[]): number {
  if (corrections.length === 0) return 0;

  let confidence = INITIAL_CORRECTION_CONFIDENCE;
  // Track the latest `to` value per field to detect contradictions
  const latestByField = new Map<string, string>();

  for (const c of corrections) {
    const prev = latestByField.get(c.field);
    if (prev !== undefined && prev !== c.to) {
      // Contradictory correction — reset
      confidence = CONTRADICTION_RESET_CONFIDENCE;
    } else if (prev !== undefined) {
      // Consistent — boost
      confidence = Math.min(confidence + CONSISTENT_CORRECTION_BOOST, MAX_CONFIDENCE);
    }
    // First correction for this field — confidence stays at initial
    latestByField.set(c.field, c.to);
  }

  return Math.round(confidence * 100) / 100; // avoid floating-point noise
}

// ---------------------------------------------------------------------------
// SQLite row shape
// ---------------------------------------------------------------------------

interface PatternRow {
  id: string;
  source: string;
  artifact_type: string;
  name_pattern: string;
  corrections: string; // JSON
  derived_analysis: string; // JSON
  confidence: number;
  applied_count: number;
  created_at: string;
  updated_at: string;
}

function rowToPattern(row: PatternRow): AnalysisPattern {
  const corrections: CorrectionRecord[] = JSON.parse(row.corrections).map(
    (c: { timestamp: string; field: string; from: string; to: string; artifactId: string }) => ({
      ...c,
      timestamp: new Date(c.timestamp),
    }),
  );

  return {
    id: row.id,
    source: row.source,
    artifactType: row.artifact_type,
    namePattern: row.name_pattern,
    corrections,
    derivedAnalysis: JSON.parse(row.derived_analysis),
    confidence: row.confidence,
    appliedCount: row.applied_count,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ---------------------------------------------------------------------------
// PatternStore
// ---------------------------------------------------------------------------

/**
 * SQLite-backed storage for artifact analysis patterns.
 *
 * Patterns capture corrections users make to LLM-generated artifact analyses.
 * When enough consistent corrections accumulate for a given source + type +
 * name combination, the system can auto-apply the learned corrections instead
 * of re-running LLM analysis.
 */
export class PatternStore {
  private db: Database.Database;
  private stmts: {
    insert: Database.Statement;
    update: Database.Statement;
    getById: Database.Statement;
    findMatches: Database.Statement;
    incrementApplied: Database.Statement;
    listAll: Database.Statement;
    deleteById: Database.Statement;
  };

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analysis_patterns (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        name_pattern TEXT NOT NULL,
        corrections TEXT NOT NULL DEFAULT '[]',
        derived_analysis TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0,
        applied_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_patterns_source_type
        ON analysis_patterns(source, artifact_type);
      CREATE INDEX IF NOT EXISTS idx_patterns_confidence
        ON analysis_patterns(confidence);
    `);

    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO analysis_patterns
          (id, source, artifact_type, name_pattern, corrections, derived_analysis, confidence, applied_count, created_at, updated_at)
        VALUES
          (@id, @source, @artifact_type, @name_pattern, @corrections, @derived_analysis, @confidence, @applied_count, @created_at, @updated_at)
      `),
      update: this.db.prepare(`
        UPDATE analysis_patterns
        SET corrections = @corrections,
            derived_analysis = @derived_analysis,
            confidence = @confidence,
            updated_at = @updated_at
        WHERE id = @id
      `),
      getById: this.db.prepare(`SELECT * FROM analysis_patterns WHERE id = ?`),
      findMatches: this.db.prepare(`
        SELECT * FROM analysis_patterns
        WHERE source = @source AND artifact_type = @artifact_type
        ORDER BY confidence DESC
      `),
      incrementApplied: this.db.prepare(`
        UPDATE analysis_patterns
        SET applied_count = applied_count + 1, updated_at = @updated_at
        WHERE id = @id
      `),
      listAll: this.db.prepare(`SELECT * FROM analysis_patterns ORDER BY updated_at DESC`),
      deleteById: this.db.prepare(`DELETE FROM analysis_patterns WHERE id = ?`),
    };
  }

  /**
   * Record a correction against a pattern, creating the pattern if it doesn't
   * exist. Returns the updated pattern.
   */
  recordCorrection(
    key: { source: string; artifactType: string; namePattern: string },
    correction: Omit<CorrectionRecord, "timestamp">,
  ): AnalysisPattern {
    const now = new Date();
    const existing = this._findExact(key.source, key.artifactType, key.namePattern);

    if (existing) {
      const record: CorrectionRecord = { ...correction, timestamp: now };
      const corrections = [...existing.corrections, record];
      const confidence = computeConfidence(corrections);

      // Rebuild derived analysis from latest corrections
      const derivedAnalysis = this._buildDerivedAnalysis(corrections);

      this.stmts.update.run({
        id: existing.id,
        corrections: JSON.stringify(corrections),
        derived_analysis: JSON.stringify(derivedAnalysis),
        confidence,
        updated_at: now.toISOString(),
      });

      return {
        ...existing,
        corrections,
        derivedAnalysis: derivedAnalysis,
        confidence,
        updatedAt: now,
      };
    }

    // Create new pattern
    const record: CorrectionRecord = { ...correction, timestamp: now };
    const corrections = [record];
    const confidence = computeConfidence(corrections);
    const derivedAnalysis = this._buildDerivedAnalysis(corrections);
    const id = crypto.randomUUID();

    this.stmts.insert.run({
      id,
      source: key.source,
      artifact_type: key.artifactType,
      name_pattern: key.namePattern,
      corrections: JSON.stringify(corrections),
      derived_analysis: JSON.stringify(derivedAnalysis),
      confidence,
      applied_count: 0,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    return {
      id,
      source: key.source,
      artifactType: key.artifactType,
      namePattern: key.namePattern,
      corrections,
      derivedAnalysis: derivedAnalysis,
      confidence,
      appliedCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Find patterns matching a given artifact by source + type, then filter by
   * name glob match. Returns patterns sorted by confidence (descending).
   */
  findMatches(source: string, artifactType: string, artifactName: string): PatternMatch[] {
    const rows = this.stmts.findMatches.all({ source, artifact_type: artifactType }) as PatternRow[];
    const matches: PatternMatch[] = [];

    for (const row of rows) {
      const pattern = rowToPattern(row);
      if (this._globMatch(pattern.namePattern, artifactName)) {
        const autoApply =
          pattern.corrections.length >= 2 && pattern.confidence >= 0.7;
        matches.push({
          pattern,
          mode: autoApply ? "auto" : "suggest",
        });
      }
    }

    return matches;
  }

  /**
   * Record that a pattern was applied to an artifact.
   */
  recordApplication(patternId: string): void {
    this.stmts.incrementApplied.run({
      id: patternId,
      updated_at: new Date().toISOString(),
    });
  }

  /**
   * Get a pattern by ID.
   */
  getById(id: string): AnalysisPattern | undefined {
    const row = this.stmts.getById.get(id) as PatternRow | undefined;
    return row ? rowToPattern(row) : undefined;
  }

  /**
   * List all patterns, most recently updated first.
   */
  listAll(): AnalysisPattern[] {
    const rows = this.stmts.listAll.all() as PatternRow[];
    return rows.map(rowToPattern);
  }

  /**
   * Delete a pattern.
   */
  delete(id: string): boolean {
    const result = this.stmts.deleteById.run(id);
    return result.changes > 0;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _findExact(
    source: string,
    artifactType: string,
    namePattern: string,
  ): AnalysisPattern | undefined {
    const rows = this.stmts.findMatches.all({ source, artifact_type: artifactType }) as PatternRow[];
    for (const row of rows) {
      if (row.name_pattern === namePattern) {
        return rowToPattern(row);
      }
    }
    return undefined;
  }

  /**
   * Build a DerivedAnalysis by taking the latest correction `to` value for
   * each known field. Supports: summary, deploymentIntent, dependencies
   * (comma-separated), and configurationExpectations (key=value).
   */
  private _buildDerivedAnalysis(corrections: CorrectionRecord[]): DerivedAnalysis {
    const derived: DerivedAnalysis = {};
    const latestByField = new Map<string, string>();

    for (const c of corrections) {
      latestByField.set(c.field, c.to);
    }

    for (const [field, value] of latestByField) {
      switch (field) {
        case "summary":
          derived.summary = value;
          break;
        case "deploymentIntent":
          derived.deploymentIntent = value;
          break;
        case "dependencies":
          derived.dependencies = value.split(",").map((d) => d.trim()).filter(Boolean);
          break;
        default:
          // Treat as a configuration expectation
          if (field.startsWith("config.")) {
            if (!derived.configurationExpectations) {
              derived.configurationExpectations = {};
            }
            derived.configurationExpectations[field.slice("config.".length)] = value;
          }
          break;
      }
    }

    return derived;
  }

  /**
   * Simple glob matching: supports `*` (any characters) and `?` (single char).
   * Used to match artifact names against stored name patterns.
   */
  private _globMatch(pattern: string, name: string): boolean {
    // Escape regex special chars except * and ?
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${regexStr}$`).test(name);
  }
}
