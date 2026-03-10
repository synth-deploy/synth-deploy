/**
 * Re-exports the persistent fleet deployment store from @synth-deploy/core.
 * Fleet deployments are now SQLite-backed to survive server restarts.
 *
 * Note: In-flight fleet operations that are mid-execution when the server
 * crashes cannot be resumed — their status is persisted, but the active
 * orchestration state (batch progress, in-flight envoy connections) is
 * ephemeral. On restart, in-flight operations will appear as stale entries
 * that users can inspect and manually re-trigger. Terminal states (completed,
 * failed, rolled_back) are fully durable.
 */

export { PersistentFleetDeploymentStore as FleetDeploymentStore } from "@synth-deploy/core";
