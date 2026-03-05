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

/**
 * Run a PowerShell command via pwsh / powershell.exe.
 * Tries pwsh (PS 7+) first, falls back to powershell.exe (Windows PowerShell 5).
 */
async function runPowerShell(
  script: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs);
  } catch {
    return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs);
  }
}

/**
 * Detect whether a service name targets an IIS application pool.
 * Convention: names prefixed with "iis:" (e.g. "iis:DefaultAppPool").
 */
function parseIISAppPool(serviceName: string): { isIIS: boolean; poolName: string } {
  if (serviceName.startsWith("iis:")) {
    return { isIIS: true, poolName: serviceName.slice(4) };
  }
  return { isIIS: false, poolName: "" };
}

/**
 * Map a Unix-style octal mode string (e.g. "755") to a best-effort icacls
 * grant expression. This is inherently lossy — NTFS ACLs are richer than
 * POSIX modes — but covers common deployment scenarios.
 *
 * Strategy: translate the owner digit into an icacls permission set applied
 * to the current user, and the "others" digit into a set for "Everyone".
 */
function unixModeToIcaclsGrants(mode: string): string[] {
  const digitToPerms = (digit: number): string => {
    const perms: string[] = [];
    // eslint-disable-next-line no-bitwise
    if (digit & 4) perms.push("R");
    // eslint-disable-next-line no-bitwise
    if (digit & 2) perms.push("W");
    // eslint-disable-next-line no-bitwise
    if (digit & 1) perms.push("RX");
    return perms.length > 0 ? `(${perms.join(",")})` : "(R)";
  };

  // Normalise to 3 digits — accept "755", "0755", "644" etc.
  const digits = mode.replace(/^0+/, "").padStart(3, "0");
  const owner = parseInt(digits[0], 10);
  const others = parseInt(digits[2], 10);

  const grants: string[] = [];
  grants.push(`*S-1-3-4:${digitToPerms(owner)}`); // OWNER RIGHTS
  grants.push(`Everyone:${digitToPerms(others)}`);
  return grants;
}

// ---------------------------------------------------------------------------
// Windows Service Manager — sc.exe / PowerShell / IIS appcmd
// ---------------------------------------------------------------------------

class Win32ServiceManager implements ServiceManager {
  // -- IIS helpers ----------------------------------------------------------

  private async iisStart(poolName: string): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout } = await runPowerShell(
        `Import-Module WebAdministration; Start-WebAppPool -Name '${poolName}'`,
      );
      return { success: true, output: stdout || `IIS app pool ${poolName} started` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return { success: false, output: e.stderr ?? e.message };
    }
  }

  private async iisStop(poolName: string): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout } = await runPowerShell(
        `Import-Module WebAdministration; Stop-WebAppPool -Name '${poolName}'`,
      );
      return { success: true, output: stdout || `IIS app pool ${poolName} stopped` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return { success: false, output: e.stderr ?? e.message };
    }
  }

  private async iisStatus(poolName: string): Promise<{ running: boolean; pid?: number }> {
    try {
      const { stdout } = await runPowerShell(
        `Import-Module WebAdministration; (Get-WebAppPoolState -Name '${poolName}').Value`,
      );
      const state = stdout.trim().toLowerCase();
      if (state === "started") {
        // Attempt to get the worker process PID
        try {
          const { stdout: pidOut } = await runPowerShell(
            `Import-Module WebAdministration; ` +
            `(Get-ChildItem "IIS:\\AppPools\\${poolName}\\WorkerProcesses" | Select-Object -First 1).processId`,
          );
          const pid = parseInt(pidOut.trim(), 10);
          return { running: true, pid: pid > 0 ? pid : undefined };
        } catch {
          return { running: true };
        }
      }
      return { running: false };
    } catch {
      return { running: false };
    }
  }

  // -- Windows Service helpers (sc.exe) -------------------------------------

  async start(serviceName: string): Promise<{ success: boolean; output: string }> {
    const { isIIS, poolName } = parseIISAppPool(serviceName);
    if (isIIS) return this.iisStart(poolName);

    try {
      const { stdout } = await run("sc.exe", ["start", serviceName]);
      return { success: true, output: stdout || `Service ${serviceName} started` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string; stdout?: string };
      return { success: false, output: e.stderr ?? e.stdout ?? e.message };
    }
  }

  async stop(serviceName: string): Promise<{ success: boolean; output: string }> {
    const { isIIS, poolName } = parseIISAppPool(serviceName);
    if (isIIS) return this.iisStop(poolName);

    try {
      const { stdout } = await run("sc.exe", ["stop", serviceName]);
      return { success: true, output: stdout || `Service ${serviceName} stopped` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string; stdout?: string };
      return { success: false, output: e.stderr ?? e.stdout ?? e.message };
    }
  }

  async restart(serviceName: string): Promise<{ success: boolean; output: string }> {
    const { isIIS, poolName } = parseIISAppPool(serviceName);
    if (isIIS) {
      const stopResult = await this.iisStop(poolName);
      if (!stopResult.success) return stopResult;
      return this.iisStart(poolName);
    }

    // Windows has no atomic restart — stop then start
    const stopResult = await this.stop(serviceName);
    if (!stopResult.success) {
      return { success: false, output: `Failed to stop before restart: ${stopResult.output}` };
    }
    // Brief pause to let the service fully release resources
    await new Promise((r) => setTimeout(r, 1_000));
    return this.start(serviceName);
  }

  async status(serviceName: string): Promise<{ running: boolean; pid?: number }> {
    const { isIIS, poolName } = parseIISAppPool(serviceName);
    if (isIIS) return this.iisStatus(poolName);

    try {
      const { stdout } = await run("sc.exe", ["query", serviceName]);
      // sc.exe query output contains a line like:  STATE  : 4  RUNNING
      const running = /STATE\s+:\s+4\s+RUNNING/i.test(stdout);
      if (running) {
        // Attempt to get the PID via sc.exe queryex
        try {
          const { stdout: qex } = await run("sc.exe", ["queryex", serviceName]);
          const match = qex.match(/PID\s+:\s+(\d+)/i);
          const pid = match ? parseInt(match[1], 10) : undefined;
          return { running: true, pid: pid && pid > 0 ? pid : undefined };
        } catch {
          return { running: true };
        }
      }
      return { running: false };
    } catch {
      return { running: false };
    }
  }
}

