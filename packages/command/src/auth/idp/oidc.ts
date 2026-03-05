import * as client from "openid-client";
import type { IdpUser, OidcConfig } from "@deploystack/core";
import type { IdpAdapter } from "./types.js";

export interface OidcAuthenticateParams {
  code: string;
  redirectUri: string;
  config: OidcConfig;
}

/**
 * OIDC adapter — implements IdpAdapter for OpenID Connect providers.
 *
 * Uses the openid-client library for OIDC discovery and code exchange.
 * Stateless: each authenticate call performs discovery fresh (the library
 * caches internally).
 */
export class OidcAdapter implements IdpAdapter {
  type = "oidc";

  async authenticate(params: unknown): Promise<IdpUser> {
    const { code, redirectUri, config } = params as OidcAuthenticateParams;

    // Discover the OIDC provider configuration
    const issuer = new URL(config.issuerUrl);
    const oidcConfig = await client.discovery(issuer, config.clientId, config.clientSecret);

    // Exchange authorization code for tokens
    const tokens = await client.authorizationCodeGrant(oidcConfig, new URL(`${redirectUri}?code=${code}`), {
      expectedState: undefined,
    });

    // Extract user info claims from the ID token or userinfo endpoint
    const claims = tokens.claims();
    let userInfo: Record<string, unknown> = {};
    if (claims) {
      userInfo = claims as unknown as Record<string, unknown>;
    }

    // If we need more claims, fetch from userinfo endpoint
    try {
      const fetchedInfo = await client.fetchUserInfo(oidcConfig, tokens.access_token!, claims?.sub as string);
      userInfo = { ...userInfo, ...fetchedInfo };
    } catch {
      // UserInfo endpoint may not be available; rely on ID token claims
    }

    // Extract groups from the configured claim
    const groupsClaim = config.groupsClaim || "groups";
    const groups: string[] = Array.isArray(userInfo[groupsClaim])
      ? (userInfo[groupsClaim] as string[])
      : [];

    return {
      externalId: (userInfo.sub as string) ?? "",
      email: (userInfo.email as string) ?? "",
      displayName: (userInfo.name as string) ?? (userInfo.preferred_username as string) ?? "",
      groups,
      provider: "oidc",
    };
  }

  async validateConfig(config: unknown): Promise<{ valid: boolean; error?: string }> {
    const c = config as Record<string, unknown>;

    if (!c.issuerUrl || typeof c.issuerUrl !== "string") {
      return { valid: false, error: "issuerUrl is required and must be a string" };
    }
    if (!c.clientId || typeof c.clientId !== "string") {
      return { valid: false, error: "clientId is required and must be a string" };
    }
    if (!c.clientSecret || typeof c.clientSecret !== "string") {
      return { valid: false, error: "clientSecret is required and must be a string" };
    }

    // Validate URL format
    try {
      new URL(c.issuerUrl);
    } catch {
      return { valid: false, error: "issuerUrl must be a valid URL" };
    }

    // Attempt OIDC discovery to verify the issuer is reachable
    try {
      const issuer = new URL(c.issuerUrl);
      await client.discovery(issuer, c.clientId, c.clientSecret);
      return { valid: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { valid: false, error: `OIDC discovery failed: ${message}` };
    }
  }

  /**
   * Builds the authorization URL to redirect the user to the IdP.
   */
  async getAuthorizationUrl(config: OidcConfig, redirectUri: string, state: string): Promise<string> {
    const issuer = new URL(config.issuerUrl);
    const oidcConfig = await client.discovery(issuer, config.clientId, config.clientSecret);

    const authEndpoint = oidcConfig.serverMetadata().authorization_endpoint;
    if (!authEndpoint) {
      throw new Error("OIDC provider does not expose an authorization_endpoint");
    }

    const scopes = config.scopes?.length > 0 ? config.scopes.join(" ") : "openid profile email";
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      state,
    });

    return `${authEndpoint}?${params.toString()}`;
  }
}
