import { execFile } from "node:child_process";
import type { Platform } from "../platform.js";
import type { OperationHandler, HandlerResult } from "../operation-registry.js";

// ---------------------------------------------------------------------------
// ContainerHandler — Docker and Docker Compose operations
// ---------------------------------------------------------------------------

/**
 * Handles container lifecycle operations via docker and docker-compose CLIs.
 *
 * Matches actions containing: docker, container, compose, pull, image
 *
 * Operations are mapped to docker/docker-compose commands:
 * - "docker pull" / "pull image" -> docker pull
 * - "docker start" / "container start" -> docker start
 * - "docker stop" / "container stop" -> docker stop
 * - "docker restart" -> docker restart
 * - "compose up" -> docker-compose up -d
 * - "compose down" -> docker-compose down
 * - "compose pull" -> docker-compose pull
 */
export class ContainerHandler implements OperationHandler {
  readonly name = "container";

  private timeoutMs: number;

  constructor(timeoutMs = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  canHandle(action: string, _platform: Platform): boolean {
    const lower = action.toLowerCase();
    return (
      lower.includes("docker") ||
      lower.includes("container") ||
      lower.includes("compose") ||
      lower.includes("pull") ||
      lower.includes("image")
    );
  }

  async execute(
    action: string,
    target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const lower = action.toLowerCase();

    try {
      // Docker Compose operations
      if (lower.includes("compose")) {
        return await this.handleCompose(lower, target, params);
      }

      // Docker pull
      if (lower.includes("pull") || lower.includes("image")) {
        return await this.dockerCommand(["pull", target]);
      }

      // Docker start
      if (lower.includes("start")) {
        return await this.dockerCommand(["start", target]);
      }

      // Docker stop
      if (lower.includes("stop")) {
        return await this.dockerCommand(["stop", target]);
      }

      // Docker restart
      if (lower.includes("restart")) {
        return await this.dockerCommand(["restart", target]);
      }

      // Docker rm
      if (lower.includes("remove") || lower.includes("rm")) {
        return await this.dockerCommand(["rm", "-f", target]);
      }

      // Generic docker run
      if (lower.includes("run")) {
        const args = (params.args as string[]) ?? [];
        return await this.dockerCommand(["run", "-d", ...args, target]);
      }

      return {
        success: false,
        output: "",
        error: `Unrecognized container operation: "${action}"`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: "",
        error: `Container operation "${action}" on "${target}" failed: ${message}`,
      };
    }
  }

  async verify(action: string, target: string): Promise<boolean> {
    const lower = action.toLowerCase();

    try {
      // After start/restart/run, container should be running
      if (
        lower.includes("start") ||
        lower.includes("restart") ||
        lower.includes("run")
      ) {
        const result = await this.run("docker", [
          "inspect",
          "--format",
          "{{.State.Running}}",
          target,
        ]);
        return result.stdout.trim() === "true";
      }

      // After stop/remove, container should not be running
      if (lower.includes("stop") || lower.includes("remove") || lower.includes("rm")) {
        try {
          const result = await this.run("docker", [
            "inspect",
            "--format",
            "{{.State.Running}}",
            target,
          ]);
          return result.stdout.trim() !== "true";
        } catch {
          // Container doesn't exist — that's correct after remove
          return true;
        }
      }

      // After pull, image should exist
      if (lower.includes("pull") || lower.includes("image")) {
        const result = await this.run("docker", ["image", "inspect", target]);
        return result.stdout.length > 0;
      }

      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: docker and compose commands
  // -------------------------------------------------------------------------

  private async handleCompose(
    action: string,
    target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const composeFile = (params.composeFile as string) ?? target;
    const cwd = (params.cwd as string) ?? undefined;

    if (action.includes("up")) {
      return await this.composeCommand(["-f", composeFile, "up", "-d"], cwd);
    }

    if (action.includes("down")) {
      return await this.composeCommand(["-f", composeFile, "down"], cwd);
    }

    if (action.includes("pull")) {
      return await this.composeCommand(["-f", composeFile, "pull"], cwd);
    }

    if (action.includes("restart")) {
      return await this.composeCommand(["-f", composeFile, "restart"], cwd);
    }

    return {
      success: false,
      output: "",
      error: `Unrecognized compose operation: "${action}"`,
    };
  }

  private async dockerCommand(args: string[]): Promise<HandlerResult> {
    try {
      const result = await this.run("docker", args);
      return {
        success: true,
        output: result.stdout + (result.stderr ? `\nstderr: ${result.stderr}` : ""),
      };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return {
        success: false,
        output: "",
        error: e.stderr ?? e.message,
      };
    }
  }

  private async composeCommand(args: string[], cwd?: string): Promise<HandlerResult> {
    try {
      const result = await this.run("docker", ["compose", ...args], cwd);
      return {
        success: true,
        output: result.stdout + (result.stderr ? `\nstderr: ${result.stderr}` : ""),
      };
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string };
      return {
        success: false,
        output: "",
        error: e.stderr ?? e.message,
      };
    }
  }

  private run(
    command: string,
    args: string[],
    cwd?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const options: { timeout: number; cwd?: string } = {
        timeout: this.timeoutMs,
      };
      if (cwd) options.cwd = cwd;

      execFile(command, args, options, (error, stdout, stderr) => {
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
}
