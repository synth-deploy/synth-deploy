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
// Homebrew service name detection
// ---------------------------------------------------------------------------

/**
 * Returns the bare service name if the label matches the Homebrew convention
 * (`homebrew.<name>` or `homebrew.mxcl.<name>`), otherwise null.
 */
function homebrewServiceName(label: string): string | null {
  const match = label.match(/^homebrew\.(?:mxcl\.)?(.+)$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Darwin Service Manager — launchctl / brew services
// ---------------------------------------------------------------------------

class DarwinServiceManager implements ServiceManager {
  async start(serviceName: string): Promise<{ success: boolean; output: string }> {
    try {
      const brewName = homebrewServiceName(serviceName);
      if (brewName) {
        const { stdout } = await run("brew", ["services", "start", brewName]);
        return { success: true, output: stdout || `Service ${brewName} started via Homebrew` };
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
      const brewName = homebrewServiceName(serviceName);
      if (brewName) {
        const { stdout } = await run("brew", ["services", "stop", brewName]);
        return { success: true, output: stdout || `Service ${brewName} stopped via Homebrew` };
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
      const brewName = homebrewServiceName(serviceName);
      if (brewName) {
        const { stdout } = await run("brew", ["services", "restart", brewName]);
        return { success: true, output: stdout || `Service ${brewName} restarted via Homebrew` };
      }
      // launchctl has no atomic restart — stop then start
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
      const brewName = homebrewServiceName(serviceName);
      if (brewName) {
        const { stdout } = await run("brew", ["services", "info", brewName, "--json"]);
        const info = JSON.parse(stdout);
        // brew services info --json returns an array of service objects
        const svc = Array.isArray(info) ? info[0] : info;
        if (svc && svc.running) {
          return { running: true, pid: svc.pid ?? undefined };
        }
        return { running: false };
      }
      // launchctl list <label> outputs: PID\tStatus\tLabel
      // PID is "-" when not running, a number when running
      const { stdout } = await run("launchctl", ["list", serviceName]);
      // Single-service output format:
      //   "PID" = <number or ->
      //   "Label" = "<name>"
      //   "LastExitStatus" = <number>
      // Or tabular: <pid>\t<status>\t<label>
      const pidMatch = stdout.match(/"PID"\s*=\s*(\d+)/);
      if (pidMatch) {
        const pid = parseInt(pidMatch[1], 10);
        return { running: pid > 0, pid: pid > 0 ? pid : undefined };
      }
      // Tabular format fallback — first column is PID
      const lines = stdout.trim().split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\t/);
        if (parts.length >= 3 && parts[2] === serviceName) {
          const pid = parseInt(parts[0], 10);
          if (!isNaN(pid) && pid > 0) {
            return { running: true, pid };
          }
          return { running: false };
        }
      }
      // If launchctl list succeeded and included the name, it's loaded
      return { running: stdout.includes(serviceName) };
    } catch {
      return { running: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Darwin Filesystem Operations
// ---------------------------------------------------------------------------

class DarwinFilesystemOps implements FilesystemOps {
  async copy(src: string, dest: string): Promise<{ success: boolean; output: string }> {
    try {
      // macOS cp: -R for recursive (macOS cp does not support -a, use -pR to preserve attrs)
      const { stdout } = await run("cp", ["-pR", src, dest]);
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
      await run("cp", ["-pR", filePath, backupPath]);
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
// Darwin Platform Adapter
// ---------------------------------------------------------------------------

export class DarwinPlatformAdapter implements PlatformAdapter {
  readonly platform: Platform = "darwin";
  readonly serviceManager: ServiceManager;
  readonly filesystem: FilesystemOps;

  constructor() {
    this.serviceManager = new DarwinServiceManager();
    this.filesystem = new DarwinFilesystemOps();
  }
}
