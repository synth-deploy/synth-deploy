import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { OperationTemplate, OperationInput, IOperationTemplateStore } from "@synth-deploy/core";
import { requirePermission } from "../middleware/permissions.js";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export class OperationTemplateStore implements IOperationTemplateStore {
  private store = new Map<string, OperationTemplate>();

  create(template: Omit<OperationTemplate, "id" | "createdAt" | "updatedAt">): OperationTemplate {
    const now = new Date();
    const record: OperationTemplate = {
      ...template,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(record.id, record);
    return structuredClone(record);
  }

  get(id: string): OperationTemplate | undefined {
    const t = this.store.get(id);
    return t ? structuredClone(t) : undefined;
  }

  list(): OperationTemplate[] {
    return [...this.store.values()].map((t) => structuredClone(t));
  }

  update(id: string, updates: Partial<Omit<OperationTemplate, "id" | "createdAt">>): OperationTemplate {
    const existing = this.store.get(id);
    if (!existing) throw new Error(`Template not found: ${id}`);
    const updated: OperationTemplate = { ...existing, ...updates, id, updatedAt: new Date() };
    this.store.set(id, updated);
    return structuredClone(updated);
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Parameter interpolation
// ---------------------------------------------------------------------------

/**
 * Recursively replace all {{paramName}} tokens in string fields of an object.
 */
function interpolate(value: unknown, params: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => params[key] ?? `{{${key}}}`);
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolate(v, params));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolate(v, params);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TemplateParamSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaultValue: z.string().optional(),
});

const CreateTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  input: z.record(z.unknown()),
  parameters: z.array(TemplateParamSchema).default([]),
});

const UpdateTemplateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  parameters: z.array(TemplateParamSchema).optional(),
});

const ApplyTemplateSchema = z.object({
  environmentId: z.string().optional(),
  partitionId: z.string().optional(),
  envoyId: z.string().optional(),
  version: z.string().optional(),
  requireApproval: z.boolean().optional(),
  parameters: z.record(z.string()).default({}),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerTemplateRoutes(
  app: FastifyInstance,
  templateStore: IOperationTemplateStore,
): void {

  // List templates
  app.get("/api/templates", { preHandler: [requirePermission("deployment.create")] }, async (_request, reply) => {
    return reply.send({ templates: templateStore.list() });
  });

  // Get a single template
  app.get<{ Params: { id: string } }>("/api/templates/:id", { preHandler: [requirePermission("deployment.create")] }, async (request, reply) => {
    const template = templateStore.get(request.params.id);
    if (!template) return reply.status(404).send({ error: "Template not found" });
    return reply.send({ template });
  });

  // Create a template
  app.post("/api/templates", { preHandler: [requirePermission("deployment.create")] }, async (request, reply) => {
    const parsed = CreateTemplateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { name, description, input, parameters } = parsed.data;
    const template = templateStore.create({
      name,
      description,
      input: input as OperationInput,
      parameters,
    });
    return reply.status(201).send({ template });
  });

  // Update a template
  app.patch<{ Params: { id: string } }>("/api/templates/:id", { preHandler: [requirePermission("deployment.create")] }, async (request, reply) => {
    const existing = templateStore.get(request.params.id);
    if (!existing) return reply.status(404).send({ error: "Template not found" });

    const parsed = UpdateTemplateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const updated = templateStore.update(request.params.id, {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.input !== undefined ? { input: parsed.data.input as OperationInput } : {}),
      ...(parsed.data.parameters !== undefined ? { parameters: parsed.data.parameters } : {}),
    });
    return reply.send({ template: updated });
  });

  // Delete a template
  app.delete<{ Params: { id: string } }>("/api/templates/:id", { preHandler: [requirePermission("deployment.create")] }, async (request, reply) => {
    const deleted = templateStore.delete(request.params.id);
    if (!deleted) return reply.status(404).send({ error: "Template not found" });
    return reply.send({ deleted: true });
  });

  // Apply a template — interpolate params, create the operation
  app.post<{ Params: { id: string } }>("/api/templates/:id/apply", { preHandler: [requirePermission("deployment.create")] }, async (request, reply) => {
    const template = templateStore.get(request.params.id);
    if (!template) return reply.status(404).send({ error: "Template not found" });

    const parsed = ApplyTemplateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { environmentId, partitionId, envoyId, version, requireApproval, parameters } = parsed.data;

    // Build full params map: defaults merged with provided values
    const resolvedParams: Record<string, string> = {};
    for (const p of template.parameters) {
      if (p.defaultValue !== undefined) resolvedParams[p.name] = p.defaultValue;
    }
    Object.assign(resolvedParams, parameters);

    // Interpolate {{param}} tokens into the input
    const interpolatedInput = interpolate(template.input, resolvedParams) as OperationInput;

    // Build the POST /api/operations body from the interpolated input
    const opBody: Record<string, unknown> = {
      type: interpolatedInput.type,
      ...(environmentId ? { environmentId } : {}),
      ...(partitionId ? { partitionId } : {}),
      ...(envoyId ? { envoyId } : {}),
      version: version ?? "1.0.0",
      ...(requireApproval !== undefined ? { requireApproval } : {}),
    };

    if (interpolatedInput.type === "deploy") {
      opBody.artifactId = (interpolatedInput as { artifactId: string }).artifactId;
    } else if (interpolatedInput.type === "trigger") {
      opBody.condition = (interpolatedInput as { condition: string }).condition;
      opBody.responseIntent = (interpolatedInput as { responseIntent: string }).responseIntent;
    } else if (interpolatedInput.type === "composite") {
      opBody.steps = (interpolatedInput as { steps: unknown[] }).steps;
    } else {
      opBody.intent = (interpolatedInput as { intent: string }).intent;
      if (interpolatedInput.type === "investigate") {
        opBody.allowWrite = (interpolatedInput as { allowWrite?: boolean }).allowWrite;
      }
    }

    // Use inject so we go through the full operations route (validation, planning kick-off, auth)
    const injectResult = await app.inject({
      method: "POST",
      url: "/api/operations",
      headers: { "content-type": "application/json", ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) },
      payload: opBody,
    });

    if (injectResult.statusCode >= 400) {
      return reply.status(injectResult.statusCode).send(JSON.parse(injectResult.body));
    }

    const created = JSON.parse(injectResult.body) as { deployment?: { id: string }; id?: string };
    const operationId = created.deployment?.id ?? created.id;
    return reply.status(201).send({ operationId, templateId: template.id });
  });
}
