import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import type { Platform, PlatformAdapter, ServiceManager, FilesystemOps } from "../platform.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Promise wrapper around child_process.execFile.
 * Uses execFile (not exec) for safety — no shell interpolation.
 */
function run(
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(
          Object.assign(error, {
            stdout: stdout ?? "",
            stderr: stderr ?? "",
          }),
        );
      } else {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Linux/macOS Service Manager — systemctl on Linux, launchctl on macOS
// ---------------------------------------------------------------------------

class LinuxServiceManager implements ServiceManager {
  constructor(private platform: Platform) {}

  private get isLinux(): boolean {
    return this.platform === "linux";
  }

  async start(serviceName: string): Promise<{ success: boolean; output: string }> {
    try {
      if (this.isLinux) {
        const { stdout } = await run("systemctl", ["start", serviceName]);
        return { success: true, output: stdout || `Service ${serviceName} started` };
      }
      const { stdout } = await run("launchctl", ["start", serviceName]);
      return { success: true, output: stdout || `Service ${serviceName} started` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return { success: false, output: e.stderr ?? e.message };
    }
  }

  async stop(serviceName: string): Promise<{ success: boolean; output: string }> {
    try {
      if (this.isLinux) {
        const { stdout } = await run("systemctl", ["stop", serviceName]);
        return { success: true, output: stdout || `Service ${serviceName} stopped` };
      }
      const { stdout } = await run("launchctl", ["stop", serviceName]);
      return { success: true, output: stdout || `Service ${serviceName} stopped` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return { success: false, output: e.stderr ?? e.message };
    }
  }

  async restart(serviceName: string): Promise<{ success: boolean; output: string }> {
    try {
      if (this.isLinux) {
        const { stdout } = await run("systemctl", ["restart", serviceName]);
        return { success: true, output: stdout || `Service ${serviceName} restarted` };
      }
      // macOS: stop then start
      await run("launchctl", ["stop", serviceName]).catch(() => {});
      const { stdout } = await run("launchctl", ["start", serviceName]);
      return { success: true, output: stdout || `Service ${serviceName} restarted` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return { success: false, output: e.stderr ?? e.message };
    }
  }

  async status(serviceName: string): Promise<{ running: boolean; pid?: number }> {
    try {
      if (this.isLinux) {
        const { stdout } = await run("systemctl", ["is-active", serviceName]);
        const active = stdout.trim() === "active";
        if (active) {
          try {
            const { stdout: showOut } = await run("systemctl", [
              "show",
              serviceName,
              "--property=MainPID",
            ]);
            const match = showOut.match(/MainPID=(\d+)/);
            const pid = match ? parseInt(match[1], 10) : undefined;
            return { running: true, pid: pid && pid > 0 ? pid : undefined };
          } catch {
            return { running: true };
          }
        }
        return { running: false };
      }
      // macOS
      const { stdout } = await run("launchctl", ["list"]);
      const running = stdout.includes(serviceName);
      return { running };
    } catch {
      return { running: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Linux/macOS Filesystem Operations
// ---------------------------------------------------------------------------

class LinuxFilesystemOps implements FilesystemOps {
  async copy(src: string, dest: string): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout } = await run("cp", ["-a", src, dest]);
      return { success: true, output: stdout || `Copied ${src} to ${dest}` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return { success: false, output: e.stderr ?? e.message };
    }
  }

  async move(src: string, dest: string): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout } = await run("mv", [src, dest]);
      return { success: true, output: stdout || `Moved ${src} to ${dest}` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return { success: false, output: e.stderr ?? e.message };
    }
  }

  async backup(filePath: string, suffix?: string): Promise<{ success: boolean; backupPath: string }> {
    const backupSuffix = suffix ?? `.bak.${Date.now()}`;
    const backupPath = `${filePath}${backupSuffix}`;
    try {
      await run("cp", ["-a", filePath, backupPath]);
      return { success: true, backupPath };
    } catch {
      return { success: false, backupPath };
    }
  }

  async setPermissions(filePath: string, mode: string): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout } = await run("chmod", [mode, filePath]);
      return { success: true, output: stdout || `Set ${filePath} permissions to ${mode}` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return { success: false, output: e.stderr ?? e.message };
    }
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Linux/macOS Platform Adapter
// ---------------------------------------------------------------------------

export class LinuxPlatformAdapter implements PlatformAdapter {
  readonly platform: Platform;
  readonly serviceManager: ServiceManager;
  readonly filesystem: FilesystemOps;

  constructor(platform: Platform) {
    this.platform = platform;
    this.serviceManager = new LinuxServiceManager(platform);
    this.filesystem = new LinuxFilesystemOps();
  }
}
