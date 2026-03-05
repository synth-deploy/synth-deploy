import type { IdpUser } from "@deploystack/core";

/**
 * Adapter interface for Identity Provider integrations.
 * Each IdP type (OIDC, SAML, LDAP) implements this interface.
 */
export interface IdpAdapter {
  /** The IdP type this adapter handles */
  type: string;

  /**
   * Authenticates a user via IdP-specific mechanism.
   * For OIDC: exchanges an authorization code for tokens and extracts user info.
   */
  authenticate(params: unknown): Promise<IdpUser>;

  /**
   * Validates that a given config object is well-formed for this IdP type.
   * Used when creating or updating an IdP provider configuration.
   */
  validateConfig(config: unknown): Promise<{ valid: boolean; error?: string }>;
}
