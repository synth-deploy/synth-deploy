import { SynthLogger } from "@synth-deploy/core";

let _logger: SynthLogger | null = null;

export function initEnvoyLogger(baseDir: string): void {
  _logger = new SynthLogger(baseDir, "envoy");
}

export function envoyLog(label: string, data?: unknown): void {
  _logger?.log(label, data);
}

export function envoyWarn(label: string, data?: unknown): void {
  _logger?.warn(label, data);
}

export function envoyError(label: string, data?: unknown): void {
  _logger?.error(label, data);
}
