/**
 * Intake processor — takes a normalized webhook payload and creates
 * or updates artifacts and versions in the artifact store.
 */

import type { IArtifactStore } from "@synth-deploy/core";
import type { ArtifactAnalyzer } from "../artifact-analyzer.js";
import { detectArtifactType } from "../artifact-analyzer.js";
import type { WebhookPayload } from "./webhook-handlers.js";

export class IntakeProcessor {
  constructor(
    private artifactStore: IArtifactStore,
    private analyzer?: ArtifactAnalyzer,
  ) {}

  async process(
    payload: WebhookPayload,
    channelId: string,
  ): Promise<{ artifactId: string; versionId: string }> {
    // 1. Find existing artifact by name, or create a new one
    const existing = this.artifactStore
      .list()
      .find((a) => a.name === payload.artifactName);

    let artifactId: string;

    if (existing) {
      artifactId = existing.id;
    } else {
      const artifact = this.artifactStore.create({
        name: payload.artifactName,
        type: payload.artifactType,
        analysis: {
          summary: `Auto-ingested artifact from ${payload.source}`,
          dependencies: [],
          configurationExpectations: {},
          deploymentIntent: undefined,
          confidence: 0.1,
        },
        annotations: [],
        learningHistory: [
          {
            timestamp: new Date(),
            event: "intake-created",
            details: `Created via intake channel ${channelId} from ${payload.source}`,
          },
        ],
      });
      artifactId = artifact.id;
    }

    // 2. Add new version
    const stringMetadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload.metadata)) {
      stringMetadata[k] = String(v ?? "");
    }
    if (payload.downloadUrl) {
      stringMetadata["downloadUrl"] = payload.downloadUrl;
    }
    stringMetadata["intakeChannel"] = channelId;

    const version = this.artifactStore.addVersion({
      artifactId,
      version: payload.version,
      source: payload.source,
      metadata: stringMetadata,
    });

    // 3. Trigger analysis if analyzer is available (best-effort, non-blocking)
    if (this.analyzer) {
      try {
        const result = await this.analyzer.analyze({
          name: payload.artifactName,
          type: payload.artifactType,
          source: payload.source,
          content: payload.content,
          metadata: stringMetadata,
        });

        // Resolve the best type: prefer the detected type over "unknown"
        const detectedType = detectArtifactType({
          name: payload.artifactName,
          type: payload.artifactType !== "unknown" ? payload.artifactType : undefined,
          source: payload.source,
          content: payload.content,
          metadata: stringMetadata,
        });

        // Update the artifact with the new analysis (and corrected type)
        this.artifactStore.update(artifactId, {
          type: detectedType !== "unknown" ? detectedType : payload.artifactType,
          analysis: result.analysis,
          learningHistory: [
            ...(existing?.learningHistory ?? []),
            {
              timestamp: new Date(),
              event: "intake-analysis",
              details: `Re-analyzed via intake (method: ${result.method}, confidence: ${result.analysis.confidence})`,
            },
          ],
        });
      } catch (err) {
        // Analysis failure should not block intake
        console.error(`[IntakeProcessor] Analysis failed for ${payload.artifactName}:`, err);
      }
    }

    return { artifactId, versionId: version.id };
  }
}
