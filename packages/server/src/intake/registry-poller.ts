/**
 * Registry poller — periodically checks container and package registries
 * for new versions and emits intake events when new versions are found.
 *
 * Known versions are persisted via PersistentRegistryPollerVersionStore
 * so that server restarts don't re-trigger deployments for already-seen versions.
 */

import type { IntakeChannel, RegistryConfig } from "@synth-deploy/core";
import type { PersistentRegistryPollerVersionStore } from "@synth-deploy/core";
import type { WebhookPayload } from "./webhook-handlers.js";

export class RegistryPoller {
  private intervals = new Map<string, NodeJS.Timeout>();
  private knownVersions = new Map<string, Set<string>>();
  private onNewVersion: (channelId: string, payload: WebhookPayload) => Promise<void>;
  private versionStore?: PersistentRegistryPollerVersionStore;

  constructor(
    onNewVersion: (channelId: string, payload: WebhookPayload) => Promise<void>,
    versionStore?: PersistentRegistryPollerVersionStore,
  ) {
    this.onNewVersion = onNewVersion;
    this.versionStore = versionStore;
  }

  startPolling(channel: IntakeChannel): void {
    // Stop existing polling for this channel if any
    this.stopPolling(channel.id);

    const config = channel.config as unknown as RegistryConfig;
    const intervalMs = config.pollIntervalMs || 300_000; // Default: 5 minutes

    // Load persisted known versions, or initialize empty set
    if (!this.knownVersions.has(channel.id)) {
      if (this.versionStore) {
        this.knownVersions.set(channel.id, this.versionStore.getKnownVersions(channel.id));
      } else {
        this.knownVersions.set(channel.id, new Set());
      }
    }

    // Poll immediately on start
    this.poll(channel).catch((err) => {
      console.error(`[RegistryPoller] Initial poll failed for channel ${channel.id}:`, err);
    });

    // Set up interval
    const interval = setInterval(() => {
      this.poll(channel).catch((err) => {
        console.error(`[RegistryPoller] Poll failed for channel ${channel.id}:`, err);
      });
    }, intervalMs);

    this.intervals.set(channel.id, interval);
  }

  stopPolling(channelId: string): void {
    const interval = this.intervals.get(channelId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(channelId);
    }
  }

  stopAll(): void {
    for (const [id] of this.intervals) {
      this.stopPolling(id);
    }
  }

  /**
   * Record a version as known, both in memory and in the persistent store.
   * Returns true if the version was newly seen (not previously known).
   */
  private recordVersion(channelId: string, versionKey: string): boolean {
    const known = this.knownVersions.get(channelId) ?? new Set();
    if (known.has(versionKey)) return false;

    known.add(versionKey);
    this.knownVersions.set(channelId, known);
    this.versionStore?.addVersion(channelId, versionKey);
    return true;
  }

  private async poll(channel: IntakeChannel): Promise<void> {
    const config = channel.config as unknown as RegistryConfig;
    switch (config.type) {
      case "docker":
        await this.pollDockerRegistry(channel, config);
        break;
      case "npm":
        await this.pollNpmRegistry(channel, config);
        break;
      case "nuget":
        await this.pollNuGetRegistry(channel, config);
        break;
    }
  }

