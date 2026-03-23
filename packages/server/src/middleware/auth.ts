import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { IUserStore, IUserRoleStore, ISessionStore, UserId, Permission } from "@synth-deploy/core";

export interface AuthenticatedUser {
  id: UserId;
  email: string;
  name: string;
  permissions: Permission[];
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

const EXEMPT_ROUTES = ["/health", "/api/health", "/api/auth/login", "/api/auth/register", "/api/auth/refresh", "/api/auth/status", "/api/auth/providers", "/api/envoy/report"];
const EXEMPT_PREFIXES = ["/api/auth/oidc/", "/api/auth/callback/oidc/", "/api/auth/saml/", "/api/auth/callback/saml/", "/api/auth/ldap/", "/api/intake/webhook/", "/api/alert-webhooks/receive/"];
// Envoy callback endpoints — validated by envoy token, not user JWT
const EXEMPT_PATTERNS = [/^\/api\/deployments\/[^/]+\/progress$/];

/**
 * Registers JWT-based authentication middleware on a Fastify instance.
 *
 * All /api/ and /mcp routes require a valid JWT Bearer token,
 * except routes listed in EXEMPT_ROUTES. Static file serving and
 * health endpoints are always accessible.
 */
export function registerAuthMiddleware(
  app: FastifyInstance,
  userStore: IUserStore,
  userRoleStore: IUserRoleStore,
  sessionStore: ISessionStore,
  jwtSecret: Uint8Array,
): { enabled: boolean } {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Skip exempt routes
    if (EXEMPT_ROUTES.some((r) => request.url.startsWith(r))) return;
    // Skip OIDC auth routes (dynamic paths)
    if (EXEMPT_PREFIXES.some((p) => request.url.startsWith(p))) return;
    // Skip envoy callback endpoints (validated by envoy token in the route handler)
    if (EXEMPT_PATTERNS.some((p) => p.test(request.url))) return;
    // Also skip static file serving (non-API routes), but NOT /mcp — it requires auth
    if (!request.url.startsWith("/api/") && !request.url.startsWith("/mcp")) return;

    // Accept token from Authorization header or ?token= query param
    // (EventSource API cannot send headers, so SSE endpoints use query param)
    const authHeader = request.headers.authorization;
    const queryToken = (request.query as Record<string, string>)?.token;
    const rawToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : queryToken;
    if (!rawToken) {
      reply.status(401).send({ error: "Authentication required" });
      return;
    }

    const token = rawToken;
    try {
      const { payload } = await jwtVerify(token, jwtSecret);
      const userId = payload.sub as UserId;
      const user = userStore.getById(userId);
      if (!user) {
        reply.status(401).send({ error: "User not found" });
        return;
      }
      const session = sessionStore.getByToken(token);
      if (!session) {
        reply.status(401).send({ error: "Session expired" });
        return;
      }
      const permissions = userRoleStore.getUserPermissions(userId);
      request.user = { id: userId, email: user.email, name: user.name, permissions };
    } catch {
      reply.status(401).send({ error: "Invalid token" });
    }
  });

  return { enabled: true };
}

export async function generateTokens(
  userId: UserId,
  jwtSecret: Uint8Array,
): Promise<{ token: string; refreshToken: string; expiresAt: Date }> {
  const sessionTtl = process.env.SYNTH_SESSION_TTL ?? "8h";
  const sessionTtlMs = sessionTtl.endsWith("h")
    ? parseInt(sessionTtl) * 60 * 60 * 1000
    : sessionTtl.endsWith("m")
    ? parseInt(sessionTtl) * 60 * 1000
    : 8 * 60 * 60 * 1000;

  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(sessionTtl)
    .sign(jwtSecret);

  const refreshToken = await new SignJWT({ sub: userId, type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(jwtSecret);

  return { token, refreshToken, expiresAt: new Date(Date.now() + sessionTtlMs) };
}
