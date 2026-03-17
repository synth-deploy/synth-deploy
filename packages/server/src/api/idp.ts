import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import type {
  IUserStore,
  IRoleStore,
  IUserRoleStore,
  ISessionStore,
  IIdpProviderStore,
  IRoleMappingStore,
  IdpProvider,
  OidcConfig,
  UserId,
  RoleId,
} from "@synth-deploy/core";
import { requirePermission, requireEdition } from "../middleware/permissions.js";
import { generateTokens } from "../middleware/auth.js";
import { OidcAdapter } from "../auth/idp/oidc.js";
import { SamlAdapter } from "../auth/idp/saml.js";
import type { SamlConfig } from "../auth/idp/saml.js";
import { LdapAdapter } from "../auth/idp/ldap.js";
import type { LdapConfig } from "../auth/idp/ldap.js";
import { applyRoleMappings } from "../auth/idp/role-mapping.js";
import {
  CreateIdpProviderSchema,
  UpdateIdpProviderSchema,
  CreateRoleMappingSchema,
} from "./idp-schemas.js";

/** Mask a client secret for API responses — never return the full value. */
function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  return secret.slice(0, 4) + "****" + secret.slice(-4);
}

/** Return a provider with secrets masked. */
function toPublicProvider(provider: IdpProvider): IdpProvider {
  const config = { ...provider.config };
  if (typeof config.clientSecret === "string") {
    config.clientSecret = maskSecret(config.clientSecret);
  }
  if (typeof config.bindCredential === "string") {
    config.bindCredential = maskSecret(config.bindCredential);
  }
  return { ...provider, config };
}

/**
 * OIDC state tokens — in-memory, short-lived.
 * Maps state -> { providerId, createdAt }
 */
const pendingStates = new Map<string, { providerId: string; createdAt: number }>();
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Periodic cleanup of expired states
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingStates) {
    if (now - val.createdAt > STATE_TTL_MS) {
      pendingStates.delete(key);
    }
  }
}, 60_000);

