import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { EnvoyKnowledgeStore } from "../state/knowledge-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of probing for a specific tool on the local system.
 */
export interface ToolProbeResult {
  /** Tool name (e.g. "docker", "npm") */
  name: string;
  /** Whether the tool was found on PATH */
  available: boolean;
  /** Version string if available, null otherwise */
  version: string | null;
}

export interface EnvironmentScanResult {
  /** Machine hostname or identifier */
  hostname: string;
  /** Human-readable OS description, e.g. "Ubuntu 22.04", "Windows Server 2022", "macOS 14.4" */
  os: string;
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
  /** Installed tools on this machine — populated by scanTools() */
  installedTools: ToolProbeResult[];
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
/**
 * Tools to probe at startup. Each entry is [toolName, versionArgs].
 * The version args are used to extract a version string — if the tool
 * is found, we run `toolName ...versionArgs` and capture the first
 * line of output.
 */
const PROBED_TOOLS: Array<[string, string[]]> = [
  ["docker", ["--version"]],
  ["docker-compose", ["--version"]],
  ["npm", ["--version"]],
  ["node", ["--version"]],
  ["systemctl", ["--version"]],
  ["launchctl", ["version"]],
  ["apt", ["--version"]],
  ["yum", ["--version"]],
  ["brew", ["--version"]],
  ["git", ["--version"]],
  ["curl", ["--version"]],
  ["wget", ["--version"]],
  ["tar", ["--version"]],
  ["unzip", ["-v"]],
];

export class EnvironmentScanner {
  private cachedTools: ToolProbeResult[] | null = null;

  constructor(
    private baseDir: string,
    private stateStore: EnvoyKnowledgeStore,
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
      os: this.getOsInfo(),
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
      installedTools: this.cachedTools ?? [],
    };
  }

  /**
   * Probe for installed tools on the local system. Results are cached
   * so subsequent scan() calls include them without re-probing.
   *
   * Call this once at startup — probing is async because it spawns
   * child processes.
   */
  async scanTools(): Promise<ToolProbeResult[]> {
    const results = await Promise.all(
      PROBED_TOOLS.map(([name, versionArgs]) => this.probeTool(name, versionArgs)),
    );
    this.cachedTools = results;
    return results;
  }

  /**
   * Return cached tool probe results, or empty if scanTools() hasn't
   * been called yet.
   */
  getInstalledTools(): ToolProbeResult[] {
    return this.cachedTools ?? [];
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

  private probeTool(name: string, versionArgs: string[]): Promise<ToolProbeResult> {
    return new Promise((resolve) => {
      execFile(name, versionArgs, { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) {
          resolve({ name, available: false, version: null });
          return;
        }
        // Extract first non-empty line from stdout or stderr as the version
        const output = (stdout || stderr || "").trim();
        const firstLine = output.split("\n")[0]?.trim() ?? null;
        resolve({ name, available: true, version: firstLine });
      });
    });
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
      return os.hostname();
    } catch {
      return "unknown";
    }
  }

  private getOsInfo(): string {
    try {
      if (process.platform === "linux") {
        const release = fs.readFileSync("/etc/os-release", "utf8");
        const match = release.match(/^PRETTY_NAME="(.+)"$/m);
        if (match) return match[1];
        return "Linux";
      }
      if (process.platform === "win32") {
        return os.version() || "Windows";
      }
      if (process.platform === "darwin") {
        return `macOS ${os.release()}`;
      }
      return process.platform;
    } catch {
      return process.platform;
    }
  }
}
