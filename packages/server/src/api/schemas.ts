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

// --- Artifacts ---

export const CreateArtifactSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  source: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

export const AddAnnotationSchema = z.object({
  field: z.string().min(1),
  correction: z.string().min(1),
});

export const AddArtifactVersionSchema = z.object({
  version: z.string().min(1),
  source: z.string(),
  metadata: z.record(z.string()).optional(),
});

// --- Security Boundaries ---

export const SetSecurityBoundariesSchema = z.object({
  boundaries: z.array(z.object({
    boundaryType: z.enum(["filesystem", "service", "network", "credential", "execution"]),
    config: z.record(z.unknown()),
  })),
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

const TaskModelConfigSchema = z.object({
  logClassification: z.string().optional(),
  diagnosticSynthesis: z.string().optional(),
  postmortemGeneration: z.string().optional(),
  queryAnswering: z.string().optional(),
});

export { TaskModelConfigSchema };

export const VerifyTaskModelSchema = z.object({
  task: z.enum(["logClassification", "diagnosticSynthesis", "postmortemGeneration", "queryAnswering"]),
  model: z.string().min(1),
});

export const UpdateSettingsSchema = z.object({
  environmentsEnabled: z.boolean().optional(),
  defaultTheme: z.enum(["dark", "light", "system"]).optional(),
  agent: z.object({
    defaultHealthCheckRetries: z.number().int().nonnegative().optional(),
    defaultTimeoutMs: z.number().int().positive().optional(),
    conflictPolicy: z.enum(["permissive", "strict"]).optional(),
    defaultVerificationStrategy: z.enum(["basic", "full", "none"]).optional(),
    llmEntityExposure: z.enum(["names", "none"]).optional(),
    llmOverride: LlmProviderConfigSchema.partial().optional(),
    taskModels: TaskModelConfigSchema.optional(),
  }).optional(),
  envoy: z.object({
    url: z.string().refine(isSsrfSafeUrl, {
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
  llm: LlmProviderConfigSchema.partial().optional(),
});

// --- Artifacts (update) ---

export const UpdateArtifactSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  source: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

// --- Deployments ---

export const CreateDeploymentSchema = z.object({
  artifactId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  partitionId: z.string().optional(),
  envoyId: z.string().optional(),
  version: z.string().optional(),
});

// --- Operations ---

export const CreateOperationSchema = z.object({
  artifactId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
  partitionId: z.string().optional(),
  envoyId: z.string().optional(),
  version: z.string().optional(),
  type: z.enum(["deploy", "maintain", "query", "investigate", "trigger", "composite"]).default("deploy"),
  intent: z.string().optional(),
});

export const ApproveDeploymentSchema = z.object({
  approvedBy: z.string().min(1),
  modifications: z.string().optional(),
});

export const RejectDeploymentSchema = z.object({
  reason: z.string().min(1),
});

export const ModifyDeploymentPlanSchema = z.object({
  steps: z.array(z.object({
    description: z.string().min(1),
    action: z.string().min(1),
    target: z.string().min(1),
    reversible: z.boolean(),
    rollbackAction: z.string().optional(),
  })).min(1, "Plan must contain at least one step"),
  reason: z.string().min(1),
});

export const SubmitPlanSchema = z.object({
  plan: z.object({
    steps: z.array(z.object({
      description: z.string().min(1),
      action: z.string().min(1),
      target: z.string().min(1),
      reversible: z.boolean(),
      rollbackAction: z.string().optional(),
    })).min(1),
    reasoning: z.string().min(1),
    diffFromCurrent: z.array(z.object({ key: z.string(), from: z.string(), to: z.string() })).optional(),
    diffFromPreviousPlan: z.string().optional(),
  }),
  rollbackPlan: z.object({
    steps: z.array(z.object({
      description: z.string().min(1),
      action: z.string().min(1),
      target: z.string().min(1),
      reversible: z.boolean(),
      rollbackAction: z.string().optional(),
    })),
    reasoning: z.string().min(1),
  }),
});

export const DeploymentListQuerySchema = z.object({
  partitionId: z.string().optional(),
  artifactId: z.string().optional(),
  envoyId: z.string().optional(),
});

export const ReplanDeploymentSchema = z.object({
  feedback: z.string().min(1),
});

export const DebriefQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  partitionId: z.string().optional(),
  decisionType: z.string().optional(),
});

// --- Progress Events (from envoy callback) ---

export const ProgressEventSchema = z.object({
  deploymentId: z.string(),
  type: z.enum([
    "step-started",
    "step-completed",
    "step-failed",
    "rollback-started",
    "rollback-completed",
    "deployment-completed",
  ]),
  stepIndex: z.number().int().nonnegative(),
  stepDescription: z.string(),
  status: z.enum(["in_progress", "completed", "failed"]),
  output: z.string().optional(),
  error: z.string().optional(),
  timestamp: z.string(),
  overallProgress: z.number().min(0).max(100),
});

// --- Telemetry ---

export const TelemetryQuerySchema = z.object({
  actor: z.string().optional(),
  action: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

// --- Agent ---

export const QueryRequestSchema = z.object({
  query: z.string().min(1),
  conversationId: z.string().optional(),
});

// --- Auth ---

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const RegisterSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
});

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(8),
});

export const UpdateUserSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().min(1).optional(),
  password: z.string().min(8).optional(),
});

export const AssignRolesSchema = z.object({
  roleIds: z.array(z.string().min(1)),
});

export const CreateRoleSchema = z.object({
  name: z.string().min(1),
  permissions: z.array(z.string().min(1)),
});

export const UpdateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  permissions: z.array(z.string().min(1)).optional(),
});
