import { SynthLogger } from "@synth-deploy/core";

let _logger: SynthLogger | null = null;

export function initServerLogger(dataDir: string): void {
  _logger = new SynthLogger(dataDir, "server");
}

export function serverLog(label: string, data?: unknown): void {
  _logger?.log(label, data);
}

export function serverWarn(label: string, data?: unknown): void {
  _logger?.warn(label, data);
}

export function serverError(label: string, data?: unknown): void {
  _logger?.error(label, data);
}
