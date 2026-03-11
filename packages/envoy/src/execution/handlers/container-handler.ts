import { execFile } from "node:child_process";
import type { PlannedStep } from "@synth-deploy/core";
import type { Platform } from "../platform.js";
import type { OperationHandler, HandlerResult, DryRunResult } from "../operation-registry.js";

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
  readonly actionKeywords = ["docker", "container", "compose", "pull", "image"] as const;
  readonly toolDependencies = ["docker", "docker-compose"] as const;

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
    _target: string,
    params: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const args = (params.args as string[] | undefined) ?? [];

    try {
      // Docker Compose gets its own binary path
      if (action.toLowerCase().includes("compose")) {
        return await this.handleCompose(action.toLowerCase(), _target, params);
      }

      // Everything else: run docker with exactly the args the LLM provided.
      // The LLM knows the command — don't second-guess it.
      if (args.length === 0) {
        return {
          success: false,
          output: "",
          error: `No docker arguments provided. Set params.args to the full docker command arguments (e.g. ["load", "-i", "/path/to/image.tar"]).`,
        };
      }

      return await this.dockerCommand(args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: "",
        error: `docker ${args.join(" ")} failed: ${message}`,
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

  async dryRun(
    step: PlannedStep,
    _predictedOutcomes: Map<number, Record<string, unknown>>,
  ): Promise<DryRunResult> {
    const observations: DryRunResult["observations"] = [];
    const lower = step.action.toLowerCase();
    const target = step.target;
    const unknowns: string[] = [];

    try {
      // Check if docker CLI is installed (does not contact the daemon)
      const cliInstalled = await new Promise<boolean>((resolve) => {
        execFile("docker", ["--version"], { timeout: 5000 }, (error) => {
          resolve(!error);
        });
      });

      observations.push({
        name: "docker-cli-installed",
        passed: cliInstalled,
        detail: cliInstalled
          ? `Docker CLI is installed`
          : `Docker CLI is not installed — install Docker before deploying container workloads`,
      });

      // Report current daemon state as a fact. The LLM reasons about whether
      // the plan already includes a step to start the daemon — handlers don't
      // attempt to enumerate every possible start command (Docker Desktop, colima,
      // rancher-desktop, podman, systemctl, etc.).
      const daemonRunning = await new Promise<boolean>((resolve) => {
        execFile("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 }, (error) => {
          resolve(!error);
        });
      });

      observations.push({
        name: "docker-daemon-running",
        passed: daemonRunning,
        detail: daemonRunning
          ? `Docker daemon is running and accessible`
          : `Docker daemon is not currently running (checked at plan time)`,
      });

      // For pull: check if image is already available locally
      if (lower.includes("pull") || lower.includes("image")) {
        const imageExists = await new Promise<boolean>((resolve) => {
          execFile("docker", ["image", "inspect", target], { timeout: 10000 }, (error) => {
            resolve(!error);
          });
        });

        observations.push({
          name: "image-available",
          passed: true, // Pull will fetch it if not local
          detail: imageExists
            ? `Image "${target}" is already available locally — pull will update if newer`
            : `Image "${target}" is not available locally — will be pulled from registry`,
        });
      }

      // For run/start: check for container name collision
      if (lower.includes("run") || lower.includes("start")) {
        const containerExists = await new Promise<{ exists: boolean; running: boolean }>((resolve) => {
          execFile("docker", ["inspect", "--format", "{{.State.Running}}", target], { timeout: 5000 }, (error, stdout) => {
            if (error) {
              resolve({ exists: false, running: false });
            } else {
              resolve({ exists: true, running: stdout.trim() === "true" });
            }
          });
        });

        if (containerExists.exists) {
          observations.push({
            name: "container-name-collision",
            passed: !containerExists.running || lower.includes("start"),
            detail: containerExists.running
              ? `Container "${target}" already exists and is running — name collision will cause failure`
              : `Container "${target}" exists but is stopped — start will succeed`,
          });
        }
      }

      unknowns.push(
        `Container startup success depends on image configuration and runtime environment`,
      );

      return {
        observations,
        predictedOutcome: {
          containerAction: lower.includes("stop") ? "stopped" : lower.includes("pull") ? "pulled" : "running",
          containerName: target,
        },
        fidelity: "speculative",
        unknowns,
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
        fidelity: "speculative",
        unknowns: [`Could not verify container environment for "${target}"`],
      };
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
