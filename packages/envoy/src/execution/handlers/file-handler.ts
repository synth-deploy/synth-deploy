import fs from "node:fs/promises";
import path from "node:path";
import type { PlannedStep } from "@synth-deploy/core";
import type { Platform, PlatformAdapter } from "../platform.js";
import type { OperationHandler, HandlerResult, DryRunResult } from "../operation-registry.js";

// ---------------------------------------------------------------------------
// FileHandler — copy, move, backup, permissions, symlink
// ---------------------------------------------------------------------------

/**
 * Handles filesystem operations using the platform adapter and Node's
 * fs module for symlinks.
 *
 * Matches actions containing: copy, move, backup, permission, symlink,
 * file, write, mkdir, delete
 */
export class FileHandler implements OperationHandler {
  readonly name = "file";
  readonly actionKeywords = ["copy", "move", "backup", "permission", "symlink", "file", "write", "mkdir", "delete"] as const;
  readonly toolDependencies = [] as const;

  constructor(private adapter: PlatformAdapter) {}

  canHandle(action: string, _platform: Platform): boolean {
    const lower = action.toLowerCase();
    return (
      lower.includes("copy") ||
      lower.includes("move") ||
      lower.includes("backup") ||
      lower.includes("permission") ||
      lower.includes("symlink") ||
      lower.includes("file") ||
      lower.includes("write") ||
      lower.includes("mkdir") ||
      lower.includes("delete")
    );
  }

  async execute(
    action: string,
    target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const lower = action.toLowerCase();

    try {
      if (lower.includes("copy")) {
        const dest = (params.destination as string) ?? (params.dest as string) ?? "";
        if (!dest) {
          return { success: false, output: "", error: "Copy requires a destination parameter" };
        }
        const result = await this.adapter.filesystem.copy(target, dest);
        return { success: result.success, output: result.output, error: result.success ? undefined : result.output };
      }

      if (lower.includes("move")) {
        const dest = (params.destination as string) ?? (params.dest as string) ?? "";
        if (!dest) {
          return { success: false, output: "", error: "Move requires a destination parameter" };
        }
        const result = await this.adapter.filesystem.move(target, dest);
        return { success: result.success, output: result.output, error: result.success ? undefined : result.output };
      }

      if (lower.includes("backup")) {
        const suffix = params.suffix as string | undefined;
        const result = await this.adapter.filesystem.backup(target, suffix);
        return {
          success: result.success,
          output: result.success ? `Backed up to ${result.backupPath}` : `Failed to backup ${target}`,
          error: result.success ? undefined : `Backup of ${target} failed`,
        };
      }

      if (lower.includes("permission")) {
        const mode = (params.mode as string) ?? "644";
        const result = await this.adapter.filesystem.setPermissions(target, mode);
        return { success: result.success, output: result.output, error: result.success ? undefined : result.output };
      }

      if (lower.includes("symlink")) {
        const linkTarget = (params.linkTarget as string) ?? (params.source as string) ?? "";
        if (!linkTarget) {
          return { success: false, output: "", error: "Symlink requires a linkTarget or source parameter" };
        }
        // Validate that the symlink target resolves within allowed boundaries.
        // The linkTarget is resolved relative to the symlink's parent directory
        // to catch traversal attacks (e.g., linkTarget: "../../../../etc/shadow").
        const allowedPaths = (params.allowedPaths as string[] | undefined) ?? [];
        const resolvedLinkTarget = path.resolve(path.dirname(target), linkTarget);
        if (allowedPaths.length > 0) {
          const withinBoundary = allowedPaths.some((p) => {
            const resolvedAllowed = path.resolve(p);
            const prefix = resolvedAllowed.endsWith(path.sep)
              ? resolvedAllowed
              : resolvedAllowed + path.sep;
            return resolvedLinkTarget === resolvedAllowed || resolvedLinkTarget.startsWith(prefix);
          });
          if (!withinBoundary) {
            return {
              success: false,
              output: "",
              error: `Symlink target "${linkTarget}" resolves to "${resolvedLinkTarget}" which is outside allowed paths: ${allowedPaths.join(", ")}`,
            };
          }
        }
        await fs.symlink(linkTarget, target);
        return { success: true, output: `Created symlink ${target} -> ${linkTarget}` };
      }

      if (lower.includes("mkdir")) {
        await fs.mkdir(target, { recursive: true });
        return { success: true, output: `Created directory ${target}` };
      }

      if (lower.includes("delete")) {
        await fs.rm(target, { recursive: true, force: true });
        return { success: true, output: `Deleted ${target}` };
      }

      if (lower.includes("write")) {
        const content = (params.content as string) ?? "";
        const dir = path.dirname(target);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(target, content, "utf-8");
        return { success: true, output: `Wrote ${content.length} bytes to ${target}` };
      }

      return {
        success: false,
        output: "",
        error: `Unrecognized file operation: "${action}"`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: "",
        error: `File operation "${action}" on "${target}" failed: ${message}`,
      };
    }
  }

  async verify(_action: string, target: string): Promise<boolean> {
    return this.adapter.filesystem.exists(target);
  }

