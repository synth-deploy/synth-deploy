import crypto from "node:crypto";
import type {
  AgentType,
  DecisionType,
  DeploymentId,
  DebriefEntry,
  DebriefEntryId,
  PartitionId,
} from "./types.js";

export interface DebriefRecordParams {
  partitionId: PartitionId | null;
  deploymentId: DeploymentId | null;
  agent: AgentType;
  decisionType: DecisionType;
  decision: string;
  reasoning: string;
  context?: Record<string, unknown>;
}

export interface DebriefWriter {
  record(params: DebriefRecordParams): DebriefEntry;
}

export interface DebriefReader {
  getById(id: DebriefEntryId): DebriefEntry | undefined;
  getByDeployment(deploymentId: DeploymentId): DebriefEntry[];
  getByPartition(partitionId: PartitionId): DebriefEntry[];
  getByType(decisionType: DecisionType): DebriefEntry[];
  getByTimeRange(from: Date, to: Date): DebriefEntry[];
  getRecent(limit?: number): DebriefEntry[];
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
      deploymentId: params.deploymentId,
      agent: params.agent,
      decisionType: params.decisionType,
      decision: params.decision,
      reasoning: params.reasoning,
      context: params.context ?? {},
    };
    this.entries.set(entry.id, entry);
    return entry;
  }

  getById(id: DebriefEntryId): DebriefEntry | undefined {
    return this.entries.get(id);
  }

  getByDeployment(deploymentId: DeploymentId): DebriefEntry[] {
    return [...this.entries.values()].filter(
      (e) => e.deploymentId === deploymentId,
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
}
