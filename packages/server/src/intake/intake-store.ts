/**
 * In-memory stores for intake channels and events.
 */

import crypto from "node:crypto";
import type { IntakeChannel, IntakeEvent } from "@synth-deploy/core";

// ---------------------------------------------------------------------------
// IntakeChannelStore
// ---------------------------------------------------------------------------

export class IntakeChannelStore {
  private channels = new Map<string, IntakeChannel>();

  create(channel: Omit<IntakeChannel, "id" | "createdAt" | "updatedAt">): IntakeChannel {
    const id = crypto.randomUUID();
    const now = new Date();
    const full: IntakeChannel = {
      ...channel,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.channels.set(id, full);
    return full;
  }

  get(id: string): IntakeChannel | undefined {
    return this.channels.get(id);
  }

  getByToken(token: string): IntakeChannel | undefined {
    for (const channel of this.channels.values()) {
      if (channel.authToken === token) return channel;
    }
    return undefined;
  }

  list(): IntakeChannel[] {
    return [...this.channels.values()];
  }

  update(id: string, updates: Partial<Pick<IntakeChannel, "name" | "enabled" | "config" | "lastPolledAt">>): IntakeChannel {
    const existing = this.channels.get(id);
    if (!existing) throw new Error(`Intake channel ${id} not found`);

    const updated: IntakeChannel = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };
    this.channels.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.channels.delete(id);
  }
}

// ---------------------------------------------------------------------------
// IntakeEventStore
// ---------------------------------------------------------------------------

export class IntakeEventStore {
  private events = new Map<string, IntakeEvent>();

  create(event: Omit<IntakeEvent, "id" | "createdAt">): IntakeEvent {
    const id = crypto.randomUUID();
    const full: IntakeEvent = {
      ...event,
      id,
      createdAt: new Date(),
    };
    this.events.set(id, full);
    return full;
  }

  get(id: string): IntakeEvent | undefined {
    return this.events.get(id);
  }

  update(id: string, updates: Partial<Pick<IntakeEvent, "status" | "artifactId" | "error" | "processedAt">>): IntakeEvent {
    const existing = this.events.get(id);
    if (!existing) throw new Error(`Intake event ${id} not found`);

    const updated: IntakeEvent = { ...existing, ...updates };
    this.events.set(id, updated);
    return updated;
  }

  listByChannel(channelId: string, limit = 50): IntakeEvent[] {
    return [...this.events.values()]
      .filter((e) => e.channelId === channelId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  listRecent(limit = 50): IntakeEvent[] {
    return [...this.events.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
