import crypto from "node:crypto";
import type { ITelemetryStore } from "./store-interfaces.js";
import type { TelemetryEvent, TelemetryAction } from "./types.js";

/** In-memory telemetry store for testing. */
export class TelemetryStore implements ITelemetryStore {
  private events: TelemetryEvent[] = [];

  record(event: Omit<TelemetryEvent, "id" | "timestamp">): TelemetryEvent {
    const full: TelemetryEvent = {
      ...event,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };
    this.events.push(full);
    return full;
  }

  query(filters: {
    actor?: string;
    action?: TelemetryAction;
    from?: Date;
    to?: Date;
    limit?: number;
    offset?: number;
  }): TelemetryEvent[] {
    let results = [...this.events];
    if (filters.actor) results = results.filter((e) => e.actor === filters.actor);
    if (filters.action) results = results.filter((e) => e.action === filters.action);
    if (filters.from) results = results.filter((e) => e.timestamp >= filters.from!);
    if (filters.to) results = results.filter((e) => e.timestamp <= filters.to!);
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  count(filters?: { actor?: string; action?: TelemetryAction; from?: Date; to?: Date }): number {
    if (!filters) return this.events.length;
    let results = [...this.events];
    if (filters.actor) results = results.filter((e) => e.actor === filters.actor);
    if (filters.action) results = results.filter((e) => e.action === filters.action);
    if (filters.from) results = results.filter((e) => e.timestamp >= filters.from!);
    if (filters.to) results = results.filter((e) => e.timestamp <= filters.to!);
    return results.length;
  }
}
