import { SAML } from "@node-saml/node-saml";
import type { IdpUser } from "@synth-deploy/core";
import type { IdpAdapter } from "./types.js";

export interface SamlConfig {
  entryPoint: string;       // IdP SSO URL
  issuer: string;           // SP entity ID
  cert: string;             // IdP signing certificate (PEM)
  callbackUrl: string;      // ACS URL
  signatureAlgorithm: "sha256" | "sha512";
  groupsAttribute: string;  // default: "memberOf"
}

export interface SamlAuthenticateParams {
  samlResponse: string;
  config: SamlConfig;
}

/**
 * SAML 2.0 adapter — implements IdpAdapter for SAML identity providers.
 *
 * Uses @node-saml/node-saml for AuthnRequest generation, SAML Response
 * validation, and assertion parsing. Stateless: each call constructs a
 * fresh SAML instance from config.
 */
export class SamlAdapter implements IdpAdapter {
  type = "saml";

  private buildSaml(config: SamlConfig): SAML {
    return new SAML({
      entryPoint: config.entryPoint,
      issuer: config.issuer,
      idpCert: config.cert,
      callbackUrl: config.callbackUrl,
      signatureAlgorithm: config.signatureAlgorithm === "sha512" ? "sha512" : "sha256",
      wantAuthnResponseSigned: true,
      wantAssertionsSigned: false,
    });
  }

  async authenticate(params: unknown): Promise<IdpUser> {
    const { samlResponse, config } = params as SamlAuthenticateParams;

    const saml = this.buildSaml(config);

    // Validate and parse the SAML Response
    const { profile } = await saml.validatePostResponseAsync({
      SAMLResponse: samlResponse,
    });

    if (!profile) {
      throw new Error("SAML response did not contain a valid profile");
    }

    // Extract user attributes
    const email = profile.nameID
      || (profile as Record<string, unknown>)["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] as string
      || (profile as Record<string, unknown>).email as string
      || "";

    const displayName =
      (profile as Record<string, unknown>)["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"] as string
      || (profile as Record<string, unknown>).displayName as string
      || (profile as Record<string, unknown>)["http://schemas.microsoft.com/identity/claims/displayname"] as string
      || email;

    // Extract groups from the configured attribute
    const groupsAttribute = config.groupsAttribute || "memberOf";
    const rawGroups = (profile as Record<string, unknown>)[groupsAttribute];
    let groups: string[] = [];
    if (Array.isArray(rawGroups)) {
      groups = rawGroups.map(String);
    } else if (typeof rawGroups === "string") {
      groups = [rawGroups];
    }

    return {
      externalId: profile.nameID || "",
      email,
      displayName,
      groups,
      provider: "saml",
    };
  }

  async validateConfig(config: unknown): Promise<{ valid: boolean; error?: string }> {
    const c = config as Record<string, unknown>;

    if (!c.entryPoint || typeof c.entryPoint !== "string") {
      return { valid: false, error: "entryPoint is required and must be a string" };
    }
    if (!c.issuer || typeof c.issuer !== "string") {
      return { valid: false, error: "issuer is required and must be a string" };
    }
    if (!c.cert || typeof c.cert !== "string") {
      return { valid: false, error: "cert is required and must be a string" };
    }
    if (!c.callbackUrl || typeof c.callbackUrl !== "string") {
      return { valid: false, error: "callbackUrl is required and must be a string" };
    }

    // Validate URL formats
    try {
      new URL(c.entryPoint);
    } catch {
      return { valid: false, error: "entryPoint must be a valid URL" };
    }
    try {
      new URL(c.callbackUrl);
    } catch {
      return { valid: false, error: "callbackUrl must be a valid URL" };
    }

    // Validate signatureAlgorithm if provided
    if (c.signatureAlgorithm && !["sha256", "sha512"].includes(c.signatureAlgorithm as string)) {
      return { valid: false, error: "signatureAlgorithm must be 'sha256' or 'sha512'" };
    }

    // Validate PEM certificate format (basic check)
    const cert = c.cert as string;
    const pemPattern = /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;
    const isBase64Block = /^[A-Za-z0-9+/\s=]+$/.test(cert.trim());
    if (!pemPattern.test(cert) && !isBase64Block) {
      return { valid: false, error: "cert must be a valid PEM-encoded certificate or base64 certificate body" };
    }

    return { valid: true };
  }

  /**
   * Generates the AuthnRequest URL to redirect the user to the SAML IdP.
   */
  async getAuthorizationUrl(config: SamlConfig, relayState?: string): Promise<string> {
    const saml = this.buildSaml(config);
    const url = await saml.getAuthorizeUrlAsync(relayState ?? "", undefined, {});
    return url;
  }

  /**
   * Generates SP metadata XML for the configured SAML service provider.
   * This metadata can be provided to the IdP administrator for trust configuration.
   */
  generateMetadata(config: SamlConfig): string {
    const saml = this.buildSaml(config);
    const metadata = saml.generateServiceProviderMetadata(null, null);
    return metadata;
  }
}
