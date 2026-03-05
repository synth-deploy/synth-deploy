/**
 * Registry poller — periodically checks container and package registries
 * for new versions and emits intake events when new versions are found.
 */

import type { IntakeChannel, RegistryConfig } from "@deploystack/core";
import type { WebhookPayload } from "./webhook-handlers.js";

export class RegistryPoller {
  private intervals = new Map<string, NodeJS.Timeout>();
  private knownVersions = new Map<string, Set<string>>();
  private onNewVersion: (channelId: string, payload: WebhookPayload) => Promise<void>;

  constructor(onNewVersion: (channelId: string, payload: WebhookPayload) => Promise<void>) {
    this.onNewVersion = onNewVersion;
  }

  startPolling(channel: IntakeChannel): void {
    // Stop existing polling for this channel if any
    this.stopPolling(channel.id);

    const config = channel.config as unknown as RegistryConfig;
    const intervalMs = config.pollIntervalMs || 300_000; // Default: 5 minutes

    // Initialize known versions set
    if (!this.knownVersions.has(channel.id)) {
      this.knownVersions.set(channel.id, new Set());
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

        for (const tag of tags) {
          const key = `${image}:${tag}`;
          if (!known.has(key)) {
            known.add(key);
            // Skip emitting on first poll (seed known versions)
            if (known.size > tags.length) {
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
        }

        this.knownVersions.set(channel.id, known);
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

        for (const version of versions) {
          const key = `${pkg}@${version}`;
          if (!known.has(key)) {
            known.add(key);
            if (known.size > versions.length) {
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
        }

        this.knownVersions.set(channel.id, known);
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

        for (const version of versions) {
          const key = `${pkg}@${version}`;
          if (!known.has(key)) {
            known.add(key);
            if (known.size > versions.length) {
              await this.onNewVersion(channel.id, {
                artifactName: pkg,
                artifactType: "nuget",
                version,
                source: `nuget-registry:${baseUrl}`,
                metadata: { registry: baseUrl, package: pkg, version },
              });
            }
          }
        }

        this.knownVersions.set(channel.id, known);
      } catch (err) {
        console.error(`[RegistryPoller] NuGet poll error for ${pkg}:`, err);
      }
    }
  }
}
