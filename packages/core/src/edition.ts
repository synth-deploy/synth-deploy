import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// --- Types ---

export type Edition = "community" | "enterprise";

export interface LicensePayload {
  edition: "enterprise";
  licensee: string;
  email: string;
  issuedAt: string;
  expiresAt: string;
  maxEnvoys: number; // 0 = unlimited
  partnership?: boolean;
  signature: string;
}

export interface LicenseInfo {
  licensee: string;
  email: string;
  expiresAt: string;
  maxEnvoys: number;
  partnership: boolean;
}

// --- Enterprise feature registry ---

export const ENTERPRISE_FEATURES = {
  "fleet-deployments":
    "Fleet deployment orchestration (batched, canary rollouts)",
  "deployment-graphs": "Multi-artifact deployment dependency graphs",
  sso: "SSO authentication (OIDC, SAML, LDAP)",
  "custom-roles": "Custom role definitions with granular permissions",
  "multi-provider-llm": "Multiple LLM providers with fallback chains",
  "task-model-routing": "Per-task model configuration",
  "llm-postmortem": "LLM-generated postmortem analysis",
  "artifact-annotations": "Operator corrections to artifact analysis",
  "mcp-servers": "External MCP server registration",
  "co-branding": "Custom branding (operator name, logo, accent color)",
  "telemetry-export": "Telemetry event export",
  "configurable-retention": "Custom debrief retention policies",
  "unlimited-envoys": "More than 10 registered envoy agents",
} as const;

export type EnterpriseFeature = keyof typeof ENTERPRISE_FEATURES;

const COMMUNITY_MAX_ENVOYS = 10;

// --- Error ---

export class EditionError extends Error {
  readonly featureName: string;
  readonly edition: Edition;

  constructor(featureName: string) {
    const description =
      ENTERPRISE_FEATURES[featureName as EnterpriseFeature] ?? featureName;
    super(
      `${description} requires Synth Enterprise. Visit synthdeploy.com for licensing.`
    );
    this.name = "EditionError";
    this.featureName = featureName;
    this.edition = "community";
  }
}

// --- Internal state ---

let cachedEdition: Edition | null = null;
let cachedLicense: LicensePayload | null = null;

// --- License resolution ---

function verifySignature(payload: LicensePayload): boolean {
  const signingKey = process.env.SYNTH_LICENSE_SIGNING_KEY;
  if (!signingKey) return true; // no signing key = skip verification (dev mode)

  const { signature, ...rest } = payload;
  const data = JSON.stringify(rest);
  const expected = createHmac("sha256", signingKey).update(data).digest("hex");
  return expected === signature;
}

function loadLicenseFromString(raw: string): LicensePayload | null {
  try {
    const decoded = Buffer.from(raw.trim(), "base64").toString("utf-8");
    const payload = JSON.parse(decoded) as LicensePayload;

    if (payload.edition !== "enterprise") {
      console.warn("[synth] License key has invalid edition field, ignoring");
      return null;
    }

    if (!verifySignature(payload)) {
      console.warn("[synth] License key signature verification failed, ignoring");
      return null;
    }

    if (new Date(payload.expiresAt) < new Date()) {
      console.warn(
        `[synth] License key expired on ${payload.expiresAt}, falling back to Community edition`
      );
      return null;
    }

    return payload;
  } catch {
    console.warn("[synth] Failed to parse license key, ignoring");
    return null;
  }
}

function resolveLicense(): { edition: Edition; license: LicensePayload | null } {
  // 1. Check env var
  const envKey = process.env.SYNTH_LICENSE_KEY;
  if (envKey) {
    const license = loadLicenseFromString(envKey);
    if (license) return { edition: "enterprise", license };
  }

  // 2. Check license file
  const filePath = process.env.SYNTH_LICENSE_FILE || resolve("synth.license");
  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const license = loadLicenseFromString(content);
      if (license) return { edition: "enterprise", license };
    } catch {
      console.warn(`[synth] Failed to read license file at ${filePath}`);
    }
  }

  // 3. Default: community
  return { edition: "community", license: null };
}

// --- Public API ---

export function initEdition(): Edition {
  const { edition, license } = resolveLicense();
  cachedEdition = edition;
  cachedLicense = license;

  if (edition === "enterprise") {
    const tag = license?.partnership ? " (Pioneer Program)" : "";
    console.log(
      `[synth] Edition: Enterprise${tag} — licensed to ${license!.licensee}, expires ${license!.expiresAt}`
    );
  } else {
    console.log("[synth] Edition: Community");
  }

  return edition;
}

export function getEdition(): Edition {
  if (cachedEdition === null) initEdition();
  return cachedEdition!;
}

export function isEnterprise(): boolean {
  return getEdition() === "enterprise";
}

export function requireEnterprise(featureName: string): void {
  if (!isEnterprise()) {
    throw new EditionError(featureName);
  }
}

export function getMaxEnvoys(): number {
  if (!isEnterprise()) return COMMUNITY_MAX_ENVOYS;
  return cachedLicense?.maxEnvoys ?? 0; // 0 = unlimited
}

export function isPartnership(): boolean {
  return isEnterprise() && cachedLicense?.partnership === true;
}

export function getLicenseInfo(): LicenseInfo | null {
  if (!isEnterprise() || !cachedLicense) return null;
  return {
    licensee: cachedLicense.licensee,
    email: cachedLicense.email,
    expiresAt: cachedLicense.expiresAt,
    maxEnvoys: cachedLicense.maxEnvoys,
    partnership: cachedLicense.partnership ?? false,
  };
}

/** Reset cached state — for testing only */
export function _resetEdition(): void {
  cachedEdition = null;
  cachedLicense = null;
}
