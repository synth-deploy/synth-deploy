import { z } from "zod";

// --- Partitions ---

export const CreatePartitionSchema = z.object({
  name: z.string().min(1),
  variables: z.record(z.string().max(10_000, "Variable value must not exceed 10,000 characters"))
    .refine((v) => Object.keys(v).length <= 200, {
      message: "Maximum 200 variables per entity",
    })
    .optional(),
});

export const UpdatePartitionSchema = z.object({
  name: z.string().min(1).optional(),
});

export const SetVariablesSchema = z.object({
  variables: z.record(z.string().max(10_000, "Variable value must not exceed 10,000 characters"))
    .refine((v) => Object.keys(v).length <= 200, {
      message: "Maximum 200 variables per entity",
    }),
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
  command: z.string().min(1).optional(),
  order: z.number().int().nonnegative().optional(),
  stepTypeId: z.string().optional(),
  stepTypeConfig: z.record(z.unknown()).optional(),
}).refine(
  (data) => data.command || data.stepTypeId,
  { message: "Either command or stepTypeId must be provided" },
);

export const UpdateStepSchema = z.object({
  name: z.string().min(1).optional(),
  type: DeploymentStepTypeSchema.optional(),
  command: z.string().min(1).optional(),
  order: z.number().int().nonnegative().optional(),
  stepTypeId: z.string().optional(),
  stepTypeConfig: z.record(z.unknown()).optional(),
});

// --- Step Types ---

const StepTypeParameterSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "select"]),
  required: z.boolean(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  options: z.array(z.string()).optional(),
  description: z.string().optional(),
  validation: z.object({
    pattern: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
});

export const CreateStepTypeSchema = z.object({
  name: z.string().min(1),
  category: z.enum(["General", "File & Artifact", "Service", "Verification", "Database", "Container", "Networking & Traffic", "Cloud & Infrastructure", "Configuration & Secrets", "Monitoring & Observability", "Rollback & Recovery", "Git & Versioning", "Security & Compliance", "Package & Artifact Management", "SSH & Remote Execution"]),
  description: z.string().min(1),
  parameters: z.array(StepTypeParameterSchema),
  commandTemplate: z.string().min(1),
  partitionId: z.string().optional(),
});

export const ImportStepTypeSchema = z.object({
  formatVersion: z.literal(1),
  stepType: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    category: z.enum(["General", "File & Artifact", "Service", "Verification", "Database", "Container", "Networking & Traffic", "Cloud & Infrastructure", "Configuration & Secrets", "Monitoring & Observability", "Rollback & Recovery", "Git & Versioning", "Security & Compliance", "Package & Artifact Management", "SSH & Remote Execution"]),
    description: z.string().min(1),
    parameters: z.array(StepTypeParameterSchema),
    commandTemplate: z.string().min(1),
  }),
  partitionId: z.string().optional(),
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
  variables: z.record(z.string().max(10_000, "Variable value must not exceed 10,000 characters"))
    .refine((v) => Object.keys(v).length <= 200, {
      message: "Maximum 200 variables per entity",
    })
    .optional(),
});

export const UpdateEnvironmentSchema = z.object({
  name: z.string().min(1).optional(),
  variables: z.record(z.string().max(10_000, "Variable value must not exceed 10,000 characters"))
    .refine((v) => Object.keys(v).length <= 200, {
      message: "Maximum 200 variables per entity",
    })
    .optional(),
});

// --- SSRF Prevention ---

/**
 * SSRF-safe URL validator. Blocks private/internal IP ranges and
 * restricts to http/https protocols.
 */
function isSsrfSafeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Only allow http and https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const hostname = parsed.hostname;

  // Block localhost variants
  if (hostname === "localhost" || hostname === "[::1]") {
    return false;
  }

  // Block IPv6 loopback
  if (hostname === "::1") {
    return false;
  }

  // Check IPv4 private ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    // 127.0.0.0/8 — loopback
    if (a === 127) return false;
    // 10.0.0.0/8 — private
    if (a === 10) return false;
    // 172.16.0.0/12 — private
    if (a === 172 && b >= 16 && b <= 31) return false;
    // 192.168.0.0/16 — private
    if (a === 192 && b === 168) return false;
    // 169.254.0.0/16 — link-local (AWS metadata)
    if (a === 169 && b === 254) return false;
    // 0.0.0.0
    if (a === 0) return false;
  }

  return true;
}

// --- Settings ---

const LlmProviderEnum = z.enum(["claude", "openai", "gemini", "grok", "deepseek", "ollama", "custom"]);

/**
 * LLM base URL validator. Allows localhost/private IPs for local providers
 * like Ollama, but validates URL format.
 */
function isValidLlmBaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const LlmFallbackConfigSchema = z.object({
  provider: LlmProviderEnum,
  apiKeyConfigured: z.boolean().optional(),
  baseUrl: z.string().refine(isValidLlmBaseUrl, {
    message: "Must be a valid http or https URL",
  }).optional(),
  model: z.string().min(1),
  timeoutMs: z.number().int().positive({ message: "Timeout must be a positive number" }),
});

const LlmProviderConfigSchema = z.object({
  provider: LlmProviderEnum,
  apiKeyConfigured: z.boolean().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().refine(isValidLlmBaseUrl, {
    message: "Must be a valid http or https URL",
  }).optional(),
  reasoningModel: z.string().min(1),
  classificationModel: z.string().min(1),
  timeoutMs: z.number().int().positive({ message: "Timeout must be a positive number" }),
  rateLimitPerMin: z.number().int().positive({ message: "Rate limit must be a positive number" }),
  fallbacks: z.array(LlmFallbackConfigSchema).optional(),
});

export { LlmProviderConfigSchema };

export const UpdateSettingsSchema = z.object({
  environmentsEnabled: z.boolean().optional(),
  agent: z.object({
    defaultHealthCheckRetries: z.number().int().nonnegative().optional(),
    defaultTimeoutMs: z.number().int().positive().optional(),
    conflictPolicy: z.enum(["permissive", "strict"]).optional(),
    defaultVerificationStrategy: z.enum(["basic", "full", "none"]).optional(),
    llmOverride: LlmProviderConfigSchema.partial().optional(),
  }).optional(),
  deploymentDefaults: z.object({
    defaultDeployConfig: UpdateDeployConfigSchema.optional(),
  }).optional(),
  envoy: z.object({
    url: z.string().url().refine(isSsrfSafeUrl, {
      message: "URL must not point to private/internal IP ranges (SSRF prevention)",
    }).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).optional(),
  coBranding: z.object({
    operatorName: z.string(),
    logoUrl: z.string(),
    accentColor: z.string().optional(),
  }).optional().nullable(),
  mcpServers: z.array(z.object({
    name: z.string(),
    url: z.string().url().refine(isSsrfSafeUrl, {
      message: "URL must not point to private/internal IP ranges (SSRF prevention)",
    }),
    description: z.string().optional(),
  })).optional(),
  llm: LlmProviderConfigSchema.optional(),
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
