import type { EnvoyRegistryEntry } from "../agent/envoy-registry.js";

/**
 * Maximum number of representative envoys to select for plan validation.
 * Keeps validation fast while covering platform diversity.
 */
const MAX_REPRESENTATIVES = 3;

/**
 * Select a representative subset of envoys for plan validation.
 *
 * Strategy:
 * 1. Filter to healthy envoys only (health === "OK")
 * 2. Group by platform (e.g. linux, darwin, windows)
 * 3. Pick one per platform group, preferring most recently seen
 * 4. Cap at MAX_REPRESENTATIVES
 * 5. If all envoys share the same platform, pick 1
 *
 * Returns an array of envoy IDs.
 */
export function selectRepresentatives(
  envoys: EnvoyRegistryEntry[],
  _artifactId: string,
): string[] {
  // 1. Filter to healthy envoys
  const healthy = envoys.filter((e) => e.health === "OK");
  if (healthy.length === 0) return [];

  // 2. Group by platform
  const byPlatform = new Map<string, EnvoyRegistryEntry[]>();
  for (const envoy of healthy) {
    // Normalize: null/undefined platform treated as "unknown"
    const platform = (envoy as { platform?: string | null }).platform ?? "unknown";
    const group = byPlatform.get(platform) ?? [];
    group.push(envoy);
    byPlatform.set(platform, group);
  }

  // 3. If all same platform, pick the most recently seen one
  if (byPlatform.size <= 1) {
    const best = pickMostRecentlySeen(healthy);
    return best ? [best.id] : [];
  }

  // 4. Pick one per platform group (prefer most recently seen)
  const representatives: EnvoyRegistryEntry[] = [];
  for (const group of byPlatform.values()) {
    const best = pickMostRecentlySeen(group);
    if (best) representatives.push(best);
  }

  // 5. Cap at MAX_REPRESENTATIVES (sort by lastSeen descending, take top N)
  representatives.sort((a, b) => {
    const aTime = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
    const bTime = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
    return bTime - aTime;
  });

  return representatives.slice(0, MAX_REPRESENTATIVES).map((e) => e.id);
}

/**
 * Pick the envoy with the most recent `lastSeen` timestamp from a group.
 */
function pickMostRecentlySeen(
  group: EnvoyRegistryEntry[],
): EnvoyRegistryEntry | undefined {
  if (group.length === 0) return undefined;
  if (group.length === 1) return group[0];

  let best = group[0];
  let bestTime = best.lastSeen ? new Date(best.lastSeen).getTime() : 0;

  for (let i = 1; i < group.length; i++) {
    const t = group[i].lastSeen ? new Date(group[i].lastSeen!).getTime() : 0;
    if (t > bestTime) {
      best = group[i];
      bestTime = t;
    }
  }

  return best;
}
