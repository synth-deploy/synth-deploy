/**
 * Step Type Library — data-driven step type definitions.
 *
 * Each step type is a plain object describing:
 *  - its identity and categorization
 *  - a parameter schema (what inputs it needs)
 *  - a command template that gets resolved into a shell command
 *
 * Adding a new step type = adding a new object. No schema changes required.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StepTypeParameterType = "string" | "number" | "boolean" | "select";

export interface StepTypeParameter {
  name: string;
  label: string;
  type: StepTypeParameterType;
  required: boolean;
  default?: string | number | boolean;
  options?: string[];
  description?: string;
  validation?: {
    pattern?: string;
    min?: number;
    max?: number;
  };
}

export type StepTypeSource = "predefined" | "custom" | "community";

export type StepTypeCategory =
  | "General"
  | "File & Artifact"
  | "Service"
  | "Verification"
  | "Database"
  | "Container"
  | "Traffic";

export interface StepTypeDefinition {
  id: string;
  name: string;
  category: StepTypeCategory;
  description: string;
  parameters: StepTypeParameter[];
  commandTemplate: string;
  source: StepTypeSource;
  /** For custom/community types: the partition that owns this type */
  partitionId?: string;
}

/** Portable format for import/export */
export interface StepTypeExport {
  formatVersion: 1;
  stepType: Omit<StepTypeDefinition, "source" | "partitionId">;
}

// ---------------------------------------------------------------------------
// Command template resolver
// ---------------------------------------------------------------------------

export function resolveCommandTemplate(
  template: string,
  config: Record<string, unknown>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = config[key];
    if (value === undefined || value === null || value === "") return "";
    return String(value);
  });
}

// ---------------------------------------------------------------------------
// Predefined step types
// ---------------------------------------------------------------------------

