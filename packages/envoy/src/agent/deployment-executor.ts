import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeploymentManifest {
  deploymentId: string;
  operationId: string;
  partitionId: string;
  environmentId: string;
  version: string;
  variables: Record<string, string>;
  receivedAt: string;
}

export interface ExecutionResult {
  success: boolean;
  workspacePath: string;
  /** What files were created/modified */
  artifacts: string[];
  /** How long the execution took */
  durationMs: number;
  error: string | null;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheck[];
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// DeploymentExecutor — performs the actual deployment on the local machine
// ---------------------------------------------------------------------------

/**
 * Executes deployment steps on the local filesystem.
 *
 * In production, this would:
 * - Pull deployment artifacts from a registry
 * - Run migration scripts
 * - Restart services
 * - Configure reverse proxies
 *
 * For the foundation phase, it creates a structured workspace that
 * represents a deployed artifact — a manifest file, a variables file,
 * and a marker that indicates the deployment version. This is enough
 * to prove the full cycle works and to test the Envoy's reasoning.
 */
export class DeploymentExecutor {
  constructor(private baseDir: string) {}

  /**
   * Execute a deployment: create the workspace and write artifacts.
   */
  async execute(manifest: DeploymentManifest): Promise<ExecutionResult> {
    const start = Date.now();
    const workspacePath = path.join(
      this.baseDir,
      "deployments",
      manifest.deploymentId,
    );

    try {
      // Create workspace directory
      fs.mkdirSync(workspacePath, { recursive: true });

      const artifacts: string[] = [];

      // Write deployment manifest
      const manifestPath = path.join(workspacePath, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      artifacts.push("manifest.json");

      // Write resolved variables
      const varsPath = path.join(workspacePath, "variables.env");
      const varsContent = Object.entries(manifest.variables)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      fs.writeFileSync(varsPath, varsContent);
      artifacts.push("variables.env");

      // Write version marker — this represents "the deployed artifact"
      const versionPath = path.join(workspacePath, "VERSION");
      fs.writeFileSync(
        versionPath,
        `${manifest.operationId}@${manifest.version}`,
      );
      artifacts.push("VERSION");

      // Write deployment status
      const statusPath = path.join(workspacePath, "STATUS");
      fs.writeFileSync(statusPath, "DEPLOYED");
      artifacts.push("STATUS");

      return {
        success: true,
        workspacePath,
        artifacts,
        durationMs: Date.now() - start,
        error: null,
      };
    } catch (err) {
      return {
        success: false,
        workspacePath,
        artifacts: [],
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Verify a deployment: check that the expected artifacts exist and
   * contain the right content.
   */
  verify(
    workspacePath: string,
    expectedVersion: string,
    expectedOperationId: string,
  ): VerificationResult {
    const checks: VerificationCheck[] = [];

    // Check workspace exists
    const wsExists = fs.existsSync(workspacePath);
    checks.push({
      name: "workspace-exists",
      passed: wsExists,
      detail: wsExists
        ? `Workspace directory exists at ${workspacePath}`
        : `Workspace directory missing at ${workspacePath}`,
    });

    if (!wsExists) {
      return { passed: false, checks };
    }

    // Check manifest
    const manifestPath = path.join(workspacePath, "manifest.json");
    const manifestExists = fs.existsSync(manifestPath);
    checks.push({
      name: "manifest-present",
      passed: manifestExists,
      detail: manifestExists
        ? "Deployment manifest found"
        : "Deployment manifest missing",
    });

    // Check VERSION marker
    const versionPath = path.join(workspacePath, "VERSION");
    const versionExists = fs.existsSync(versionPath);
    let versionCorrect = false;
    if (versionExists) {
      const versionContent = fs.readFileSync(versionPath, "utf-8").trim();
      versionCorrect =
        versionContent === `${expectedOperationId}@${expectedVersion}`;
      checks.push({
        name: "version-correct",
        passed: versionCorrect,
        detail: versionCorrect
          ? `Version marker reads "${versionContent}" — matches expected`
          : `Version marker reads "${versionContent}" — expected "${expectedOperationId}@${expectedVersion}"`,
      });
    } else {
      checks.push({
        name: "version-correct",
        passed: false,
        detail: "VERSION file missing",
      });
    }

    // Check STATUS marker
    const statusPath = path.join(workspacePath, "STATUS");
    const statusExists = fs.existsSync(statusPath);
    let statusCorrect = false;
    if (statusExists) {
      const statusContent = fs.readFileSync(statusPath, "utf-8").trim();
      statusCorrect = statusContent === "DEPLOYED";
      checks.push({
        name: "status-deployed",
        passed: statusCorrect,
        detail: statusCorrect
          ? "STATUS marker reads DEPLOYED"
          : `STATUS marker reads "${statusContent}" — expected "DEPLOYED"`,
      });
    } else {
      checks.push({
        name: "status-deployed",
        passed: false,
        detail: "STATUS file missing",
      });
    }

    // Check variables file
    const varsPath = path.join(workspacePath, "variables.env");
    const varsExists = fs.existsSync(varsPath);
    checks.push({
      name: "variables-present",
      passed: varsExists,
      detail: varsExists
        ? "Variables file found"
        : "Variables file missing",
    });

    const passed = checks.every((c) => c.passed);
    return { passed, checks };
  }
}
