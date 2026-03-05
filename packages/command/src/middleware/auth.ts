import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { IUserStore, IUserRoleStore, ISessionStore, UserId, Permission } from "@deploystack/core";

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

const EXEMPT_ROUTES = ["/health", "/api/health", "/api/auth/login", "/api/auth/register", "/api/auth/refresh", "/api/auth/status", "/api/auth/providers"];
const EXEMPT_PREFIXES = ["/api/auth/oidc/", "/api/auth/callback/oidc/"];

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
    // Also skip static file serving (non-API routes)
    if (!request.url.startsWith("/api/") && request.url !== "/mcp") return;

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      reply.status(401).send({ error: "Authentication required" });
      return;
    }

    const token = authHeader.slice(7);
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
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("15m")
    .sign(jwtSecret);

  const refreshToken = await new SignJWT({ sub: userId, type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
    .sign(jwtSecret);

  return { token, refreshToken, expiresAt: new Date(Date.now() + 15 * 60 * 1000) };
}
