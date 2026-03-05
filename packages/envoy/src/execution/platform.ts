// ---------------------------------------------------------------------------
// Platform abstraction — uniform interface for OS-specific operations
// ---------------------------------------------------------------------------

/**
 * Supported platform identifiers, matching Node's process.platform values.
 */
export type Platform = "linux" | "darwin" | "win32";

/**
 * Manages system services (systemd on Linux, launchctl on macOS, etc.).
 */
export interface ServiceManager {
  start(serviceName: string): Promise<{ success: boolean; output: string }>;
  stop(serviceName: string): Promise<{ success: boolean; output: string }>;
  restart(serviceName: string): Promise<{ success: boolean; output: string }>;
  status(serviceName: string): Promise<{ running: boolean; pid?: number }>;
}

/**
 * Filesystem operations with deployment-aware semantics.
 * All operations are explicit and auditable — no silent overwrites.
 */
export interface FilesystemOps {
  copy(src: string, dest: string): Promise<{ success: boolean; output: string }>;
  move(src: string, dest: string): Promise<{ success: boolean; output: string }>;
  backup(path: string, suffix?: string): Promise<{ success: boolean; backupPath: string }>;
  setPermissions(path: string, mode: string): Promise<{ success: boolean; output: string }>;
  exists(path: string): Promise<boolean>;
}

/**
 * Platform adapter — provides OS-specific implementations of service
 * management and filesystem operations.
 *
 * Each platform gets its own adapter (linux.ts, darwin.ts, etc.)
 * so the execution engine never branches on platform at runtime.
 */
export interface PlatformAdapter {
  platform: Platform;
  serviceManager: ServiceManager;
  filesystem: FilesystemOps;
}

/**
 * Detect the current platform and return the corresponding adapter.
 * Falls back to linux adapter for unrecognized platforms.
 */
export async function createPlatformAdapter(): Promise<PlatformAdapter> {
  const platform = process.platform as Platform;

  switch (platform) {
    case "linux":
    case "darwin": {
      const { LinuxPlatformAdapter } = await import("./platform/linux.js");
      return new LinuxPlatformAdapter(platform);
    }
    default: {
      // Unsupported platform — create a linux adapter as best-effort
      const { LinuxPlatformAdapter } = await import("./platform/linux.js");
      return new LinuxPlatformAdapter(platform);
    }
  }
}
