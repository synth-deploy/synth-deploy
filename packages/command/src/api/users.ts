import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import type { IUserStore, IRoleStore, IUserRoleStore, UserId, RoleId, UserPublic, Permission } from "@deploystack/core";
import { requirePermission } from "../middleware/permissions.js";
import {
  CreateUserSchema,
  UpdateUserSchema,
  AssignRolesSchema,
  CreateRoleSchema,
  UpdateRoleSchema,
} from "./schemas.js";

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

export function registerUserRoutes(
  app: FastifyInstance,
  userStore: IUserStore,
  roleStore: IRoleStore,
  userRoleStore: IUserRoleStore,
): void {

  // --- GET /api/users ---
  app.get("/api/users", { preHandler: [requirePermission("users.manage")] }, async () => {
    const users = userStore.list();
    return { users: users.map(toPublicUser) };
  });

  // --- POST /api/users ---
  app.post("/api/users", { preHandler: [requirePermission("users.manage")] }, async (request, reply) => {
    const parsed = CreateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const { email, name, password } = parsed.data;
    const existing = userStore.getByEmail(email);
    if (existing) {
      return reply.status(409).send({ error: "Email already in use" });
    }

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

    return reply.status(201).send({ user: toPublicUser(user) });
  });

  // --- PUT /api/users/:id ---
  app.put<{ Params: { id: string } }>("/api/users/:id", { preHandler: [requirePermission("users.manage")] }, async (request, reply) => {
    const parsed = UpdateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const userId = request.params.id as UserId;
    const existing = userStore.getById(userId);
    if (!existing) {
      return reply.status(404).send({ error: "User not found" });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.email !== undefined) updates.email = parsed.data.email;
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.password !== undefined) {
      updates.passwordHash = await bcrypt.hash(parsed.data.password, 10);
    }

    const user = userStore.update(userId, updates as Parameters<typeof userStore.update>[1]);
    return { user: toPublicUser(user) };
  });

  // --- DELETE /api/users/:id ---
  app.delete<{ Params: { id: string } }>("/api/users/:id", { preHandler: [requirePermission("users.manage")] }, async (request, reply) => {
    const userId = request.params.id as UserId;
    const existing = userStore.getById(userId);
    if (!existing) {
      return reply.status(404).send({ error: "User not found" });
    }
    userStore.delete(userId);
    return reply.status(204).send();
  });

  // --- GET /api/users/:id/roles ---
  app.get<{ Params: { id: string } }>("/api/users/:id/roles", { preHandler: [requirePermission("users.manage")] }, async (request, reply) => {
    const userId = request.params.id as UserId;
    const existing = userStore.getById(userId);
    if (!existing) {
      return reply.status(404).send({ error: "User not found" });
    }
    const roles = userRoleStore.getUserRoles(userId);
    return { roles };
  });

  // --- PUT /api/users/:id/roles ---
  app.put<{ Params: { id: string } }>("/api/users/:id/roles", { preHandler: [requirePermission("roles.manage")] }, async (request, reply) => {
    const parsed = AssignRolesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const userId = request.params.id as UserId;
    const existing = userStore.getById(userId);
    if (!existing) {
      return reply.status(404).send({ error: "User not found" });
    }

    const assignedBy = request.user!.id;
    const roleIds = parsed.data.roleIds as RoleId[];

    // Validate all role IDs exist
    for (const roleId of roleIds) {
      const role = roleStore.getById(roleId);
      if (!role) {
        return reply.status(400).send({ error: `Role not found: ${roleId}` });
      }
    }

    userRoleStore.setRoles(userId, roleIds, assignedBy);
    const roles = userRoleStore.getUserRoles(userId);
    return { roles };
  });

  // --- GET /api/roles ---
  app.get("/api/roles", { preHandler: [requirePermission("users.manage")] }, async () => {
    const roles = roleStore.list();
    return { roles };
  });

  // --- POST /api/roles ---
  app.post("/api/roles", { preHandler: [requirePermission("roles.manage")] }, async (request, reply) => {
    const parsed = CreateRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const { name, permissions } = parsed.data;
    const existing = roleStore.getByName(name);
    if (existing) {
      return reply.status(409).send({ error: "Role name already in use" });
    }

    const roleId = crypto.randomUUID() as RoleId;
    const role = roleStore.create({
      id: roleId,
      name,
      permissions: permissions as Permission[],
      isBuiltIn: false,
      createdAt: new Date(),
    });

    return reply.status(201).send({ role });
  });

  // --- PUT /api/roles/:id ---
  app.put<{ Params: { id: string } }>("/api/roles/:id", { preHandler: [requirePermission("roles.manage")] }, async (request, reply) => {
    const parsed = UpdateRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.flatten() });
    }

    const roleId = request.params.id as RoleId;
    const existing = roleStore.getById(roleId);
    if (!existing) {
      return reply.status(404).send({ error: "Role not found" });
    }
    if (existing.isBuiltIn) {
      return reply.status(403).send({ error: "Cannot modify built-in roles" });
    }

    const updates: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) updates.name = parsed.data.name;
    if (parsed.data.permissions !== undefined) updates.permissions = parsed.data.permissions as Permission[];

    const role = roleStore.update(roleId, updates as Parameters<typeof roleStore.update>[1]);
    return { role };
  });

  // --- DELETE /api/roles/:id ---
  app.delete<{ Params: { id: string } }>("/api/roles/:id", { preHandler: [requirePermission("roles.manage")] }, async (request, reply) => {
    const roleId = request.params.id as RoleId;
    const existing = roleStore.getById(roleId);
    if (!existing) {
      return reply.status(404).send({ error: "Role not found" });
    }
    if (existing.isBuiltIn) {
      return reply.status(403).send({ error: "Cannot delete built-in roles" });
    }
    roleStore.delete(roleId);
    return reply.status(204).send();
  });
}
