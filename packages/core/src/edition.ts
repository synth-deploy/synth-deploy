// Synth is self-hosted and free. All features are always available.

export function initEdition(): void {
  console.log("[synth] Edition: Self-Hosted — all features included");
}

export function getEdition(): string {
  return "self-hosted";
}

export function isEnterprise(): boolean {
  return true;
}

export function getMaxEnvoys(): number {
  return 0; // 0 = unlimited
}

export function isPartnership(): boolean {
  return false;
}

export function getLicenseInfo(): null {
  return null;
}

/** Reset cached state — for testing only */
export function _resetEdition(): void {
  // No-op: no cached state
}