  /**
   * Poll a Docker registry for new image tags.
   * Uses the Docker Registry HTTP API V2.
   */
  private async pollDockerRegistry(channel: IntakeChannel, config: RegistryConfig): Promise<void> {
    const trackedImages = config.trackedImages ?? [];
    if (trackedImages.length === 0) return;

    const baseUrl = config.url.replace(/\/$/, "");
    const headers: Record<string, string> = {};
    if (config.credentials) {
      const auth = Buffer.from(`${config.credentials.username}:${config.credentials.password}`).toString("base64");
      headers["Authorization"] = `Basic ${auth}`;
    }

    for (const image of trackedImages) {
      try {
        const res = await fetch(`${baseUrl}/v2/${image}/tags/list`, { headers });
        if (!res.ok) continue;

        const data = await res.json() as { tags?: string[] };
        const tags = data.tags ?? [];
        const known = this.knownVersions.get(channel.id) ?? new Set();
        const isFirstPoll = known.size === 0;

        for (const tag of tags) {
          const key = `${image}:${tag}`;
          const isNew = this.recordVersion(channel.id, key);

          // Don't emit events on first poll (seed phase)
          if (isNew && !isFirstPoll) {
            await this.onNewVersion(channel.id, {
              artifactName: image,
              artifactType: "docker",
              version: tag,
              source: `docker-registry:${baseUrl}`,
              downloadUrl: `${baseUrl}/v2/${image}/manifests/${tag}`,
              metadata: { registry: baseUrl, image, tag },
            });
          }
        }
      } catch (err) {
        console.error(`[RegistryPoller] Docker poll error for ${image}:`, err);
      }
    }
  }

  /**
   * Poll the npm registry for new package versions.
   */
  private async pollNpmRegistry(channel: IntakeChannel, config: RegistryConfig): Promise<void> {
    const trackedPackages = config.trackedPackages ?? [];
    if (trackedPackages.length === 0) return;

    const baseUrl = config.url.replace(/\/$/, "") || "https://registry.npmjs.org";

    for (const pkg of trackedPackages) {
      try {
        const res = await fetch(`${baseUrl}/${encodeURIComponent(pkg)}`);
        if (!res.ok) continue;

        const data = await res.json() as { versions?: Record<string, unknown> };
        const versions = Object.keys(data.versions ?? {});
        const known = this.knownVersions.get(channel.id) ?? new Set();
        const isFirstPoll = known.size === 0;

        for (const version of versions) {
          const key = `${pkg}@${version}`;
          const isNew = this.recordVersion(channel.id, key);

          if (isNew && !isFirstPoll) {
            await this.onNewVersion(channel.id, {
              artifactName: pkg,
              artifactType: "npm",
              version,
              source: `npm-registry:${baseUrl}`,
              downloadUrl: `${baseUrl}/${encodeURIComponent(pkg)}/-/${pkg}-${version}.tgz`,
              metadata: { registry: baseUrl, package: pkg, version },
            });
          }
        }
      } catch (err) {
        console.error(`[RegistryPoller] npm poll error for ${pkg}:`, err);
      }
    }
  }

  /**
   * Poll a NuGet feed for new package versions.
   * Uses the NuGet V3 API.
   */
  private async pollNuGetRegistry(channel: IntakeChannel, config: RegistryConfig): Promise<void> {
    const trackedPackages = config.trackedPackages ?? [];
    if (trackedPackages.length === 0) return;

    const baseUrl = config.url.replace(/\/$/, "") || "https://api.nuget.org/v3";

    for (const pkg of trackedPackages) {
      try {
        // NuGet V3: flat container for version listing
        const res = await fetch(
          `${baseUrl}/flatcontainer/${pkg.toLowerCase()}/index.json`,
        );
        if (!res.ok) continue;

        const data = await res.json() as { versions?: string[] };
        const versions = data.versions ?? [];
        const known = this.knownVersions.get(channel.id) ?? new Set();
        const isFirstPoll = known.size === 0;

        for (const version of versions) {
          const key = `${pkg}@${version}`;
          const isNew = this.recordVersion(channel.id, key);

          if (isNew && !isFirstPoll) {
            await this.onNewVersion(channel.id, {
              artifactName: pkg,
              artifactType: "nuget",
              version,
              source: `nuget-registry:${baseUrl}`,
              metadata: { registry: baseUrl, package: pkg, version },
            });
          }
        }
      } catch (err) {
        console.error(`[RegistryPoller] NuGet poll error for ${pkg}:`, err);
      }
    }
  }
}
