import crypto from "node:crypto";
import type {
  AgentType,
  DecisionType,
  OperationId,
  DebriefEntry,
  DebriefEntryId,
  PartitionId,
} from "./types.js";

export interface DebriefRecordParams {
  partitionId: PartitionId | null;
  operationId: OperationId | null;
  agent: AgentType;
  decisionType: DecisionType;
  decision: string;
  reasoning: string;
  context?: Record<string, unknown>;
  actor?: string;
  /**
   * When true, this entry is a conversational query response (e.g. from queryAgent)
   * and will NOT be recorded in the debrief. The Debrief records actions, decisions,
   * and the information that informed them — not LLM conversation history.
   */
  isConversation?: boolean;
}

export interface DebriefWriter {
  record(params: DebriefRecordParams): DebriefEntry;
}

export interface DebriefReader {
  getById(id: DebriefEntryId): DebriefEntry | undefined;
  getByOperation(operationId: OperationId): DebriefEntry[];
  getByPartition(partitionId: PartitionId): DebriefEntry[];
  getByType(decisionType: DecisionType): DebriefEntry[];
  getByTimeRange(from: Date, to: Date): DebriefEntry[];
  getRecent(limit?: number): DebriefEntry[];
  /** Full-text search across decision, reasoning, and context fields */
  search(query: string, limit?: number): DebriefEntry[];
}

export interface DebriefPinStore {
  pinOperation(operationId: OperationId): void;
  unpinOperation(operationId: OperationId): void;
  isPinned(operationId: OperationId): boolean;
  getPinnedOperationIds(): OperationId[];
}

/**
 * In-memory Decision Debrief. Every agent decision flows through here.
 * Use PersistentDecisionDebrief for durable storage that survives restarts.
 */
export class DecisionDebrief implements DebriefWriter, DebriefReader {
  private entries: Map<DebriefEntryId, DebriefEntry> = new Map();

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
    // The entry object is still returned for caller convenience but is not stored.
    if (!params.isConversation) {
      this.entries.set(entry.id, entry);
    }

    return entry;
  }

  getById(id: DebriefEntryId): DebriefEntry | undefined {
    return this.entries.get(id);
  }

  getByOperation(operationId: OperationId): DebriefEntry[] {
    return [...this.entries.values()].filter(
      (e) => e.operationId === operationId,
    );
  }

  getByPartition(partitionId: PartitionId): DebriefEntry[] {
    return [...this.entries.values()].filter((e) => e.partitionId === partitionId);
  }

  getByType(decisionType: DecisionType): DebriefEntry[] {
    return [...this.entries.values()].filter(
      (e) => e.decisionType === decisionType,
    );
  }

  getByTimeRange(from: Date, to: Date): DebriefEntry[] {
    return [...this.entries.values()]
      .filter(
        (e) => e.timestamp >= from && e.timestamp <= to,
      )
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  getRecent(limit = 50): DebriefEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }

  search(query: string, limit = 50): DebriefEntry[] {
    const lower = query.toLowerCase();
    return [...this.entries.values()]
      .filter((e) =>
        e.decision.toLowerCase().includes(lower) ||
        e.reasoning.toLowerCase().includes(lower) ||
        JSON.stringify(e.context).toLowerCase().includes(lower),
      )
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }
}