// ---------------------------------------------------------------------------
// Windows Filesystem Operations — NTFS / PowerShell
// ---------------------------------------------------------------------------

class Win32FilesystemOps implements FilesystemOps {
  /**
   * Prefix long paths with the extended-length marker so Windows APIs
   * can handle paths beyond MAX_PATH (260 chars).
   */
  private longPath(p: string): string {
    if (p.startsWith("\\\\?\\")) return p;
    // Only prefix absolute paths
    if (/^[A-Za-z]:[\\/]/.test(p)) return `\\\\?\\${p}`;
    return p;
  }

  async copy(src: string, dest: string): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout } = await runPowerShell(
        `Copy-Item -Path '${this.longPath(src)}' -Destination '${this.longPath(dest)}' -Recurse -Force`,
      );
      return { success: true, output: stdout || `Copied ${src} to ${dest}` };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return { success: false, output: e.stderr ?? e.message };
    }
  }

  async move(src: string, dest: string): Promise<{ success: boolean; output: string }> {
    try {
      const { stdout } = await runPowerShell(
        `Move-Item -Path '${this.longPath(src)}' -Destination '${this.longPath(dest)}' -Force`,
      );
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
      await runPowerShell(
        `Copy-Item -Path '${this.longPath(filePath)}' -Destination '${this.longPath(backupPath)}' -Recurse -Force`,
      );
      return { success: true, backupPath };
    } catch {
      return { success: false, backupPath };
    }
  }

  async setPermissions(filePath: string, mode: string): Promise<{ success: boolean; output: string }> {
    try {
      const grants = unixModeToIcaclsGrants(mode);
      const grantArgs = grants.flatMap((g) => ["/grant", g]);
      const { stdout } = await run("icacls", [this.longPath(filePath), ...grantArgs]);
      return {
        success: true,
        output: stdout || `Set ${filePath} permissions (best-effort mapping of mode ${mode})`,
      };
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
// Windows Platform Adapter
// ---------------------------------------------------------------------------

export class Win32PlatformAdapter implements PlatformAdapter {
  readonly platform: Platform;
  readonly serviceManager: ServiceManager;
  readonly filesystem: FilesystemOps;

  constructor(platform: Platform = "win32") {
    this.platform = platform;
    this.serviceManager = new Win32ServiceManager();
    this.filesystem = new Win32FilesystemOps();
  }
}