  async dryRun(
    step: PlannedStep,
    predictedOutcomes: Map<number, Record<string, unknown>>,
  ): Promise<DryRunResult> {
    const observations: DryRunResult["observations"] = [];
    const lower = step.action.toLowerCase();
    const target = step.target;

    try {
      const params = step.params ?? {};

      // Check required params before any filesystem checks
      if (lower.includes("copy")) {
        const dest = (params.destination as string) ?? (params.dest as string) ?? "";
        observations.push({
          name: "required-param-destination",
          passed: !!dest,
          detail: dest
            ? `Copy destination parameter is present: "${dest}"`
            : `Copy action requires a "destination" parameter — the target path to copy to`,
        });
      }

      if (lower.includes("move")) {
        const dest = (params.destination as string) ?? (params.dest as string) ?? "";
        observations.push({
          name: "required-param-destination",
          passed: !!dest,
          detail: dest
            ? `Move destination parameter is present: "${dest}"`
            : `Move action requires a "destination" parameter — the target path to move to`,
        });
      }

      if (lower.includes("symlink")) {
        const linkTarget = (params.linkTarget as string) ?? (params.source as string) ?? "";
        observations.push({
          name: "required-param-linkTarget",
          passed: !!linkTarget,
          detail: linkTarget
            ? `Symlink linkTarget parameter is present: "${linkTarget}"`
            : `Symlink action requires a "linkTarget" parameter — the path the symlink should point to`,
        });
      }

      // Check if parent directory exists (or was predicted to be created)
      const parentDir = path.dirname(target);
      let parentExists = false;
      try {
        const stat = await fs.stat(parentDir);
        parentExists = stat.isDirectory();
      } catch {
        // Check if a prior step predicts creating this directory
        for (const [, outcome] of predictedOutcomes) {
          if (
            outcome.createdDirectory === parentDir ||
            (typeof outcome.createdDirectory === "string" &&
              parentDir.startsWith(outcome.createdDirectory + "/"))
          ) {
            parentExists = true;
            break;
          }
        }
      }

      observations.push({
        name: "parent-directory-exists",
        passed: parentExists,
        detail: parentExists
          ? `Parent directory "${parentDir}" exists and is a directory`
          : `Parent directory "${parentDir}" does not exist — file operations will fail`,
      });

      // Check parent directory is writable (only if it exists on disk)
      if (parentExists) {
        try {
          await fs.access(parentDir, (await import("node:fs")).constants.W_OK);
          observations.push({
            name: "parent-directory-writable",
            passed: true,
            detail: `Parent directory "${parentDir}" is writable`,
          });
        } catch {
          observations.push({
            name: "parent-directory-writable",
            passed: false,
            detail: `Parent directory "${parentDir}" is not writable — permission denied`,
          });
        }
      }

      // For symlinks: validate link target exists
      if (lower.includes("symlink")) {
        const linkTarget = target; // The symlink target path
        try {
          await fs.stat(linkTarget);
          observations.push({
            name: "symlink-target-exists",
            passed: true,
            detail: `Symlink target "${linkTarget}" exists`,
          });
        } catch {
          observations.push({
            name: "symlink-target-exists",
            passed: false,
            detail: `Symlink target "${linkTarget}" does not exist — symlink will be dangling`,
          });
        }
      }

      // For delete: check target exists
      if (lower.includes("delete")) {
        try {
          await fs.stat(target);
          observations.push({
            name: "delete-target-exists",
            passed: true,
            detail: `Delete target "${target}" exists`,
          });
        } catch {
          observations.push({
            name: "delete-target-exists",
            passed: true, // Deleting a non-existent file is not a failure
            detail: `Delete target "${target}" does not exist — operation is a no-op`,
          });
        }
      }

      // Check disk space (basic check via statfs)
      try {
        const stats = await fs.statfs(parentDir);
        const freeBytes = stats.bfree * stats.bsize;
        const freeMB = Math.round(freeBytes / (1024 * 1024));
        const sufficient = freeBytes > 100 * 1024 * 1024; // 100MB minimum
        observations.push({
          name: "disk-space",
          passed: sufficient,
          detail: sufficient
            ? `${freeMB}MB free on filesystem containing "${parentDir}"`
            : `Only ${freeMB}MB free on filesystem containing "${parentDir}" — less than 100MB minimum`,
        });
      } catch {
        // statfs not available or path doesn't exist yet — not a hard failure
      }

      // Predict outcome
      const predictedOutcome: Record<string, unknown> = {};
      if (lower.includes("mkdir")) {
        predictedOutcome.createdDirectory = target;
      } else if (lower.includes("write") || lower.includes("copy")) {
        predictedOutcome.createdFile = target;
      } else if (lower.includes("delete")) {
        predictedOutcome.deletedPath = target;
      }

      return {
        observations,
        predictedOutcome,
        fidelity: "deterministic",
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        observations: [
          {
            name: "dry-run-error",
            passed: false,
            detail: `Dry-run check failed unexpectedly: ${message}`,
          },
        ],
        fidelity: "deterministic",
      };
    }
  }
}