export function registerIdpRoutes(
  app: FastifyInstance,
  idpProviderStore: IIdpProviderStore,
  roleMappingStore: IRoleMappingStore,
  userStore: IUserStore,
  roleStore: IRoleStore,
  userRoleStore: IUserRoleStore,
  sessionStore: ISessionStore,
  jwtSecret: Uint8Array,
  options?: { hasDedicatedEncryptionKey?: boolean },
): void {
  const hasDedicatedEncryptionKey = options?.hasDedicatedEncryptionKey ?? false;
  const oidcAdapter = new OidcAdapter();
  const samlAdapter = new SamlAdapter();
  const ldapAdapter = new LdapAdapter();

  // ─── IdP Provider CRUD (admin only) ───────────────────────────────

  // GET /api/idp/providers — list configured IdPs
  app.get("/api/idp/providers", { preHandler: [requireEdition("sso"), requirePermission("settings.manage")] }, async () => {
    const providers = idpProviderStore.list();
    return { providers: providers.map(toPublicProvider) };
  });

  // POST /api/idp/providers — create new IdP
  app.post("/api/idp/providers", { preHandler: [requireEdition("sso"), requirePermission("settings.manage")] }, async (request, reply) => {
    if (!hasDedicatedEncryptionKey) {
      return reply.status(503).send({
        error: "Encryption key not configured. Set SYNTH_ENCRYPTION_KEY environment variable before configuring identity providers.",
      });
    }

    const parsed = CreateIdpProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const { type, name, enabled, config } = parsed.data;
    const now = new Date();
    const provider: IdpProvider = {
      id: crypto.randomUUID(),
      type: type as IdpProvider["type"],
      name,
      enabled: enabled ?? true,
      config: config as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    };

    idpProviderStore.create(provider);
    return reply.status(201).send({ provider: toPublicProvider(provider) });
  });

  // PUT /api/idp/providers/:id — update IdP config
  app.put<{ Params: { id: string } }>("/api/idp/providers/:id", { preHandler: [requireEdition("sso"), requirePermission("settings.manage")] }, async (request, reply) => {
    if (!hasDedicatedEncryptionKey) {
      return reply.status(503).send({
        error: "Encryption key not configured. Set SYNTH_ENCRYPTION_KEY environment variable before configuring identity providers.",
      });
    }

    const parsed = UpdateIdpProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const existing = idpProviderStore.getById(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: "IdP provider not found" });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
    if (parsed.data.config !== undefined) {
      // If clientSecret or bindCredential is masked (contains ****), preserve the existing one
      const newConfig = parsed.data.config as Record<string, unknown>;
      if (typeof newConfig.clientSecret === "string" && newConfig.clientSecret.includes("****")) {
        newConfig.clientSecret = (existing.config as Record<string, unknown>).clientSecret;
      }
      if (typeof newConfig.bindCredential === "string" && newConfig.bindCredential.includes("****")) {
        newConfig.bindCredential = (existing.config as Record<string, unknown>).bindCredential;
      }
      updates.config = newConfig;
    }

    const provider = idpProviderStore.update(
      request.params.id,
      updates as Parameters<typeof idpProviderStore.update>[1],
    );
    return { provider: toPublicProvider(provider) };
  });

  // DELETE /api/idp/providers/:id — remove IdP
  app.delete<{ Params: { id: string } }>("/api/idp/providers/:id", { preHandler: [requireEdition("sso"), requirePermission("settings.manage")] }, async (request, reply) => {
    const existing = idpProviderStore.getById(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: "IdP provider not found" });
    }
    idpProviderStore.delete(request.params.id);
    return reply.status(204).send();
  });

  // POST /api/idp/providers/:id/test — test connection
  app.post<{ Params: { id: string } }>("/api/idp/providers/:id/test", { preHandler: [requireEdition("sso"), requirePermission("settings.manage")] }, async (request, reply) => {
    const provider = idpProviderStore.getById(request.params.id);
    if (!provider) {
      return reply.status(404).send({ error: "IdP provider not found" });
    }

    if (provider.type === "oidc") {
      const result = await oidcAdapter.validateConfig(provider.config);
      return { success: result.valid, error: result.error };
    }

    if (provider.type === "saml") {
      const result = await samlAdapter.validateConfig(provider.config);
      return { success: result.valid, error: result.error };
    }

    if (provider.type === "ldap") {
      const result = await ldapAdapter.testConnection(provider.config as unknown as LdapConfig);
      return { success: result.success, error: result.error };
    }

    return reply.status(400).send({ error: `Test not supported for provider type: ${provider.type}` });
  });

  // ─── Role Mapping CRUD ────────────────────────────────────────────

  // GET /api/idp/providers/:id/mappings — list role mapping rules
  app.get<{ Params: { id: string } }>("/api/idp/providers/:id/mappings", { preHandler: [requireEdition("sso"), requirePermission("settings.manage")] }, async (request, reply) => {
    const provider = idpProviderStore.getById(request.params.id);
    if (!provider) {
      return reply.status(404).send({ error: "IdP provider not found" });
    }
    const mappings = roleMappingStore.listByProvider(request.params.id);
    return { mappings };
  });

  // POST /api/idp/providers/:id/mappings — add role mapping rule
  app.post<{ Params: { id: string } }>("/api/idp/providers/:id/mappings", { preHandler: [requireEdition("sso"), requirePermission("settings.manage")] }, async (request, reply) => {
    const provider = idpProviderStore.getById(request.params.id);
    if (!provider) {
      return reply.status(404).send({ error: "IdP provider not found" });
    }

    const parsed = CreateRoleMappingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const rule = roleMappingStore.create({
      id: crypto.randomUUID(),
      providerId: request.params.id,
      idpGroup: parsed.data.idpGroup,
      synthRole: parsed.data.synthRole,
    });

    return reply.status(201).send({ mapping: rule });
  });

  // DELETE /api/idp/mappings/:id — remove mapping rule
  app.delete<{ Params: { id: string } }>("/api/idp/mappings/:id", { preHandler: [requireEdition("sso"), requirePermission("settings.manage")] }, async (request, reply) => {
    const existing = roleMappingStore.getById(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: "Role mapping not found" });
    }
    roleMappingStore.delete(request.params.id);
    return reply.status(204).send();
  });

  // ─── OIDC Auth Routes (exempt from auth middleware) ───────────────

  // GET /api/auth/oidc/:providerId/authorize — redirect to IdP
  app.get<{ Params: { providerId: string } }>("/api/auth/oidc/:providerId/authorize", async (request, reply) => {
    const provider = idpProviderStore.getById(request.params.providerId);
    if (!provider || !provider.enabled) {
      return reply.status(404).send({ error: "Identity provider not found or disabled" });
    }
    if (provider.type !== "oidc") {
      return reply.status(400).send({ error: "Provider is not an OIDC provider" });
    }

    const config = provider.config as unknown as OidcConfig;
    const state = crypto.randomUUID();
    pendingStates.set(state, { providerId: provider.id, createdAt: Date.now() });

    // Build redirect URI based on the current request
    const proto = (request.headers["x-forwarded-proto"] as string) ?? "http";
    const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost:3000";
    const redirectUri = `${proto}://${host}/api/auth/callback/oidc/${provider.id}`;

    const authUrl = await oidcAdapter.getAuthorizationUrl(config, redirectUri, state);
    return reply.redirect(authUrl);
  });

  // GET /api/auth/callback/oidc/:providerId — OIDC callback
  app.get<{ Params: { providerId: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/callback/oidc/:providerId",
    async (request, reply) => {
      const { code, state, error: oidcError } = request.query as { code?: string; state?: string; error?: string };

      if (oidcError) {
        return reply.status(400).send({ error: `OIDC error: ${oidcError}` });
      }

      if (!code || !state) {
        return reply.status(400).send({ error: "Missing code or state parameter" });
      }

      // Validate state
      const pendingState = pendingStates.get(state);
      if (!pendingState || pendingState.providerId !== request.params.providerId) {
        return reply.status(400).send({ error: "Invalid or expired state parameter" });
      }
      pendingStates.delete(state);

      // Check if state has expired
      if (Date.now() - pendingState.createdAt > STATE_TTL_MS) {
        return reply.status(400).send({ error: "State parameter expired" });
      }

      const provider = idpProviderStore.getById(request.params.providerId);
      if (!provider || !provider.enabled) {
        return reply.status(404).send({ error: "Identity provider not found or disabled" });
      }

      const config = provider.config as unknown as OidcConfig;
      const proto = (request.headers["x-forwarded-proto"] as string) ?? "http";
      const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost:3000";
      const redirectUri = `${proto}://${host}/api/auth/callback/oidc/${provider.id}`;

      // Exchange code for user info
      let idpUser;
      try {
        idpUser = await oidcAdapter.authenticate({ code, redirectUri, config });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown OIDC error";
        return reply.status(500).send({ error: `OIDC authentication failed: ${message}` });
      }

      if (!idpUser.email) {
        return reply.status(400).send({ error: "OIDC provider did not return an email address" });
      }

      // Provision or update user
      let user = userStore.getByExternalId(idpUser.externalId, "oidc");
      if (!user) {
        // Check if a local user exists with this email
        user = userStore.getByEmail(idpUser.email);
        if (user && user.authSource === "local") {
          // Link existing local user to OIDC
          user = userStore.update(user.id, {
            externalId: idpUser.externalId,
            authSource: "oidc",
            name: idpUser.displayName || user.name,
            updatedAt: new Date(),
          });
        } else if (!user) {
          // Create new user
          const userId = crypto.randomUUID() as UserId;
          const now = new Date();
          user = userStore.create({
            id: userId,
            email: idpUser.email,
            name: idpUser.displayName || idpUser.email,
            passwordHash: await bcrypt.hash(crypto.randomUUID(), 10), // random password — user authenticates via OIDC
            authSource: "oidc",
            externalId: idpUser.externalId,
            createdAt: now,
            updatedAt: now,
          });
        }
      } else {
        // Update existing OIDC user
        user = userStore.update(user.id, {
          email: idpUser.email,
          name: idpUser.displayName || user.name,
          updatedAt: new Date(),
        });
      }

      // Apply role mappings
      const mappingRules = roleMappingStore.listByProvider(provider.id);
      const mappedRoleNames = applyRoleMappings(idpUser, mappingRules);
      if (mappedRoleNames.length > 0) {
        const roleIds: RoleId[] = [];
        for (const roleName of mappedRoleNames) {
          const role = roleStore.getByName(roleName);
          if (role) roleIds.push(role.id);
        }
        if (roleIds.length > 0) {
          userRoleStore.setRoles(user.id, roleIds, user.id);
        }
      }

      // Create session and generate tokens
      const tokens = await generateTokens(user.id, jwtSecret);
      sessionStore.create({
        id: crypto.randomUUID(),
        userId: user.id,
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        createdAt: new Date(),
        userAgent: request.headers["user-agent"] ?? undefined,
        ipAddress: request.ip ?? undefined,
      });

      // Redirect to UI with token (the UI picks this up and stores it)
      const uiRedirect = `/?oidc_token=${encodeURIComponent(tokens.token)}&oidc_refresh=${encodeURIComponent(tokens.refreshToken)}`;
      return reply.redirect(uiRedirect);
    },
  );

  // ─── SAML Auth Routes (exempt from auth middleware) ─────────────────

  // GET /api/auth/saml/:providerId/authorize — generate AuthnRequest, redirect to IdP
  app.get<{ Params: { providerId: string } }>("/api/auth/saml/:providerId/authorize", async (request, reply) => {
    const provider = idpProviderStore.getById(request.params.providerId);
    if (!provider || !provider.enabled) {
      return reply.status(404).send({ error: "Identity provider not found or disabled" });
    }
    if (provider.type !== "saml") {
      return reply.status(400).send({ error: "Provider is not a SAML provider" });
    }

    const config = provider.config as unknown as SamlConfig;

    // Build the ACS callback URL based on the current request
    const proto = (request.headers["x-forwarded-proto"] as string) ?? "http";
    const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost:3000";
    const callbackUrl = `${proto}://${host}/api/auth/callback/saml/${provider.id}`;

    // Ensure config has the correct callbackUrl for this request
    const effectiveConfig: SamlConfig = {
      ...config,
      callbackUrl,
      groupsAttribute: config.groupsAttribute || "memberOf",
      signatureAlgorithm: config.signatureAlgorithm || "sha256",
    };

    // Generate state for relay
    const state = crypto.randomUUID();
    pendingStates.set(state, { providerId: provider.id, createdAt: Date.now() });

    try {
      const authUrl = await samlAdapter.getAuthorizationUrl(effectiveConfig, state);
      return reply.redirect(authUrl);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown SAML error";
      return reply.status(500).send({ error: `Failed to generate SAML AuthnRequest: ${message}` });
    }
  });

  // POST /api/auth/callback/saml/:providerId — handle SAML Response (ACS endpoint)
  app.post<{ Params: { providerId: string } }>(
    "/api/auth/callback/saml/:providerId",
    async (request, reply) => {
      const body = request.body as Record<string, string> | undefined;
      const samlResponse = body?.SAMLResponse;
      const relayState = body?.RelayState;

      if (!samlResponse) {
        return reply.status(400).send({ error: "Missing SAMLResponse in request body" });
      }

      // Validate relay state if present
      if (relayState) {
        const pendingState = pendingStates.get(relayState);
        if (!pendingState || pendingState.providerId !== request.params.providerId) {
          return reply.status(400).send({ error: "Invalid or expired relay state" });
        }
        pendingStates.delete(relayState);

        if (Date.now() - pendingState.createdAt > STATE_TTL_MS) {
          return reply.status(400).send({ error: "Relay state expired" });
        }
      }

      const provider = idpProviderStore.getById(request.params.providerId);
      if (!provider || !provider.enabled) {
        return reply.status(404).send({ error: "Identity provider not found or disabled" });
      }

      const config = provider.config as unknown as SamlConfig;
      const proto = (request.headers["x-forwarded-proto"] as string) ?? "http";
      const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost:3000";
      const callbackUrl = `${proto}://${host}/api/auth/callback/saml/${provider.id}`;

      const effectiveConfig: SamlConfig = {
        ...config,
        callbackUrl,
        groupsAttribute: config.groupsAttribute || "memberOf",
        signatureAlgorithm: config.signatureAlgorithm || "sha256",
      };

      // Validate SAML Response and extract user
      let idpUser;
      try {
        idpUser = await samlAdapter.authenticate({ samlResponse, config: effectiveConfig });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown SAML error";
        return reply.status(500).send({ error: `SAML authentication failed: ${message}` });
      }

      if (!idpUser.email) {
        return reply.status(400).send({ error: "SAML provider did not return an email address" });
      }

      // Provision or update user (same pattern as OIDC)
      let user = userStore.getByExternalId(idpUser.externalId, "saml");
      if (!user) {
        user = userStore.getByEmail(idpUser.email);
        if (user && user.authSource === "local") {
          // Link existing local user to SAML
          user = userStore.update(user.id, {
            externalId: idpUser.externalId,
            authSource: "saml",
            name: idpUser.displayName || user.name,
            updatedAt: new Date(),
          });
        } else if (!user) {
          // Create new user
          const userId = crypto.randomUUID() as UserId;
          const now = new Date();
          user = userStore.create({
            id: userId,
            email: idpUser.email,
            name: idpUser.displayName || idpUser.email,
            passwordHash: await bcrypt.hash(crypto.randomUUID(), 10), // random password — user authenticates via SAML
            authSource: "saml",
            externalId: idpUser.externalId,
            createdAt: now,
            updatedAt: now,
          });
        }
      } else {
        // Update existing SAML user
        user = userStore.update(user.id, {
          email: idpUser.email,
          name: idpUser.displayName || user.name,
          updatedAt: new Date(),
        });
      }

      // Apply role mappings
      const mappingRules = roleMappingStore.listByProvider(provider.id);
      const mappedRoleNames = applyRoleMappings(idpUser, mappingRules);
      if (mappedRoleNames.length > 0) {
        const roleIds: RoleId[] = [];
        for (const roleName of mappedRoleNames) {
          const role = roleStore.getByName(roleName);
          if (role) roleIds.push(role.id);
        }
        if (roleIds.length > 0) {
          userRoleStore.setRoles(user.id, roleIds, user.id);
        }
      }

      // Create session and generate tokens
      const tokens = await generateTokens(user.id, jwtSecret);
      sessionStore.create({
        id: crypto.randomUUID(),
        userId: user.id,
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        createdAt: new Date(),
        userAgent: request.headers["user-agent"] ?? undefined,
        ipAddress: request.ip ?? undefined,
      });

      // Redirect to UI with token
      const uiRedirect = `/?saml_token=${encodeURIComponent(tokens.token)}&saml_refresh=${encodeURIComponent(tokens.refreshToken)}`;
      return reply.redirect(uiRedirect);
    },
  );

  // GET /api/auth/saml/:providerId/metadata — return SP metadata XML
  app.get<{ Params: { providerId: string } }>("/api/auth/saml/:providerId/metadata", async (request, reply) => {
    const provider = idpProviderStore.getById(request.params.providerId);
    if (!provider) {
      return reply.status(404).send({ error: "Identity provider not found" });
    }
    if (provider.type !== "saml") {
      return reply.status(400).send({ error: "Provider is not a SAML provider" });
    }

    const config = provider.config as unknown as SamlConfig;
    const proto = (request.headers["x-forwarded-proto"] as string) ?? "http";
    const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost:3000";
    const callbackUrl = `${proto}://${host}/api/auth/callback/saml/${provider.id}`;

    const effectiveConfig: SamlConfig = {
      ...config,
      callbackUrl,
      groupsAttribute: config.groupsAttribute || "memberOf",
      signatureAlgorithm: config.signatureAlgorithm || "sha256",
    };

    try {
      const metadata = samlAdapter.generateMetadata(effectiveConfig);
      reply.type("application/xml");
      return reply.send(metadata);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return reply.status(500).send({ error: `Failed to generate SP metadata: ${message}` });
    }
  });

  // ─── LDAP Auth Routes ────────────────────────────────────────────────

  // POST /api/auth/ldap/:providerId/login — username/password login via LDAP
  app.post<{ Params: { providerId: string } }>(
    "/api/auth/ldap/:providerId/login",
    async (request, reply) => {
      const provider = idpProviderStore.getById(request.params.providerId);
      if (!provider || !provider.enabled) {
        return reply.status(404).send({ error: "Identity provider not found or disabled" });
      }
      if (provider.type !== "ldap") {
        return reply.status(400).send({ error: "Provider is not an LDAP provider" });
      }

      const body = request.body as Record<string, string> | undefined;
      const username = body?.username;
      const password = body?.password;

      if (!username || !password) {
        return reply.status(400).send({ error: "Username and password are required" });
      }

      const config = provider.config as unknown as LdapConfig;

      // Authenticate against LDAP
      let idpUser;
      try {
        idpUser = await ldapAdapter.authenticate({ username, password, config });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown LDAP error";
        return reply.status(401).send({ error: `LDAP authentication failed: ${message}` });
      }

      if (!idpUser.email) {
        return reply.status(400).send({ error: "LDAP directory did not return an email address for this user" });
      }

      // Provision or update user (same pattern as OIDC/SAML)
      let user = userStore.getByExternalId(idpUser.externalId, "ldap");
      if (!user) {
        // Check if a local user exists with this email
        user = userStore.getByEmail(idpUser.email);
        if (user && user.authSource === "local") {
          // Link existing local user to LDAP
          user = userStore.update(user.id, {
            externalId: idpUser.externalId,
            authSource: "ldap",
            name: idpUser.displayName || user.name,
            updatedAt: new Date(),
          });
        } else if (!user) {
          // Create new user
          const userId = crypto.randomUUID() as UserId;
          const now = new Date();
          user = userStore.create({
            id: userId,
            email: idpUser.email,
            name: idpUser.displayName || idpUser.email,
            passwordHash: await bcrypt.hash(crypto.randomUUID(), 10), // random password — user authenticates via LDAP
            authSource: "ldap",
            externalId: idpUser.externalId,
            createdAt: now,
            updatedAt: now,
          });
        }
      } else {
        // Update existing LDAP user
        user = userStore.update(user.id, {
          email: idpUser.email,
          name: idpUser.displayName || user.name,
          updatedAt: new Date(),
        });
      }

      // Apply role mappings
      const mappingRules = roleMappingStore.listByProvider(provider.id);
      const mappedRoleNames = applyRoleMappings(idpUser, mappingRules);
      if (mappedRoleNames.length > 0) {
        const roleIds: RoleId[] = [];
        for (const roleName of mappedRoleNames) {
          const role = roleStore.getByName(roleName);
          if (role) roleIds.push(role.id);
        }
        if (roleIds.length > 0) {
          userRoleStore.setRoles(user.id, roleIds, user.id);
        }
      }

      // Create session and generate tokens
      const tokens = await generateTokens(user.id, jwtSecret);
      const now = new Date();
      sessionStore.create({
        id: crypto.randomUUID(),
        userId: user.id,
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        createdAt: now,
        userAgent: request.headers["user-agent"] ?? undefined,
        ipAddress: request.ip ?? undefined,
      });

      const permissions = userRoleStore.getUserPermissions(user.id);

      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          authSource: user.authSource ?? "ldap",
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
        token: tokens.token,
        refreshToken: tokens.refreshToken,
        permissions,
      };
    },
  );

  // POST /api/idp/providers/:id/test-ldap-user — test user search (admin only)
  app.post<{ Params: { id: string } }>(
    "/api/idp/providers/:id/test-ldap-user",
    { preHandler: [requireEdition("sso"), requirePermission("settings.manage")] },
    async (request, reply) => {
      const provider = idpProviderStore.getById(request.params.id);
      if (!provider) {
        return reply.status(404).send({ error: "IdP provider not found" });
      }
      if (provider.type !== "ldap") {
        return reply.status(400).send({ error: "Provider is not an LDAP provider" });
      }

      const body = request.body as Record<string, string> | undefined;
      const username = body?.username;
      if (!username) {
        return reply.status(400).send({ error: "username is required in request body" });
      }

      const config = provider.config as unknown as LdapConfig;
      const result = await ldapAdapter.testUser(config, username);
      return result;
    },
  );

  // ─── Public: list enabled providers (for login page) ──────────────

  // GET /api/auth/providers — list enabled IdPs (public, for login page)
  app.get("/api/auth/providers", async () => {
    const providers = idpProviderStore.list()
      .filter((p) => p.enabled)
      .map((p) => ({
        id: p.id,
        type: p.type,
        name: p.name,
      }));
    return { providers };
  });
}
