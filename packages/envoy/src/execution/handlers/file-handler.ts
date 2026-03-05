import fs from "node:fs/promises";
import path from "node:path";
import type { Platform, PlatformAdapter } from "../platform.js";
import type { OperationHandler, HandlerResult } from "../operation-registry.js";

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
}
