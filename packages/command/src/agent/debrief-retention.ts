import type { PersistentDecisionDebrief } from "@deploystack/core";

const DEFAULT_RETENTION_DAYS = Number(
  process.env.DEPLOYSTACK_DEBRIEF_RETENTION_DAYS ?? 90,
);

const DEFAULT_RETENTION_INTERVAL_MS = Number(
  process.env.DEPLOYSTACK_RETENTION_INTERVAL_MS ?? 24 * 60 * 60 * 1000, // daily
);

/**
 * Runs a single retention pass: purges debrief entries older than
 * the retention threshold.
 */
export function runRetentionPass(
  debrief: PersistentDecisionDebrief,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const purged = debrief.purgeOlderThan(cutoff);
  if (purged > 0) {
    console.log(`[debrief-retention] Purged ${purged} entries older than ${retentionDays} days`);
  }
  return purged;
}

/**
 * Starts a periodic retention scanner.
 * Returns a cleanup function to stop the interval.
 */
export function startRetentionScanner(
  debrief: PersistentDecisionDebrief,
  intervalMs: number = DEFAULT_RETENTION_INTERVAL_MS,
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): () => void {
  // Run once on startup
  runRetentionPass(debrief, retentionDays);

  const timer = setInterval(() => {
    runRetentionPass(debrief, retentionDays);
  }, intervalMs);

  return () => clearInterval(timer);
}
