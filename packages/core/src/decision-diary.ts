import crypto from "node:crypto";
import type {
  AgentType,
  DeploymentId,
  DiaryEntry,
  DiaryEntryId,
  TenantId,
} from "./types.js";

export interface DiaryWriter {
  record(params: {
    tenantId: TenantId | null;
    deploymentId: DeploymentId | null;
    agent: AgentType;
    decision: string;
    reasoning: string;
    context?: Record<string, unknown>;
  }): DiaryEntry;
}

export interface DiaryReader {
  getById(id: DiaryEntryId): DiaryEntry | undefined;
  getByDeployment(deploymentId: DeploymentId): DiaryEntry[];
  getByTenant(tenantId: TenantId): DiaryEntry[];
  getRecent(limit?: number): DiaryEntry[];
}

/**
 * In-memory Decision Diary. Every agent decision flows through here.
 * Backing store will move to a database once the data model stabilizes.
 */
export class DecisionDiary implements DiaryWriter, DiaryReader {
  private entries: Map<DiaryEntryId, DiaryEntry> = new Map();

  record(params: {
    tenantId: TenantId | null;
    deploymentId: DeploymentId | null;
    agent: AgentType;
    decision: string;
    reasoning: string;
    context?: Record<string, unknown>;
  }): DiaryEntry {
    const entry: DiaryEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      tenantId: params.tenantId,
      deploymentId: params.deploymentId,
      agent: params.agent,
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

  getRecent(limit = 50): DiaryEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, limit);
  }
}
