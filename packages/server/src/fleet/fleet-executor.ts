import type {
  FleetDeployment,
  FleetProgress,
  FleetValidationResult,
  EnvoyValidationResult,
  DeploymentPlan,
  RolloutConfig,
} from "@synth-deploy/core";
import type { EnvoyRegistry } from "../agent/envoy-registry.js";
import { EnvoyClient } from "../agent/envoy-client.js";

// ---------------------------------------------------------------------------
// Fleet progress event types
// ---------------------------------------------------------------------------

export interface FleetProgressEvent {
  type:
    | "validation-started"
    | "validation-complete"
    | "batch-started"
    | "envoy-started"
    | "envoy-completed"
    | "envoy-failed"
    | "batch-completed"
    | "fleet-completed"
    | "fleet-failed"
    | "fleet-paused";
  envoyId?: string;
  envoyName?: string;
  batchIndex?: number;
  progress: FleetProgress;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeProgress(
  totalEnvoys: number,
  validated: number,
  executing: number,
  succeeded: number,
  failed: number,
  currentBatch?: number,
  totalBatches?: number,
): FleetProgress {
  return {
    totalEnvoys,
    validated,
    executing,
    succeeded,
    failed,
    pending: totalEnvoys - succeeded - failed - executing,
    currentBatch,
    totalBatches,
  };
}

// ---------------------------------------------------------------------------
// FleetExecutor — orchestrates validation and progressive rollout
// ---------------------------------------------------------------------------

export class FleetExecutor {
  constructor(
    private envoyRegistry: EnvoyRegistry,
    private createEnvoyClient: (url: string, token: string) => EnvoyClient,
  ) {}