export const PREDEFINED_STEP_TYPES: StepTypeDefinition[] = [
  // --- General ---
  {
    id: "run-command",
    name: "Run Command",
    category: "General",
    description: "Execute an arbitrary shell command",
    parameters: [
      { name: "command", label: "Command", type: "string", required: true, description: "Shell command to execute" },
      { name: "working_dir", label: "Working Directory", type: "string", required: false, description: "Directory to run the command in" },
      { name: "timeout", label: "Timeout (seconds)", type: "number", required: false, default: 30, description: "Maximum execution time" },
    ],
    commandTemplate: "{{command}}",
    source: "predefined",
  },
  {
    id: "wait-delay",
    name: "Wait / Delay",
    category: "General",
    description: "Pause execution for a specified duration",
    parameters: [
      { name: "duration", label: "Duration (seconds)", type: "number", required: true, description: "How long to wait" },
      { name: "reason", label: "Reason", type: "string", required: false, description: "Why the wait is needed" },
    ],
    commandTemplate: "sleep {{duration}}",
    source: "predefined",
  },
  {
    id: "approval-gate",
    name: "Approval Gate",
    category: "General",
    description: "Require manual approval before proceeding",
    parameters: [
      { name: "approvers", label: "Approvers", type: "string", required: true, description: "Comma-separated list of approvers" },
      { name: "timeout", label: "Timeout (seconds)", type: "number", required: false, default: 3600, description: "How long to wait for approval" },
      { name: "auto_approve_env", label: "Auto-approve Environment", type: "string", required: false, description: "Environment where approval is automatic" },
    ],
    commandTemplate: "echo 'Approval required from: {{approvers}}'",
    source: "predefined",
  },
  {
    id: "send-notification",
    name: "Send Notification",
    category: "General",
    description: "Send a notification via Slack, webhook, or email",
    parameters: [
      { name: "channel", label: "Channel", type: "select", required: true, options: ["slack", "webhook", "email"], description: "Notification channel" },
      { name: "message_template", label: "Message", type: "string", required: true, description: "Notification message (supports variable substitution)" },
    ],
    commandTemplate: "echo 'Notification ({{channel}}): {{message_template}}'",
    source: "predefined",
  },

  // --- File & Artifact ---
  {
    id: "copy-files",
    name: "Copy Files",
    category: "File & Artifact",
    description: "Copy files from source to destination",
    parameters: [
      { name: "source", label: "Source", type: "string", required: true, description: "Source path or pattern" },
      { name: "destination", label: "Destination", type: "string", required: true, description: "Destination path" },
      { name: "exclude_patterns", label: "Exclude Patterns", type: "string", required: false, description: "Patterns to exclude (comma-separated)" },
    ],
    commandTemplate: "cp -r {{source}} {{destination}}",
    source: "predefined",
  },
  {
    id: "download-artifact",
    name: "Download Artifact",
    category: "File & Artifact",
    description: "Download a file from a URL",
    parameters: [
      { name: "source_url", label: "Source URL", type: "string", required: true, description: "URL to download from" },
      { name: "destination", label: "Destination", type: "string", required: true, description: "Local path to save to" },
      { name: "checksum", label: "Expected Checksum", type: "string", required: false, description: "SHA256 checksum for verification" },
    ],
    commandTemplate: "curl -fsSL -o {{destination}} {{source_url}}",
    source: "predefined",
  },
  {
    id: "extract-archive",
    name: "Extract Archive",
    category: "File & Artifact",
    description: "Extract a compressed archive",
    parameters: [
      { name: "archive_path", label: "Archive Path", type: "string", required: true, description: "Path to the archive" },
      { name: "destination", label: "Destination", type: "string", required: true, description: "Directory to extract into" },
      { name: "format", label: "Format", type: "select", required: false, options: ["tar", "zip"], default: "tar", description: "Archive format" },
    ],
    commandTemplate: "tar -xf {{archive_path}} -C {{destination}}",
    source: "predefined",
  },
  {
    id: "set-file-permissions",
    name: "Set File Permissions",
    category: "File & Artifact",
    description: "Set permissions on a file or directory",
    parameters: [
      { name: "path", label: "Path", type: "string", required: true, description: "File or directory path" },
      { name: "mode", label: "Mode", type: "string", required: true, description: "Permission mode (e.g., 755)" },
      { name: "owner", label: "Owner", type: "string", required: false, description: "Owner (user:group)" },
      { name: "recursive", label: "Recursive", type: "boolean", required: false, default: false, description: "Apply recursively" },
    ],
    commandTemplate: "chmod {{mode}} {{path}}",
    source: "predefined",
  },
  {
    id: "create-symlink",
    name: "Create Symlink",
    category: "File & Artifact",
    description: "Create a symbolic link",
    parameters: [
      { name: "target", label: "Target", type: "string", required: true, description: "The file or directory the link points to" },
      { name: "link_path", label: "Link Path", type: "string", required: true, description: "Path for the symlink" },
    ],
    commandTemplate: "ln -sf {{target}} {{link_path}}",
    source: "predefined",
  },
  {
    id: "clean-directory",
    name: "Clean Directory",
    category: "File & Artifact",
    description: "Remove files from a directory",
    parameters: [
      { name: "path", label: "Path", type: "string", required: true, description: "Directory to clean" },
      { name: "exclude_patterns", label: "Exclude Patterns", type: "string", required: false, description: "Patterns to keep (comma-separated)" },
      { name: "dry_run", label: "Dry Run", type: "boolean", required: false, default: false, description: "Preview without deleting" },
    ],
    commandTemplate: "rm -rf {{path}}/*",
    source: "predefined",
  },

  // --- Service ---
  {
    id: "start-service",
    name: "Start Service",
    category: "Service",
    description: "Start a system service",
    parameters: [
      { name: "service_name", label: "Service Name", type: "string", required: true, description: "Name of the service" },
      { name: "method", label: "Method", type: "select", required: false, options: ["systemd", "docker", "pm2"], default: "systemd", description: "Service management method" },
    ],
    commandTemplate: "systemctl start {{service_name}}",
    source: "predefined",
  },
  {
    id: "stop-service",
    name: "Stop Service",
    category: "Service",
    description: "Stop a system service",
    parameters: [
      { name: "service_name", label: "Service Name", type: "string", required: true, description: "Name of the service" },
      { name: "method", label: "Method", type: "select", required: false, options: ["systemd", "docker", "pm2"], default: "systemd", description: "Service management method" },
      { name: "graceful_timeout", label: "Graceful Timeout (s)", type: "number", required: false, default: 30, description: "Seconds to wait for graceful shutdown" },
    ],
    commandTemplate: "systemctl stop {{service_name}}",
    source: "predefined",
  },
  {
    id: "restart-service",
    name: "Restart Service",
    category: "Service",
    description: "Restart a system service",
    parameters: [
      { name: "service_name", label: "Service Name", type: "string", required: true, description: "Name of the service" },
      { name: "method", label: "Method", type: "select", required: false, options: ["systemd", "docker", "pm2"], default: "systemd", description: "Service management method" },
    ],
    commandTemplate: "systemctl restart {{service_name}}",
    source: "predefined",
  },
  {
    id: "scale-service",
    name: "Scale Service",
    category: "Service",
    description: "Scale a service to a target replica count",
    parameters: [
      { name: "service_name", label: "Service Name", type: "string", required: true, description: "Name of the service" },
      { name: "replicas", label: "Replicas", type: "number", required: true, description: "Target number of replicas" },
      { name: "method", label: "Method", type: "select", required: false, options: ["systemd", "docker", "pm2"], default: "docker", description: "Service management method" },
    ],
    commandTemplate: "docker service scale {{service_name}}={{replicas}}",
    source: "predefined",
  },

  // --- Verification ---
  {
    id: "http-health-check",
    name: "HTTP Health Check",
    category: "Verification",
    description: "Verify a URL returns the expected status code",
    parameters: [
      { name: "url", label: "URL", type: "string", required: true, description: "URL to check" },
      { name: "expected_status", label: "Expected Status", type: "number", required: false, default: 200, description: "Expected HTTP status code" },
      { name: "timeout", label: "Timeout (seconds)", type: "number", required: false, default: 10, description: "Request timeout" },
      { name: "retries", label: "Retries", type: "number", required: false, default: 3, description: "Number of retries" },
    ],
    commandTemplate: "curl -sf -o /dev/null -w '%{http_code}' --max-time {{timeout}} --retry {{retries}} {{url}}",
    source: "predefined",
  },
  {
    id: "port-check",
    name: "Port Check",
    category: "Verification",
    description: "Verify a port is open and accepting connections",
    parameters: [
      { name: "host", label: "Host", type: "string", required: true, description: "Hostname or IP" },
      { name: "port", label: "Port", type: "number", required: true, description: "Port number" },
      { name: "timeout", label: "Timeout (seconds)", type: "number", required: false, default: 5, description: "Connection timeout" },
    ],
    commandTemplate: "nc -z -w {{timeout}} {{host}} {{port}}",
    source: "predefined",
  },
  {
    id: "run-test-suite",
    name: "Run Test Suite",
    category: "Verification",
    description: "Execute a test suite and check results",
    parameters: [
      { name: "test_command", label: "Test Command", type: "string", required: true, description: "Command to run tests" },
      { name: "working_dir", label: "Working Directory", type: "string", required: false, description: "Directory to run tests in" },
      { name: "fail_threshold", label: "Failure Threshold (%)", type: "number", required: false, description: "Max allowed failure percentage" },
    ],
    commandTemplate: "{{test_command}}",
    source: "predefined",
  },
  {
    id: "verify-file-exists",
    name: "Verify File Exists",
    category: "Verification",
    description: "Confirm a file exists at the expected path",
    parameters: [
      { name: "path", label: "File Path", type: "string", required: true, description: "Path to verify" },
      { name: "checksum", label: "Expected Checksum", type: "string", required: false, description: "SHA256 checksum to verify" },
    ],
    commandTemplate: "test -f {{path}}",
    source: "predefined",
  },
  {
    id: "ssl-certificate-check",
    name: "SSL Certificate Check",
    category: "Verification",
    description: "Verify an SSL certificate is valid and not expiring soon",
    parameters: [
      { name: "hostname", label: "Hostname", type: "string", required: true, description: "Domain to check" },
      { name: "min_days_remaining", label: "Min Days Remaining", type: "number", required: false, default: 30, description: "Minimum days until expiry" },
    ],
    commandTemplate: "echo | openssl s_client -servername {{hostname}} -connect {{hostname}}:443 2>/dev/null | openssl x509 -noout -dates",
    source: "predefined",
  },

  // --- Database ---
  {
    id: "run-database-migration",
    name: "Run Database Migration",
    category: "Database",
    description: "Run database migrations using a standard tool",
    parameters: [
      { name: "tool", label: "Migration Tool", type: "select", required: true, options: ["flyway", "knex", "prisma", "liquibase"], description: "Migration tool to use" },
      { name: "connection_var", label: "Connection Variable", type: "string", required: true, description: "Environment variable containing the connection string" },
    ],
    commandTemplate: "npx {{tool}} migrate",
    source: "predefined",
  },
  {
    id: "database-backup",
    name: "Database Backup",
    category: "Database",
    description: "Create a database backup",
    parameters: [
      { name: "connection_var", label: "Connection Variable", type: "string", required: true, description: "Environment variable with connection string" },
      { name: "destination", label: "Destination", type: "string", required: true, description: "Backup file destination" },
      { name: "format", label: "Format", type: "select", required: false, options: ["sql", "custom", "directory"], default: "custom", description: "Backup format" },
    ],
    commandTemplate: "pg_dump -Fc -f {{destination}} ${{connection_var}}",
    source: "predefined",
  },
  {
    id: "run-sql-script",
    name: "Run SQL Script",
    category: "Database",
    description: "Execute a SQL script file",
    parameters: [
      { name: "script_path", label: "Script Path", type: "string", required: true, description: "Path to the SQL file" },
      { name: "connection_var", label: "Connection Variable", type: "string", required: true, description: "Environment variable with connection string" },
      { name: "transaction", label: "Wrap in Transaction", type: "boolean", required: false, default: true, description: "Execute within a transaction" },
    ],
    commandTemplate: "psql ${{connection_var}} -f {{script_path}}",
    source: "predefined",
  },

  // --- Container ---
  {
    id: "docker-build",
    name: "Docker Build",
    category: "Container",
    description: "Build a Docker image",
    parameters: [
      { name: "context", label: "Build Context", type: "string", required: true, default: ".", description: "Build context directory" },
      { name: "dockerfile", label: "Dockerfile", type: "string", required: false, default: "Dockerfile", description: "Path to Dockerfile" },
      { name: "tag", label: "Image Tag", type: "string", required: true, description: "Tag for the built image" },
      { name: "build_args", label: "Build Args", type: "string", required: false, description: "Build arguments (KEY=VALUE, comma-separated)" },
    ],
    commandTemplate: "docker build -t {{tag}} -f {{dockerfile}} {{context}}",
    source: "predefined",
  },
  {
    id: "docker-push",
    name: "Docker Push",
    category: "Container",
    description: "Push a Docker image to a registry",
    parameters: [
      { name: "image", label: "Image", type: "string", required: true, description: "Image name with tag" },
      { name: "registry", label: "Registry", type: "string", required: false, description: "Registry URL (defaults to Docker Hub)" },
    ],
    commandTemplate: "docker push {{image}}",
    source: "predefined",
  },
  {
    id: "docker-pull",
    name: "Docker Pull",
    category: "Container",
    description: "Pull a Docker image from a registry",
    parameters: [
      { name: "image", label: "Image Name", type: "string", required: true, description: "Image name" },
      { name: "tag", label: "Tag", type: "string", required: false, default: "latest", description: "Image tag" },
    ],
    commandTemplate: "docker pull {{image}}:{{tag}}",
    source: "predefined",
  },
  {
    id: "kubernetes-apply",
    name: "Kubernetes Apply",
    category: "Container",
    description: "Apply Kubernetes manifests",
    parameters: [
      { name: "manifest_path", label: "Manifest Path", type: "string", required: true, description: "Path to manifest file or directory" },
      { name: "namespace", label: "Namespace", type: "string", required: false, default: "default", description: "Kubernetes namespace" },
      { name: "context", label: "Context", type: "string", required: false, description: "Kubernetes context" },
    ],
    commandTemplate: "kubectl apply -f {{manifest_path}} -n {{namespace}}",
    source: "predefined",
  },
  {
    id: "kubernetes-rollout-status",
    name: "Kubernetes Rollout Status",
    category: "Container",
    description: "Watch a Kubernetes rollout until completion",
    parameters: [
      { name: "resource", label: "Resource", type: "string", required: true, description: "Resource to watch (e.g., deployment/my-app)" },
      { name: "namespace", label: "Namespace", type: "string", required: false, default: "default", description: "Kubernetes namespace" },
      { name: "timeout", label: "Timeout (seconds)", type: "number", required: false, default: 300, description: "Maximum wait time" },
    ],
    commandTemplate: "kubectl rollout status {{resource}} -n {{namespace}} --timeout={{timeout}}s",
    source: "predefined",
  },

  // --- Traffic ---
  {
    id: "update-load-balancer",
    name: "Update Load Balancer",
    category: "Traffic",
    description: "Update load balancer target group configuration",
    parameters: [
      { name: "target_group", label: "Target Group", type: "string", required: true, description: "Target group name or ARN" },
      { name: "instances", label: "Instances", type: "string", required: true, description: "Instance IDs (comma-separated)" },
      { name: "weight", label: "Weight", type: "number", required: false, default: 100, description: "Traffic weight (0-100)" },
    ],
    commandTemplate: "aws elbv2 register-targets --target-group-arn {{target_group}} --targets Id={{instances}}",
    source: "predefined",
  },
];

// Fast lookup by ID
const PREDEFINED_MAP = new Map(PREDEFINED_STEP_TYPES.map((st) => [st.id, st]));

export function getPredefinedStepType(id: string): StepTypeDefinition | undefined {
  return PREDEFINED_MAP.get(id);
}

export function listPredefinedStepTypes(): StepTypeDefinition[] {
  return PREDEFINED_STEP_TYPES;
}

export const STEP_TYPE_CATEGORIES: StepTypeCategory[] = [
  "General",
  "File & Artifact",
  "Service",
  "Verification",
  "Database",
  "Container",
  "Traffic",
];
