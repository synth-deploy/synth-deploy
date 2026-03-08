import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import { jwtVerify } from "jose";
import type { IUserStore, IRoleStore, IUserRoleStore, ISessionStore, UserId, UserPublic } from "@synth-deploy/core";
import { generateTokens } from "../middleware/auth.js";
import { LoginSchema, RegisterSchema, RefreshTokenSchema } from "./schemas.js";

function toPublicUser(user: { id: UserId; email: string; name: string; authSource?: string; externalId?: string; createdAt: Date; updatedAt: Date }): UserPublic {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    authSource: (user.authSource as UserPublic["authSource"]) ?? "local",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  userStore: IUserStore,
  roleStore: IRoleStore,
  userRoleStore: IUserRoleStore,
  sessionStore: ISessionStore,
  jwtSecret: Uint8Array,
): void {

  // --- GET /api/auth/status ---
  // Returns whether setup is required (no users exist yet)
  app.get("/api/auth/status", async () => {
    const userCount = userStore.count();
    return { needsSetup: userCount === 0 };
  });

  // --- POST /api/auth/register ---
  // First-user registration only. Creates the initial admin user.
  app.post("/api/auth/register", async (request, reply) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const userCount = userStore.count();
    if (userCount > 0) {
      return reply.status(403).send({ error: "Registration is closed. Users already exist." });
    }

    const { email, name, password } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID() as UserId;
    const now = new Date();

    const user = userStore.create({
      id: userId,
      email,
      name,
      passwordHash,
      createdAt: now,
      updatedAt: now,
    });

    // Assign Admin role
    const adminRole = roleStore.getByName("Admin");
    if (adminRole) {
      userRoleStore.assign(userId, adminRole.id, userId);
    }

    // Create session
    const tokens = await generateTokens(userId, jwtSecret);
    sessionStore.create({
      id: crypto.randomUUID(),
      userId,
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      createdAt: now,
    });

    const permissions = userRoleStore.getUserPermissions(userId);

    return {
      user: toPublicUser(user),
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      permissions,
    };
  });

  // --- POST /api/auth/login ---
  app.post("/api/auth/login", async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const { email, password } = parsed.data;
    const user = userStore.getByEmail(email);
    if (!user) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: "Invalid email or password" });
    }

    const tokens = await generateTokens(user.id, jwtSecret);
    sessionStore.create({
      id: crypto.randomUUID(),
      userId: user.id,
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      createdAt: new Date(),
    });

    const permissions = userRoleStore.getUserPermissions(user.id);

    return {
      user: toPublicUser(user),
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      permissions,
    };
  });

  // --- POST /api/auth/refresh ---
  app.post("/api/auth/refresh", async (request, reply) => {
    const parsed = RefreshTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const { refreshToken } = parsed.data;

    // Verify the refresh token JWT
    try {
      await jwtVerify(refreshToken, jwtSecret);
    } catch {
      return reply.status(401).send({ error: "Invalid refresh token" });
    }

    const session = sessionStore.getByRefreshToken(refreshToken);
    if (!session) {
      return reply.status(401).send({ error: "Session not found" });
    }

    // Delete old session
    sessionStore.deleteByToken(session.token);

    // Generate new tokens
    const tokens = await generateTokens(session.userId, jwtSecret);
    sessionStore.create({
      id: crypto.randomUUID(),
      userId: session.userId,
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      createdAt: new Date(),
    });

    return {
      token: tokens.token,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt.toISOString(),
    };
  });

  // --- POST /api/auth/logout ---
  app.post("/api/auth/logout", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      sessionStore.deleteByToken(token);
    }
    return reply.status(204).send();
  });

  // --- GET /api/auth/me ---
  app.get("/api/auth/me", async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const fullUser = userStore.getById(user.id);
    if (!fullUser) {
      return reply.status(401).send({ error: "User not found" });
    }
    return {
      user: toPublicUser(fullUser),
      permissions: user.permissions,
    };
  });

  // --- PUT /api/auth/me ---
  // Update the authenticated user's name and/or email.
  app.put("/api/auth/me", async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const body = request.body as { name?: string; email?: string };
    const updates: { name?: string; email?: string; updatedAt: Date } = { updatedAt: new Date() };
    if (typeof body.name === "string" && body.name.trim()) {
      updates.name = body.name.trim();
    }
    if (typeof body.email === "string" && body.email.trim()) {
      updates.email = body.email.trim().toLowerCase();
    }
    try {
      const updated = userStore.update(user.id, updates);
      return { user: toPublicUser(updated) };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Update failed";
      return reply.status(400).send({ error: message });
    }
  });

  // --- POST /api/auth/me/password ---
  // Change the authenticated user's password (local accounts only).
  app.post("/api/auth/me/password", async (request, reply) => {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({ error: "Authentication required" });
    }
    const fullUser = userStore.getById(user.id);
    if (!fullUser) {
      return reply.status(401).send({ error: "User not found" });
    }
    if (fullUser.authSource !== "local") {
      return reply.status(400).send({ error: "Password change is only available for local accounts" });
    }
    const body = request.body as { currentPassword?: string; newPassword?: string };
    if (!body.currentPassword || !body.newPassword) {
      return reply.status(400).send({ error: "currentPassword and newPassword are required" });
    }
    if (body.newPassword.length < 8) {
      return reply.status(400).send({ error: "New password must be at least 8 characters" });
    }
    const valid = await bcrypt.compare(body.currentPassword, fullUser.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: "Current password is incorrect" });
    }
    const passwordHash = await bcrypt.hash(body.newPassword, 10);
    userStore.update(user.id, { passwordHash, updatedAt: new Date() });
    return reply.status(204).send();
  });
}
