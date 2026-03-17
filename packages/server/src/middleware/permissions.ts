import type { FastifyRequest, FastifyReply } from "fastify";
import type { Permission, EnterpriseFeature } from "@synth-deploy/core";
import { requireEnterprise, ENTERPRISE_FEATURES } from "@synth-deploy/core";

/**
 * Returns a Fastify preHandler that checks whether the authenticated user
 * has all of the specified permissions.
 */
export function requirePermission(...permissions: Permission[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user;
    if (!user) {
      reply.status(401).send({ error: "Authentication required" });
      return;
    }
    const missing = permissions.filter((p) => !user.permissions.includes(p));
    if (missing.length > 0) {
      reply.status(403).send({
        error: "Forbidden",
        required: permissions,
        message: `This action requires: ${missing.join(", ")}`,
      });
    }
  };
}

/**
 * Returns a Fastify preHandler that gates an enterprise-only feature.
 * Throws EditionError (caught by global error handler → 402) on Community edition.
 */
export function requireEdition(feature: EnterpriseFeature) {
  return async (_request: FastifyRequest, _reply: FastifyReply) => {
    requireEnterprise(feature);
  };
}
