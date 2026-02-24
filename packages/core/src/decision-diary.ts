import crypto from "node:crypto";
import type {
  AgentType,
  DecisionType,
  DeploymentId,
  DiaryEntry,
  DiaryEntryId,
  TenantId,
} from "./types.js";

export interface DiaryRecordParams {
  tenantId: TenantId | null;
  deploymentId: DeploymentId | null;
  agent: AgentType;
  decisionType: DecisionType;
  decision: string;
  reasoning: string;
  context?: Record<string, unknown>;
}

export interface DiaryWriter {
  record(params: DiaryRecordParams): DiaryEntry;
}

export interface DiaryReader {
  getById(id: DiaryEntryId): DiaryEntry | undefined;
  getByDeployment(deploymentId: DeploymentId): DiaryEntry[];
  getByTenant(tenantId: TenantId): DiaryEntry[];
  getByType(decisionType: DecisionType): DiaryEntry[];
  getByTimeRange(from: Date, to: Date): DiaryEntry[];
  getRecent(limit?: number): DiaryEntry[];
}

/**
 * In-memory Decision Diary. Every agent decision flows through here.
 * Use PersistentDecisionDiary for durable storage that survives restarts.
 */
export class DecisionDiary implements DiaryWriter, DiaryReader {
  private entries: Map<DiaryEntryId, DiaryEntry> = new Map();

  record(params: DiaryRecordParams): DiaryEntry {
    const entry: DiaryEntry = {
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
    this.entries.set(entry.id, entry);
    return entry;
  }

  getById(id: DiaryEntryId): DiaryEntry | undefined {
    return this.entries.get(id);
  }

  getByDeployment(deploymentId: DeploymentId): DiaryEntry[] {
    return [...this.entries.values()].filter(
      (e) => e.deploymentId === deploymentId,
    );
  }

  getByTenant(tenantId: TenantId): DiaryEntry[] {
    return [...this.entries.values()].filter((e) => e.tenantId === tenantId);
  }

  getByType(decisionType: DecisionType): DiaryEntry[] {
    return [...this.entries.values()].filter(
      (e) => e.decisionType === decisionType,
    );
  }

  getByTimeRange(from: Date, to: Date): DiaryEntry[] {
    return [...this.entries.values()]
      .filter(
        (e) => e.timestamp >= from && e.timestamp <= to,
      )
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  getRecent(limit = 50): DiaryEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }
}
