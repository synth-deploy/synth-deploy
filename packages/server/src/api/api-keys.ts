import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import type { IApiKeyStore } from "@synth-deploy/core";
import type { ApiKeyId } from "@synth-deploy/core";

export function registerApiKeyRoutes(
  app: FastifyInstance,
  apiKeyStore: IApiKeyStore,
  _jwtSecret: Uint8Array,
): void {

  // --- GET /api/auth/api-keys ---
  // List current user's active API keys (revokedAt === null).
  app.get("/api/auth/api-keys", async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const keys = apiKeyStore.listByUserId(user.id).filter(k => k.revokedAt === null);
    return {
      apiKeys: keys.map(k => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        keySuffix: k.keySuffix,
        permissions: k.permissions,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
      })),
    };
  });

  // --- POST /api/auth/api-keys ---
  // Create a new API key.
  app.post("/api/auth/api-keys", async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const body = request.body as { name?: string; permissions?: string[] };
    if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
      return reply.status(400).send({ error: "name is required" });
    }
    const permissions = Array.isArray(body.permissions) ? body.permissions : [];
    const rawKey = "synth_" + crypto.randomBytes(16).toString("hex"); // 32 hex chars
    const keyBody = rawKey.slice(6); // strip "synth_"
    const keyPrefix = keyBody.slice(0, 8);
    const keySuffix = keyBody.slice(-4);
    const keyHash = await bcrypt.hash(rawKey, 10);
    const now = new Date();
    const key = apiKeyStore.create({
      id: crypto.randomUUID() as ApiKeyId,
      userId: user.id,
      name: body.name.trim(),
      keyPrefix,
      keySuffix,
      keyHash,
      permissions,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    });
    return {
      key: {
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        keySuffix: key.keySuffix,
        permissions: key.permissions,
        createdAt: key.createdAt.toISOString(),
        lastUsedAt: null,
      },
      fullKey: rawKey,
    };
  });

  // --- DELETE /api/auth/api-keys/:id ---
  // Revoke an API key.
  app.delete("/api/auth/api-keys/:id", async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const { id } = request.params as { id: string };
    const key = apiKeyStore.getById(id as ApiKeyId);
    if (!key || key.userId !== user.id) {
      return reply.status(404).send({ error: "API key not found" });
    }
    apiKeyStore.revoke(id as ApiKeyId);
    return reply.status(204).send();
  });

  // --- POST /api/auth/api-keys/:id/regenerate ---
  // Regenerate an API key.
  app.post("/api/auth/api-keys/:id/regenerate", async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const { id } = request.params as { id: string };
    const key = apiKeyStore.getById(id as ApiKeyId);
    if (!key || key.userId !== user.id) {
      return reply.status(404).send({ error: "API key not found" });
    }
    if (key.revokedAt !== null) {
      return reply.status(400).send({ error: "Cannot regenerate a revoked key" });
    }
    const rawKey = "synth_" + crypto.randomBytes(16).toString("hex");
    const keyBody = rawKey.slice(6);
    const keyPrefix = keyBody.slice(0, 8);
    const keySuffix = keyBody.slice(-4);
    const keyHash = await bcrypt.hash(rawKey, 10);
    apiKeyStore.updateHash(id as ApiKeyId, keyHash, keyPrefix, keySuffix);
    const updated = apiKeyStore.getById(id as ApiKeyId)!;
    return {
      key: {
        id: updated.id,
        name: updated.name,
        keyPrefix: updated.keyPrefix,
        keySuffix: updated.keySuffix,
        permissions: updated.permissions,
        createdAt: updated.createdAt.toISOString(),
        lastUsedAt: updated.lastUsedAt ? updated.lastUsedAt.toISOString() : null,
      },
      fullKey: rawKey,
    };
  });
}
