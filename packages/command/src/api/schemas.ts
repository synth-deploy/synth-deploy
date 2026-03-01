import { z } from "zod";

// --- Partitions ---

export const CreatePartitionSchema = z.object({
  name: z.string().min(1),
  variables: z.record(z.string()).optional(),
});

export const UpdatePartitionSchema = z.object({
  name: z.string().min(1).optional(),
});

export const SetVariablesSchema = z.object({
  variables: z.record(z.string()),
});

// --- Operations ---

export const CreateOperationSchema = z.object({
  name: z.string().min(1),
  environmentIds: z.array(z.string()).optional(),
});

export const UpdateOperationSchema = z.object({
  name: z.string().min(1).optional(),
});

export const AddEnvironmentSchema = z.object({
  environmentId: z.string().min(1),
});

const DeploymentStepTypeSchema = z.enum(["pre-deploy", "post-deploy", "verification"]);

export const CreateStepSchema = z.object({
  name: z.string().min(1),
  type: DeploymentStepTypeSchema,
  command: z.string().min(1),
  order: z.number().int().nonnegative().optional(),
});

export const UpdateStepSchema = z.object({
  name: z.string().min(1).optional(),
  type: DeploymentStepTypeSchema.optional(),
  command: z.string().min(1).optional(),
  order: z.number().int().nonnegative().optional(),
});

export const ReorderStepsSchema = z.object({
  stepIds: z.array(z.string().min(1)).min(1),
});

export const UpdateDeployConfigSchema = z.object({
  healthCheckEnabled: z.boolean().optional(),
  healthCheckRetries: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().positive().optional(),
  verificationStrategy: z.enum(["basic", "full", "none"]).optional(),
});

// --- Environments ---

export const CreateEnvironmentSchema = z.object({
  name: z.string().min(1),
  variables: z.record(z.string()).optional(),
});

export const UpdateEnvironmentSchema = z.object({
  name: z.string().min(1).optional(),
  variables: z.record(z.string()).optional(),
});

// --- Settings ---

export const UpdateSettingsSchema = z.object({
  environmentsEnabled: z.boolean().optional(),
  agent: z.object({
    defaultHealthCheckRetries: z.number().int().nonnegative().optional(),
    defaultTimeoutMs: z.number().int().positive().optional(),
    conflictPolicy: z.enum(["permissive", "strict"]).optional(),
    defaultVerificationStrategy: z.enum(["basic", "full", "none"]).optional(),
  }).optional(),
  deploymentDefaults: z.object({
    defaultDeployConfig: UpdateDeployConfigSchema.optional(),
  }).optional(),
  envoy: z.object({
    url: z.string().url().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).optional(),
  coBranding: z.object({
    operatorName: z.string(),
    logoUrl: z.string(),
    accentColor: z.string().optional(),
  }).optional().nullable(),
  mcpServers: z.array(z.object({
    name: z.string(),
    url: z.string().url(),
    description: z.string().optional(),
  })).optional(),
});

// --- Orders ---

export const CreateOrderSchema = z.object({
  operationId: z.string().min(1),
  partitionId: z.string().min(1),
  environmentId: z.string().optional(),
  version: z.string().min(1),
});

export const OrderListQuerySchema = z.object({
  operationId: z.string().optional(),
  partitionId: z.string().optional(),
});

// --- Deployments ---

export const DeploymentListQuerySchema = z.object({
  partitionId: z.string().optional(),
});

export const DebriefQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  partitionId: z.string().optional(),
  decisionType: z.string().optional(),
});

// --- Agent ---

export const IntentRequestSchema = z.object({
  intent: z.string().min(1),
  conversationId: z.string().optional(),
  partialConfig: z.object({
    operationId: z.string().optional(),
    partitionId: z.string().optional(),
    environmentId: z.string().optional(),
    version: z.string().optional(),
    variables: z.record(z.string()).optional(),
  }).optional(),
});

export const QueryRequestSchema = z.object({
  query: z.string().min(1),
  conversationId: z.string().optional(),
});
