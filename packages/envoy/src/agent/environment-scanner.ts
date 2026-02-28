import fs from "node:fs";
import path from "node:path";
import type { LocalStateStore } from "../state/local-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvironmentScanResult {
  /** Machine hostname or identifier */
  hostname: string;
  /** Base directory where deployments are stored */
  deploymentsDir: string;
  /** Whether the deployments directory exists and is writable */
  deploymentsWritable: boolean;
  /** Disk usage summary */
  disk: {
    workspaceExists: boolean;
    deploymentCount: number;
  };
  /** Summary of what the Envoy knows about local state */
  knownState: {
    totalDeployments: number;
    activeEnvironments: number;
    lastDeploymentAt: Date | null;
  };
}

// ---------------------------------------------------------------------------
// EnvironmentScanner — the Envoy's eyes on the local machine
// ---------------------------------------------------------------------------

/**
 * Inspects the local environment to understand what's happening on this
 * machine. This is what makes the Envoy an active agent rather than a
 * passive executor — it can reason about what it sees locally.
 *
 * Scans:
 * - Filesystem state (deployment workspace, writable, contents)
 * - Local deployment history (from LocalStateStore)
 * - Environment readiness (can we deploy here?)
 */
export class EnvironmentScanner {
  constructor(
    private baseDir: string,
    private stateStore: LocalStateStore,
  ) {}

  scan(): EnvironmentScanResult {
    const deploymentsDir = path.join(this.baseDir, "deployments");
    const deploymentsWritable = this.checkWritable(deploymentsDir);

    // Count deployment directories
    let deploymentCount = 0;
    if (fs.existsSync(deploymentsDir)) {
      try {
        deploymentCount = fs.readdirSync(deploymentsDir).length;
      } catch {
        deploymentCount = 0;
      }
    }

    // Gather known state from the store
    const allDeployments = this.stateStore.listDeployments();
    const lastDeployment = allDeployments.length > 0 ? allDeployments[0] : null;

    return {
      hostname: this.getHostname(),
      deploymentsDir,
      deploymentsWritable,
      disk: {
        workspaceExists: fs.existsSync(deploymentsDir),
        deploymentCount,
      },
      knownState: {
        totalDeployments: allDeployments.length,
        activeEnvironments: this.stateStore.listEnvironments().length,
        lastDeploymentAt: lastDeployment?.receivedAt ?? null,
      },
    };
  }

  /**
   * Check if a deployment can proceed — the workspace must be writable.
   */
  checkReadiness(): { ready: boolean; reason: string } {
    const deploymentsDir = path.join(this.baseDir, "deployments");

    if (!fs.existsSync(this.baseDir)) {
      return {
        ready: false,
        reason: `Base directory "${this.baseDir}" does not exist. The Envoy needs a workspace directory to store deployment artifacts.`,
      };
    }

    if (!this.checkWritable(deploymentsDir)) {
      // Try to create it
      try {
        fs.mkdirSync(deploymentsDir, { recursive: true });
      } catch (err) {
        return {
          ready: false,
          reason: `Cannot create deployments directory "${deploymentsDir}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    return { ready: true, reason: "Workspace is ready for deployments." };
  }

  private checkWritable(dir: string): boolean {
    if (!fs.existsSync(dir)) return false;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private getHostname(): string {
    try {
      return require("node:os").hostname();
    } catch {
      return "unknown";
    }
  }
}