  /**
   * Validate a deployment plan against all target envoys in the fleet.
   * Probes each envoy and asks it to validate the plan steps.
   */
  async validateFleet(
    fleetDeployment: FleetDeployment,
    plan: DeploymentPlan,
  ): Promise<FleetValidationResult> {
    const targetEnvoyIds =
      fleetDeployment.envoyFilter ?? this.getEnvironmentEnvoyIds(fleetDeployment.environmentId);

    const results: EnvoyValidationResult[] = [];

    for (const envoyId of targetEnvoyIds) {
      const entry = this.envoyRegistry.get(envoyId);
      if (!entry) {
        results.push({
          envoyId,
          envoyName: "unknown",
          validated: false,
          issues: [`Envoy ${envoyId} not found in registry`],
        });
        continue;
      }

      const client = this.createEnvoyClient(entry.url, entry.token);
      try {
        const validation = await client.validatePlan(plan.steps);
        results.push({
          envoyId,
          envoyName: entry.name,
          validated: validation.valid,
          issues: validation.violations?.map((v) => v.reason),
        });
      } catch (err) {
        results.push({
          envoyId,
          envoyName: entry.name,
          validated: false,
          issues: [
            `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
          ],
        });
      }
    }

    return {
      total: results.length,
      validated: results.filter((r) => r.validated).length,
      failed: results.filter((r) => !r.validated).length,
      results,
    };
  }

  /**
   * Execute a progressive rollout across the fleet.
   * Yields progress events as an async generator so callers can stream them.
   */
  async *executeRollout(
    fleetDeployment: FleetDeployment,
    plan: DeploymentPlan,
    rollbackPlan?: DeploymentPlan,
  ): AsyncGenerator<FleetProgressEvent> {
    const validatedEnvoys =
      fleetDeployment.validationResult?.results.filter((r) => r.validated) ?? [];
    const config = fleetDeployment.rolloutConfig;
    const totalEnvoys = validatedEnvoys.length;

    if (totalEnvoys === 0) {
      yield {
        type: "fleet-failed",
        progress: makeProgress(0, 0, 0, 0, 0),
        error: "No validated envoys to execute against",
      };
      return;
    }

    // Build batches based on rollout strategy
    const batches = this.buildBatches(validatedEnvoys, config);
    const totalBatches = batches.length;

    let succeeded = 0;
    let failureCount = 0;

    for (let i = 0; i < batches.length; i++) {
      yield {
        type: "batch-started",
        batchIndex: i,
        progress: makeProgress(totalEnvoys, totalEnvoys, batches[i].length, succeeded, failureCount, i, totalBatches),
      };

      for (const envoy of batches[i]) {
        yield {
          type: "envoy-started",
          envoyId: envoy.envoyId,
          envoyName: envoy.envoyName,
          batchIndex: i,
          progress: makeProgress(totalEnvoys, totalEnvoys, 1, succeeded, failureCount, i, totalBatches),
        };

        const entry = this.envoyRegistry.get(envoy.envoyId);
        if (!entry) {
          failureCount++;
          yield {
            type: "envoy-failed",
            envoyId: envoy.envoyId,
            envoyName: envoy.envoyName,
            batchIndex: i,
            progress: makeProgress(totalEnvoys, totalEnvoys, 0, succeeded, failureCount, i, totalBatches),
            error: `Envoy ${envoy.envoyId} not found in registry`,
          };

          if (failureCount >= config.haltOnFailureCount) {
            yield {
              type: "fleet-failed",
              progress: makeProgress(totalEnvoys, totalEnvoys, 0, succeeded, failureCount, i, totalBatches),
              error: `Halted: ${failureCount} failure(s) reached threshold of ${config.haltOnFailureCount}`,
            };
            return;
          }
          continue;
        }

        const client = this.createEnvoyClient(entry.url, entry.token);
        try {
          await client.executeApprovedPlan({
            deploymentId: fleetDeployment.id,
            plan,
            rollbackPlan: rollbackPlan ?? plan,
            artifactType: "fleet",
            artifactName: fleetDeployment.artifactId,
            environmentId: fleetDeployment.environmentId,
          });
          succeeded++;
          yield {
            type: "envoy-completed",
            envoyId: envoy.envoyId,
            envoyName: envoy.envoyName,
            batchIndex: i,
            progress: makeProgress(totalEnvoys, totalEnvoys, 0, succeeded, failureCount, i, totalBatches),
          };
        } catch (err) {
          failureCount++;
          yield {
            type: "envoy-failed",
            envoyId: envoy.envoyId,
            envoyName: envoy.envoyName,
            batchIndex: i,
            progress: makeProgress(totalEnvoys, totalEnvoys, 0, succeeded, failureCount, i, totalBatches),
            error: err instanceof Error ? err.message : String(err),
          };

          if (failureCount >= config.haltOnFailureCount) {
            yield {
              type: "fleet-failed",
              progress: makeProgress(totalEnvoys, totalEnvoys, 0, succeeded, failureCount, i, totalBatches),
              error: `Halted: ${failureCount} failure(s) reached threshold of ${config.haltOnFailureCount}`,
            };
            return;
          }
        }
      }

      yield {
        type: "batch-completed",
        batchIndex: i,
        progress: makeProgress(totalEnvoys, totalEnvoys, 0, succeeded, failureCount, i, totalBatches),
      };

      // Health check wait between batches
      if (config.healthCheckWaitMs > 0 && i < batches.length - 1) {
        await delay(config.healthCheckWaitMs);
      }

      // Pause between batches if configured — yield paused event and return.
      // Caller resumes by calling executeRollout again with remaining batches.
      if (config.pauseBetweenBatches && i < batches.length - 1) {
        yield {
          type: "fleet-paused",
          batchIndex: i,
          progress: makeProgress(totalEnvoys, totalEnvoys, 0, succeeded, failureCount, i, totalBatches),
        };
        return;
      }
    }

    yield {
      type: "fleet-completed",
      progress: makeProgress(totalEnvoys, totalEnvoys, 0, succeeded, failureCount, totalBatches - 1, totalBatches),
    };
  }

  /**
   * Build execution batches based on the rollout strategy.
   */
  private buildBatches(
    envoys: EnvoyValidationResult[],
    config: RolloutConfig,
  ): EnvoyValidationResult[][] {
    if (envoys.length === 0) return [];

    if (config.strategy === "all-at-once") {
      return [envoys];
    }

    if (config.strategy === "canary") {
      // First batch: single canary, second batch: everything else
      return [[envoys[0]], envoys.slice(1)];
    }

    // batched strategy
    const size =
      config.batchSize ??
      Math.max(1, Math.ceil(envoys.length * (config.batchPercent ?? 10) / 100));

    const batches: EnvoyValidationResult[][] = [];
    for (let i = 0; i < envoys.length; i += size) {
      batches.push(envoys.slice(i, i + size));
    }
    return batches;
  }

  /**
   * Get all envoy IDs assigned to a given environment.
   */
  private getEnvironmentEnvoyIds(environmentId: string): string[] {
    return this.envoyRegistry
      .list()
      .filter(
        (e) =>
          e.assignedEnvironments.length === 0 ||
          e.assignedEnvironments.includes(environmentId),
      )
      .map((e) => e.id);
  }
}
