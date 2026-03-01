import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/**
 * Registers API key authentication middleware on a Fastify instance.
 *
 * Behavior:
 * - If DEPLOYSTACK_API_KEY is not set, auth is disabled (development mode).
 * - If set, all requests except GET /health require a valid
 *   Authorization: Bearer <key> header.
 * - Returns 401 { error: "Unauthorized" } on missing or invalid credentials.
 */
export function registerAuthMiddleware(app: FastifyInstance): { enabled: boolean } {
  const apiKey = process.env.DEPLOYSTACK_API_KEY;

  if (!apiKey) {
    app.log.warn("DEPLOYSTACK_API_KEY not set — authentication disabled (development mode)");
    return { enabled: false };
  }

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Health endpoint is always public
    if (request.url === "/health") {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const token = authHeader.slice(7);
    if (token !== apiKey) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  return { enabled: true };
}
