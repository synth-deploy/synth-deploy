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
  | "Networking & Traffic"
  | "Cloud & Infrastructure"
  | "Configuration & Secrets"
  | "Monitoring & Observability"
  | "Rollback & Recovery"
  | "Git & Versioning"
  | "Security & Compliance"
  | "Package & Artifact Management"
  | "SSH & Remote Execution";

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

  // --- Networking & Traffic ---
  {
    id: "update-load-balancer",
    name: "Update Load Balancer",
    category: "Networking & Traffic",
    description: "Update load balancer target group configuration",
    parameters: [
      { name: "target_group", label: "Target Group", type: "string", required: true, description: "Target group name or ARN" },
      { name: "instances", label: "Instances", type: "string", required: true, description: "Instance IDs (comma-separated)" },
      { name: "weight", label: "Weight", type: "number", required: false, default: 100, description: "Traffic weight (0-100)" },
    ],
    commandTemplate: "aws elbv2 register-targets --target-group-arn {{target_group}} --targets Id={{instances}}",
    source: "predefined",
  },
  {
    id: "update-dns-record",
    name: "Update DNS Record",
    category: "Networking & Traffic",
    description: "Create or update a DNS record",
    parameters: [
      { name: "provider", label: "Provider", type: "select", required: true, options: ["route53", "cloudflare", "gcp-dns"], description: "DNS provider" },
      { name: "domain", label: "Domain", type: "string", required: true, description: "Domain name to update" },
      { name: "record_type", label: "Record Type", type: "select", required: false, options: ["A", "CNAME", "AAAA"], default: "A", description: "DNS record type" },
      { name: "value", label: "Value", type: "string", required: true, description: "Record value (IP or hostname)" },
      { name: "ttl", label: "TTL (seconds)", type: "number", required: false, default: 300, description: "Time to live" },
    ],
    commandTemplate: "echo 'Updating {{record_type}} record for {{domain}} to {{value}} via {{provider}}'",
    source: "predefined",
  },
  {
    id: "invalidate-cdn-cache",
    name: "Invalidate CDN Cache",
    category: "Networking & Traffic",
    description: "Purge or invalidate CDN cache entries",
    parameters: [
      { name: "provider", label: "Provider", type: "select", required: true, options: ["cloudfront", "cloudflare", "fastly"], description: "CDN provider" },
      { name: "distribution_id", label: "Distribution ID", type: "string", required: true, description: "CDN distribution or zone identifier" },
      { name: "paths", label: "Paths", type: "string", required: false, default: "/*", description: "Paths to invalidate (comma-separated)" },
    ],
    commandTemplate: "aws cloudfront create-invalidation --distribution-id {{distribution_id}} --paths {{paths}}",
    source: "predefined",
  },
  {
    id: "update-firewall-rule",
    name: "Update Firewall Rule",
    category: "Networking & Traffic",
    description: "Add or update a firewall or security group rule",
    parameters: [
      { name: "group_id", label: "Security Group / Firewall ID", type: "string", required: true, description: "Security group or firewall identifier" },
      { name: "port", label: "Port", type: "number", required: true, description: "Port number to allow" },
      { name: "protocol", label: "Protocol", type: "select", required: false, options: ["tcp", "udp"], default: "tcp", description: "Network protocol" },
      { name: "source_cidr", label: "Source CIDR", type: "string", required: false, default: "0.0.0.0/0", description: "Allowed source CIDR block" },
    ],
    commandTemplate: "aws ec2 authorize-security-group-ingress --group-id {{group_id}} --protocol {{protocol}} --port {{port}} --cidr {{source_cidr}}",
    source: "predefined",
  },
  {
    id: "configure-reverse-proxy",
    name: "Configure Reverse Proxy",
    category: "Networking & Traffic",
    description: "Update reverse proxy configuration and reload",
    parameters: [
      { name: "config_path", label: "Config Path", type: "string", required: true, description: "Path to proxy config file" },
      { name: "upstream", label: "Upstream", type: "string", required: true, description: "Upstream server address (host:port)" },
      { name: "server", label: "Server", type: "select", required: false, options: ["nginx", "haproxy", "caddy"], default: "nginx", description: "Proxy server type" },
    ],
    commandTemplate: "nginx -t && systemctl reload nginx",
    source: "predefined",
  },
  {
    id: "set-maintenance-page",
    name: "Set Maintenance Page",
    category: "Networking & Traffic",
    description: "Enable or disable a maintenance page",
    parameters: [
      { name: "action", label: "Action", type: "select", required: true, options: ["enable", "disable"], description: "Enable or disable maintenance mode" },
      { name: "page_path", label: "Page Path", type: "string", required: false, description: "Path to maintenance page HTML" },
    ],
    commandTemplate: "echo 'Maintenance mode: {{action}}'",
    source: "predefined",
  },

  // --- Cloud & Infrastructure ---
  {
    id: "terraform-plan",
    name: "Terraform Plan",
    category: "Cloud & Infrastructure",
    description: "Run terraform plan to preview infrastructure changes",
    parameters: [
      { name: "working_dir", label: "Working Directory", type: "string", required: true, description: "Terraform project directory" },
      { name: "var_file", label: "Variable File", type: "string", required: false, description: "Path to .tfvars file" },
      { name: "target", label: "Target Resource", type: "string", required: false, description: "Specific resource to target" },
    ],
    commandTemplate: "terraform -chdir={{working_dir}} plan -input=false",
    source: "predefined",
  },
  {
    id: "terraform-apply",
    name: "Terraform Apply",
    category: "Cloud & Infrastructure",
    description: "Apply terraform changes to infrastructure",
    parameters: [
      { name: "working_dir", label: "Working Directory", type: "string", required: true, description: "Terraform project directory" },
      { name: "var_file", label: "Variable File", type: "string", required: false, description: "Path to .tfvars file" },
      { name: "auto_approve", label: "Auto Approve", type: "boolean", required: false, default: true, description: "Skip interactive approval" },
    ],
    commandTemplate: "terraform -chdir={{working_dir}} apply -input=false -auto-approve",
    source: "predefined",
  },
  {
    id: "upload-to-s3",
    name: "Upload to S3",
    category: "Cloud & Infrastructure",
    description: "Upload files to an AWS S3 bucket",
    parameters: [
      { name: "source", label: "Source Path", type: "string", required: true, description: "Local path to upload" },
      { name: "bucket", label: "S3 Bucket", type: "string", required: true, description: "Target S3 bucket name" },
      { name: "prefix", label: "Key Prefix", type: "string", required: false, description: "S3 key prefix (folder path)" },
      { name: "recursive", label: "Recursive", type: "boolean", required: false, default: false, description: "Upload directory recursively" },
    ],
    commandTemplate: "aws s3 cp {{source}} s3://{{bucket}}/{{prefix}} --recursive",
    source: "predefined",
  },
  {
    id: "upload-to-gcs",
    name: "Upload to GCS",
    category: "Cloud & Infrastructure",
    description: "Upload files to a Google Cloud Storage bucket",
    parameters: [
      { name: "source", label: "Source Path", type: "string", required: true, description: "Local path to upload" },
      { name: "bucket", label: "GCS Bucket", type: "string", required: true, description: "Target GCS bucket name" },
      { name: "prefix", label: "Key Prefix", type: "string", required: false, description: "GCS object prefix" },
    ],
    commandTemplate: "gsutil cp -r {{source}} gs://{{bucket}}/{{prefix}}",
    source: "predefined",
  },
  {
    id: "cloudformation-deploy",
    name: "CloudFormation Deploy",
    category: "Cloud & Infrastructure",
    description: "Deploy an AWS CloudFormation stack",
    parameters: [
      { name: "stack_name", label: "Stack Name", type: "string", required: true, description: "CloudFormation stack name" },
      { name: "template", label: "Template", type: "string", required: true, description: "Path to CloudFormation template" },
      { name: "parameters_file", label: "Parameters File", type: "string", required: false, description: "Path to parameters JSON file" },
    ],
    commandTemplate: "aws cloudformation deploy --stack-name {{stack_name}} --template-file {{template}} --capabilities CAPABILITY_IAM",
    source: "predefined",
  },
  {
    id: "aws-cli",
    name: "AWS CLI",
    category: "Cloud & Infrastructure",
    description: "Run an arbitrary AWS CLI command",
    parameters: [
      { name: "service", label: "Service", type: "string", required: true, description: "AWS service (e.g., s3, ec2, lambda)" },
      { name: "command", label: "Command", type: "string", required: true, description: "CLI subcommand and arguments" },
      { name: "region", label: "Region", type: "string", required: false, description: "AWS region override" },
    ],
    commandTemplate: "aws {{service}} {{command}}",
    source: "predefined",
  },
  {
    id: "gcloud-cli",
    name: "Google Cloud CLI",
    category: "Cloud & Infrastructure",
    description: "Run an arbitrary gcloud CLI command",
    parameters: [
      { name: "command", label: "Command", type: "string", required: true, description: "gcloud subcommand and arguments" },
      { name: "project", label: "Project", type: "string", required: false, description: "GCP project ID" },
    ],
    commandTemplate: "gcloud {{command}}",
    source: "predefined",
  },
  {
    id: "az-cli",
    name: "Azure CLI",
    category: "Cloud & Infrastructure",
    description: "Run an arbitrary Azure CLI command",
    parameters: [
      { name: "command", label: "Command", type: "string", required: true, description: "az subcommand and arguments" },
      { name: "resource_group", label: "Resource Group", type: "string", required: false, description: "Azure resource group" },
    ],
    commandTemplate: "az {{command}}",
    source: "predefined",
  },

  // --- Configuration & Secrets ---
  {
    id: "render-template",
    name: "Render Template",
    category: "Configuration & Secrets",
    description: "Generate a config file from a template with variable substitution",
    parameters: [
      { name: "template_path", label: "Template Path", type: "string", required: true, description: "Path to the template file" },
      { name: "output_path", label: "Output Path", type: "string", required: true, description: "Path for the rendered output" },
      { name: "engine", label: "Template Engine", type: "select", required: false, options: ["envsubst", "jinja2", "handlebars"], default: "envsubst", description: "Template rendering engine" },
    ],
    commandTemplate: "envsubst < {{template_path}} > {{output_path}}",
    source: "predefined",
  },
  {
    id: "inject-env-file",
    name: "Inject Env File",
    category: "Configuration & Secrets",
    description: "Generate a .env file from deployment variables",
    parameters: [
      { name: "output_path", label: "Output Path", type: "string", required: true, description: "Path for the .env file" },
      { name: "prefix", label: "Variable Prefix", type: "string", required: false, description: "Only include variables with this prefix" },
    ],
    commandTemplate: "env | sort > {{output_path}}",
    source: "predefined",
  },
  {
    id: "fetch-secret",
    name: "Fetch Secret",
    category: "Configuration & Secrets",
    description: "Retrieve a secret from a secrets manager",
    parameters: [
      { name: "provider", label: "Provider", type: "select", required: true, options: ["vault", "aws-ssm", "gcp-secrets", "az-keyvault"], description: "Secrets provider" },
      { name: "secret_name", label: "Secret Name", type: "string", required: true, description: "Name or path of the secret" },
      { name: "output_var", label: "Output Variable", type: "string", required: true, description: "Environment variable to store the secret in" },
    ],
    commandTemplate: "echo 'Fetching secret {{secret_name}} from {{provider}}'",
    source: "predefined",
  },
  {
    id: "validate-config",
    name: "Validate Config",
    category: "Configuration & Secrets",
    description: "Validate a configuration file against a schema or syntax check",
    parameters: [
      { name: "config_path", label: "Config Path", type: "string", required: true, description: "Path to the configuration file" },
      { name: "format", label: "Format", type: "select", required: true, options: ["json", "yaml", "toml", "nginx", "apache"], description: "Configuration file format" },
    ],
    commandTemplate: "cat {{config_path}} | python3 -m json.tool > /dev/null",
    source: "predefined",
  },

  // --- Monitoring & Observability ---
  {
    id: "create-deploy-marker",
    name: "Create Deploy Marker",
    category: "Monitoring & Observability",
    description: "Record a deployment event in a monitoring system",
    parameters: [
      { name: "provider", label: "Provider", type: "select", required: true, options: ["datadog", "newrelic", "grafana", "pagerduty"], description: "Monitoring provider" },
      { name: "service_name", label: "Service Name", type: "string", required: true, description: "Name of the deployed service" },
      { name: "version", label: "Version", type: "string", required: true, description: "Deployed version" },
      { name: "description", label: "Description", type: "string", required: false, description: "Deployment description" },
    ],
    commandTemplate: "echo 'Deploy marker: {{service_name}} v{{version}} via {{provider}}'",
    source: "predefined",
  },
  {
    id: "check-metric-threshold",
    name: "Check Metric Threshold",
    category: "Monitoring & Observability",
    description: "Poll a metric and verify it stays within acceptable bounds",
    parameters: [
      { name: "metric_name", label: "Metric Name", type: "string", required: true, description: "Name of the metric to check" },
      { name: "threshold", label: "Threshold", type: "number", required: true, description: "Maximum acceptable value" },
      { name: "poll_interval", label: "Poll Interval (seconds)", type: "number", required: false, default: 10, description: "Seconds between checks" },
      { name: "timeout", label: "Timeout (seconds)", type: "number", required: false, default: 120, description: "Maximum polling duration" },
    ],
    commandTemplate: "echo 'Checking metric {{metric_name}} <= {{threshold}} for {{timeout}}s'",
    source: "predefined",
  },
  {
    id: "configure-log-forwarding",
    name: "Configure Log Forwarding",
    category: "Monitoring & Observability",
    description: "Set up or update log forwarding to a log aggregation service",
    parameters: [
      { name: "log_path", label: "Log Path", type: "string", required: true, description: "Path to log file or directory" },
      { name: "destination", label: "Destination", type: "string", required: true, description: "Log aggregation endpoint" },
      { name: "format", label: "Format", type: "select", required: false, options: ["json", "syslog", "plaintext"], default: "json", description: "Log format" },
    ],
    commandTemplate: "echo 'Forwarding logs from {{log_path}} to {{destination}} as {{format}}'",
    source: "predefined",
  },
  {
    id: "silence-alerts",
    name: "Silence Alerts",
    category: "Monitoring & Observability",
    description: "Temporarily silence monitoring alerts during deployment",
    parameters: [
      { name: "service_name", label: "Service Name", type: "string", required: true, description: "Service to silence alerts for" },
      { name: "duration_minutes", label: "Duration (minutes)", type: "number", required: true, default: 15, description: "How long to silence alerts" },
      { name: "provider", label: "Provider", type: "select", required: false, options: ["datadog", "pagerduty", "opsgenie"], default: "pagerduty", description: "Alert provider" },
    ],
    commandTemplate: "echo 'Silencing {{service_name}} alerts for {{duration_minutes}} minutes via {{provider}}'",
    source: "predefined",
  },
  {
    id: "verify-log-output",
    name: "Verify Log Output",
    category: "Monitoring & Observability",
    description: "Check application logs for expected output or absence of errors",
    parameters: [
      { name: "log_path", label: "Log Path", type: "string", required: true, description: "Path to log file" },
      { name: "expected_pattern", label: "Expected Pattern", type: "string", required: true, description: "Regex pattern that should appear in logs" },
      { name: "timeout", label: "Timeout (seconds)", type: "number", required: false, default: 30, description: "How long to wait for the pattern" },
    ],
    commandTemplate: "timeout {{timeout}} grep -m1 '{{expected_pattern}}' <(tail -f {{log_path}})",
    source: "predefined",
  },

  // --- Rollback & Recovery ---
  {
    id: "snapshot-restore",
    name: "Snapshot Restore",
    category: "Rollback & Recovery",
    description: "Restore a system or service from a snapshot",
    parameters: [
      { name: "snapshot_id", label: "Snapshot ID", type: "string", required: true, description: "Identifier of the snapshot to restore" },
      { name: "target", label: "Target", type: "string", required: true, description: "Target volume, instance, or path to restore to" },
    ],
    commandTemplate: "echo 'Restoring snapshot {{snapshot_id}} to {{target}}'",
    source: "predefined",
  },
  {
    id: "rollback-deployment",
    name: "Rollback Deployment",
    category: "Rollback & Recovery",
    description: "Roll back a service to a previous version",
    parameters: [
      { name: "service_name", label: "Service Name", type: "string", required: true, description: "Name of the service to roll back" },
      { name: "method", label: "Method", type: "select", required: true, options: ["kubernetes", "docker", "systemd"], description: "Rollback method" },
      { name: "target_version", label: "Target Version", type: "string", required: false, description: "Version to roll back to (defaults to previous)" },
    ],
    commandTemplate: "kubectl rollout undo deployment/{{service_name}}",
    source: "predefined",
  },
  {
    id: "blue-green-switch",
    name: "Blue-Green Switch",
    category: "Rollback & Recovery",
    description: "Switch traffic between blue and green environments",
    parameters: [
      { name: "target_env", label: "Target Environment", type: "select", required: true, options: ["blue", "green"], description: "Environment to route traffic to" },
      { name: "lb_config", label: "Load Balancer Config", type: "string", required: true, description: "Load balancer target group or config path" },
    ],
    commandTemplate: "echo 'Switching traffic to {{target_env}} environment via {{lb_config}}'",
    source: "predefined",
  },
  {
    id: "canary-promote",
    name: "Canary Promote",
    category: "Rollback & Recovery",
    description: "Promote a canary deployment to full production or roll back",
    parameters: [
      { name: "action", label: "Action", type: "select", required: true, options: ["promote", "rollback"], description: "Promote canary or roll back" },
      { name: "service_name", label: "Service Name", type: "string", required: true, description: "Service running the canary" },
      { name: "traffic_percentage", label: "Traffic %", type: "number", required: false, default: 100, description: "Traffic percentage for promotion" },
    ],
    commandTemplate: "echo 'Canary {{action}} for {{service_name}} at {{traffic_percentage}}%'",
    source: "predefined",
  },
  {
    id: "database-restore",
    name: "Database Restore",
    category: "Rollback & Recovery",
    description: "Restore a database from a backup file",
    parameters: [
      { name: "backup_path", label: "Backup Path", type: "string", required: true, description: "Path to the backup file" },
      { name: "connection_var", label: "Connection Variable", type: "string", required: true, description: "Environment variable with connection string" },
      { name: "format", label: "Format", type: "select", required: false, options: ["sql", "custom", "directory"], default: "custom", description: "Backup format" },
    ],
    commandTemplate: "pg_restore -d ${{connection_var}} {{backup_path}}",
    source: "predefined",
  },

  // --- Git & Versioning ---
  {
    id: "git-tag",
    name: "Git Tag",
    category: "Git & Versioning",
    description: "Create and push a git tag for the release",
    parameters: [
      { name: "tag_name", label: "Tag Name", type: "string", required: true, description: "Tag name (e.g., v1.2.3)" },
      { name: "message", label: "Message", type: "string", required: false, description: "Tag annotation message" },
      { name: "push", label: "Push to Remote", type: "boolean", required: false, default: true, description: "Push the tag to origin" },
    ],
    commandTemplate: "git tag -a {{tag_name}} -m '{{message}}' && git push origin {{tag_name}}",
    source: "predefined",
  },
  {
    id: "bump-version",
    name: "Bump Version",
    category: "Git & Versioning",
    description: "Bump the version number in project files",
    parameters: [
      { name: "bump_type", label: "Bump Type", type: "select", required: true, options: ["major", "minor", "patch"], description: "Semver bump type" },
      { name: "file_path", label: "Version File", type: "string", required: false, default: "package.json", description: "File containing the version" },
    ],
    commandTemplate: "npm version {{bump_type}} --no-git-tag-version",
    source: "predefined",
  },
  {
    id: "generate-changelog",
    name: "Generate Changelog",
    category: "Git & Versioning",
    description: "Generate a changelog from git history",
    parameters: [
      { name: "from_ref", label: "From Ref", type: "string", required: false, description: "Starting git ref (defaults to last tag)" },
      { name: "to_ref", label: "To Ref", type: "string", required: false, default: "HEAD", description: "Ending git ref" },
      { name: "output_file", label: "Output File", type: "string", required: false, default: "CHANGELOG.md", description: "Changelog output path" },
    ],
    commandTemplate: "git log {{from_ref}}..{{to_ref}} --pretty=format:'- %s' > {{output_file}}",
    source: "predefined",
  },
  {
    id: "create-github-release",
    name: "Create GitHub Release",
    category: "Git & Versioning",
    description: "Create a GitHub release with notes and artifacts",
    parameters: [
      { name: "tag", label: "Tag", type: "string", required: true, description: "Release tag" },
      { name: "title", label: "Title", type: "string", required: true, description: "Release title" },
      { name: "notes_file", label: "Notes File", type: "string", required: false, description: "Path to release notes file" },
      { name: "prerelease", label: "Pre-release", type: "boolean", required: false, default: false, description: "Mark as pre-release" },
    ],
    commandTemplate: "gh release create {{tag}} --title '{{title}}' --notes-file {{notes_file}}",
    source: "predefined",
  },

  // --- Security & Compliance ---
  {
    id: "scan-docker-image",
    name: "Scan Docker Image",
    category: "Security & Compliance",
    description: "Run a vulnerability scan on a Docker image",
    parameters: [
      { name: "image", label: "Image", type: "string", required: true, description: "Docker image to scan" },
      { name: "scanner", label: "Scanner", type: "select", required: false, options: ["trivy", "grype", "snyk"], default: "trivy", description: "Vulnerability scanner" },
      { name: "severity", label: "Min Severity", type: "select", required: false, options: ["LOW", "MEDIUM", "HIGH", "CRITICAL"], default: "HIGH", description: "Minimum severity to report" },
    ],
    commandTemplate: "trivy image --severity {{severity}} {{image}}",
    source: "predefined",
  },
  {
    id: "sign-artifact",
    name: "Sign Artifact",
    category: "Security & Compliance",
    description: "Cryptographically sign a build artifact or container image",
    parameters: [
      { name: "artifact", label: "Artifact", type: "string", required: true, description: "Path or image reference to sign" },
      { name: "method", label: "Method", type: "select", required: true, options: ["cosign", "gpg", "sigstore"], description: "Signing method" },
      { name: "key_ref", label: "Key Reference", type: "string", required: false, description: "Signing key path or KMS reference" },
    ],
    commandTemplate: "cosign sign --key {{key_ref}} {{artifact}}",
    source: "predefined",
  },
  {
    id: "rotate-secret",
    name: "Rotate Secret",
    category: "Security & Compliance",
    description: "Rotate a secret or credential and update dependent services",
    parameters: [
      { name: "secret_name", label: "Secret Name", type: "string", required: true, description: "Name of the secret to rotate" },
      { name: "provider", label: "Provider", type: "select", required: true, options: ["vault", "aws-secrets-manager", "gcp-secrets", "az-keyvault"], description: "Secrets provider" },
    ],
    commandTemplate: "echo 'Rotating secret {{secret_name}} via {{provider}}'",
    source: "predefined",
  },
  {
    id: "verify-compliance",
    name: "Verify Compliance",
    category: "Security & Compliance",
    description: "Run a compliance check against a policy set",
    parameters: [
      { name: "policy_path", label: "Policy Path", type: "string", required: true, description: "Path to policy definitions (OPA, Conftest)" },
      { name: "target", label: "Target", type: "string", required: true, description: "File or directory to check against policies" },
      { name: "engine", label: "Engine", type: "select", required: false, options: ["opa", "conftest", "checkov"], default: "conftest", description: "Policy engine" },
    ],
    commandTemplate: "conftest test {{target}} --policy {{policy_path}}",
    source: "predefined",
  },
  {
    id: "dependency-audit",
    name: "Dependency Audit",
    category: "Security & Compliance",
    description: "Audit project dependencies for known vulnerabilities",
    parameters: [
      { name: "tool", label: "Tool", type: "select", required: false, options: ["npm-audit", "pip-audit", "bundler-audit"], default: "npm-audit", description: "Audit tool" },
      { name: "severity", label: "Min Severity", type: "select", required: false, options: ["low", "moderate", "high", "critical"], default: "high", description: "Minimum severity to fail on" },
    ],
    commandTemplate: "npm audit --audit-level={{severity}}",
    source: "predefined",
  },

  // --- Package & Artifact Management ---
  {
    id: "install-dependencies",
    name: "Install Dependencies",
    category: "Package & Artifact Management",
    description: "Install project dependencies using a package manager",
    parameters: [
      { name: "manager", label: "Package Manager", type: "select", required: true, options: ["npm", "yarn", "pnpm", "pip", "bundler"], description: "Package manager" },
      { name: "production", label: "Production Only", type: "boolean", required: false, default: true, description: "Install only production dependencies" },
      { name: "working_dir", label: "Working Directory", type: "string", required: false, description: "Project directory" },
    ],
    commandTemplate: "npm ci --omit=dev",
    source: "predefined",
  },
  {
    id: "publish-package",
    name: "Publish Package",
    category: "Package & Artifact Management",
    description: "Publish a package to a registry",
    parameters: [
      { name: "registry", label: "Registry", type: "select", required: false, options: ["npm", "pypi", "rubygems", "maven"], default: "npm", description: "Package registry" },
      { name: "tag", label: "Tag", type: "string", required: false, default: "latest", description: "Distribution tag" },
      { name: "dry_run", label: "Dry Run", type: "boolean", required: false, default: false, description: "Preview without publishing" },
    ],
    commandTemplate: "npm publish --tag {{tag}}",
    source: "predefined",
  },
  {
    id: "upload-to-registry",
    name: "Upload to Registry",
    category: "Package & Artifact Management",
    description: "Upload a build artifact to an artifact registry",
    parameters: [
      { name: "artifact_path", label: "Artifact Path", type: "string", required: true, description: "Path to the artifact" },
      { name: "registry_url", label: "Registry URL", type: "string", required: true, description: "Target registry URL" },
      { name: "repository", label: "Repository", type: "string", required: true, description: "Repository name in the registry" },
    ],
    commandTemplate: "echo 'Uploading {{artifact_path}} to {{registry_url}}/{{repository}}'",
    source: "predefined",
  },
  {
    id: "build-project",
    name: "Build Project",
    category: "Package & Artifact Management",
    description: "Build a project using its build tool",
    parameters: [
      { name: "tool", label: "Build Tool", type: "select", required: true, options: ["npm", "gradle", "maven", "make", "cargo"], description: "Build tool" },
      { name: "target", label: "Build Target", type: "string", required: false, default: "build", description: "Build target or script name" },
      { name: "working_dir", label: "Working Directory", type: "string", required: false, description: "Project directory" },
    ],
    commandTemplate: "npm run {{target}}",
    source: "predefined",
  },

  // --- SSH & Remote Execution ---
  {
    id: "ssh-command",
    name: "SSH Command",
    category: "SSH & Remote Execution",
    description: "Execute a command on a remote host via SSH",
    parameters: [
      { name: "host", label: "Host", type: "string", required: true, description: "Remote host (user@hostname)" },
      { name: "command", label: "Command", type: "string", required: true, description: "Command to execute remotely" },
      { name: "key_path", label: "Key Path", type: "string", required: false, description: "Path to SSH private key" },
      { name: "port", label: "Port", type: "number", required: false, default: 22, description: "SSH port" },
    ],
    commandTemplate: "ssh -o StrictHostKeyChecking=accept-new -p {{port}} {{host}} '{{command}}'",
    source: "predefined",
  },
  {
    id: "scp-upload",
    name: "SCP Upload",
    category: "SSH & Remote Execution",
    description: "Upload files to a remote host via SCP",
    parameters: [
      { name: "source", label: "Local Source", type: "string", required: true, description: "Local file or directory path" },
      { name: "host", label: "Host", type: "string", required: true, description: "Remote host (user@hostname)" },
      { name: "destination", label: "Remote Destination", type: "string", required: true, description: "Remote path" },
      { name: "recursive", label: "Recursive", type: "boolean", required: false, default: false, description: "Copy directories recursively" },
    ],
    commandTemplate: "scp -r {{source}} {{host}}:{{destination}}",
    source: "predefined",
  },
  {
    id: "rsync-deploy",
    name: "Rsync Deploy",
    category: "SSH & Remote Execution",
    description: "Sync files to a remote host using rsync",
    parameters: [
      { name: "source", label: "Local Source", type: "string", required: true, description: "Local directory to sync" },
      { name: "host", label: "Host", type: "string", required: true, description: "Remote host (user@hostname)" },
      { name: "destination", label: "Remote Destination", type: "string", required: true, description: "Remote directory path" },
      { name: "exclude", label: "Exclude Patterns", type: "string", required: false, description: "Patterns to exclude (comma-separated)" },
      { name: "delete", label: "Delete Extra", type: "boolean", required: false, default: false, description: "Delete files on destination not in source" },
    ],
    commandTemplate: "rsync -avz {{source}} {{host}}:{{destination}}",
    source: "predefined",
  },
  {
    id: "ssh-tunnel",
    name: "SSH Tunnel",
    category: "SSH & Remote Execution",
    description: "Create an SSH tunnel for port forwarding",
    parameters: [
      { name: "host", label: "Host", type: "string", required: true, description: "Remote host (user@hostname)" },
      { name: "local_port", label: "Local Port", type: "number", required: true, description: "Local port to bind" },
      { name: "remote_port", label: "Remote Port", type: "number", required: true, description: "Remote port to forward" },
      { name: "remote_host", label: "Remote Target Host", type: "string", required: false, default: "localhost", description: "Host on the remote side" },
    ],
    commandTemplate: "ssh -N -L {{local_port}}:{{remote_host}}:{{remote_port}} {{host}}",
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
  "Networking & Traffic",
  "Cloud & Infrastructure",
  "Configuration & Secrets",
  "Monitoring & Observability",
  "Rollback & Recovery",
  "Git & Versioning",
  "Security & Compliance",
  "Package & Artifact Management",
  "SSH & Remote Execution",
];
