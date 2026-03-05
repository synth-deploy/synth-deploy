/**
 * Webhook payload parsers for CI/CD system integrations.
 *
 * Each parser extracts a normalized WebhookPayload from the raw
 * webhook body sent by the respective CI/CD platform.
 */

export interface WebhookPayload {
  artifactName: string;
  artifactType: string;
  version: string;
  source: string;
  downloadUrl?: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GitHub Actions — workflow_run completed event
// ---------------------------------------------------------------------------

export function parseGitHubActionsWebhook(body: unknown): WebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;

  // GitHub sends workflow_run events with action: "completed"
  const workflowRun = data.workflow_run as Record<string, unknown> | undefined;
  if (!workflowRun) return null;

  const conclusion = workflowRun.conclusion as string | undefined;
  if (conclusion !== "success") return null;

  const repo = data.repository as Record<string, unknown> | undefined;
  const repoName = (repo?.name as string) ?? "unknown";
  const headSha = (workflowRun.head_sha as string) ?? "unknown";
  const headBranch = (workflowRun.head_branch as string) ?? "unknown";
  const runNumber = workflowRun.run_number as number | undefined;

  return {
    artifactName: repoName,
    artifactType: "github-actions-build",
    version: runNumber ? `build-${runNumber}` : headSha.slice(0, 8),
    source: "github-actions",
    downloadUrl: (workflowRun.artifacts_url as string) ?? undefined,
    metadata: {
      sha: headSha,
      branch: headBranch,
      workflow: (workflowRun.name as string) ?? "unknown",
      runId: workflowRun.id,
      runNumber,
      htmlUrl: workflowRun.html_url,
    },
  };
}

// ---------------------------------------------------------------------------
// Azure DevOps — build.complete event
// ---------------------------------------------------------------------------

export function parseAzureDevOpsWebhook(body: unknown): WebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;

  const eventType = data.eventType as string | undefined;
  if (eventType !== "build.complete") return null;

  const resource = data.resource as Record<string, unknown> | undefined;
  if (!resource) return null;

  const result = resource.result as string | undefined;
  if (result !== "succeeded") return null;

  const definition = resource.definition as Record<string, unknown> | undefined;
  const buildNumber = (resource.buildNumber as string) ?? "unknown";
  const sourceVersion = (resource.sourceVersion as string) ?? "unknown";

  return {
    artifactName: (definition?.name as string) ?? "unknown",
    artifactType: "azure-devops-build",
    version: buildNumber,
    source: "azure-devops",
    downloadUrl: (resource.url as string) ?? undefined,
    metadata: {
      buildId: resource.id,
      buildNumber,
      sourceVersion,
      sourceBranch: resource.sourceBranch,
      definitionName: definition?.name,
      project: (data.resourceContainers as Record<string, unknown>)?.project,
    },
  };
}

// ---------------------------------------------------------------------------
// Jenkins — build notification
// ---------------------------------------------------------------------------

export function parseJenkinsWebhook(body: unknown): WebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;

  const build = data.build as Record<string, unknown> | undefined;
  if (!build) {
    // Some Jenkins plugins send flat payloads
    if (!data.name && !data.job_name) return null;
    return {
      artifactName: (data.name as string) ?? (data.job_name as string) ?? "unknown",
      artifactType: "jenkins-build",
      version: String(data.build_number ?? data.number ?? "unknown"),
      source: "jenkins",
      downloadUrl: (data.build_url as string) ?? (data.url as string) ?? undefined,
      metadata: {
        status: data.status ?? data.build_status,
        url: data.build_url ?? data.url,
      },
    };
  }

  const phase = build.phase as string | undefined;
  const status = build.status as string | undefined;

  // Only process completed successful builds
  if (phase !== "COMPLETED" && phase !== "FINALIZED") return null;
  if (status && status !== "SUCCESS") return null;

  return {
    artifactName: (data.name as string) ?? "unknown",
    artifactType: "jenkins-build",
    version: String(build.number ?? "unknown"),
    source: "jenkins",
    downloadUrl: (build.full_url as string) ?? (build.url as string) ?? undefined,
    metadata: {
      buildNumber: build.number,
      phase,
      status,
      url: build.full_url ?? build.url,
      scmInfo: build.scm,
    },
  };
}

// ---------------------------------------------------------------------------
// GitLab CI — pipeline event
// ---------------------------------------------------------------------------

export function parseGitLabCIWebhook(body: unknown): WebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;

  const objectKind = data.object_kind as string | undefined;
  if (objectKind !== "pipeline") return null;

  const attrs = data.object_attributes as Record<string, unknown> | undefined;
  if (!attrs) return null;

  const status = attrs.status as string | undefined;
  if (status !== "success") return null;

  const project = data.project as Record<string, unknown> | undefined;

  return {
    artifactName: (project?.name as string) ?? "unknown",
    artifactType: "gitlab-ci-build",
    version: `pipeline-${attrs.id ?? "unknown"}`,
    source: "gitlab-ci",
    downloadUrl: (project?.web_url as string) ?? undefined,
    metadata: {
      pipelineId: attrs.id,
      ref: attrs.ref,
      sha: attrs.sha,
      source: attrs.source,
      projectName: project?.name,
    },
  };
}

// ---------------------------------------------------------------------------
// CircleCI — workflow-completed event
// ---------------------------------------------------------------------------

export function parseCircleCIWebhook(body: unknown): WebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;

  const type = data.type as string | undefined;
  if (type !== "workflow-completed") return null;

  const workflow = data.workflow as Record<string, unknown> | undefined;
  if (!workflow) return null;

  const status = workflow.status as string | undefined;
  if (status !== "success") return null;

  const pipeline = data.pipeline as Record<string, unknown> | undefined;
  const project = data.project as Record<string, unknown> | undefined;

  return {
    artifactName: (project?.name as string) ?? "unknown",
    artifactType: "circleci-build",
    version: `workflow-${workflow.id ?? "unknown"}`,
    source: "circleci",
    metadata: {
      workflowId: workflow.id,
      workflowName: workflow.name,
      pipelineId: pipeline?.id,
      pipelineNumber: pipeline?.number,
      projectSlug: project?.slug,
    },
  };
}

// ---------------------------------------------------------------------------
// Generic — expects normalized payload
// ---------------------------------------------------------------------------

export function parseGenericWebhook(body: unknown): WebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const data = body as Record<string, unknown>;

  const artifactName = data.artifactName as string | undefined;
  const version = data.version as string | undefined;

  if (!artifactName || !version) return null;

  return {
    artifactName,
    artifactType: (data.type as string) ?? "generic",
    version,
    source: (data.source as string) ?? "generic",
    downloadUrl: (data.downloadUrl as string) ?? undefined,
    metadata: (data.metadata as Record<string, unknown>) ?? {},
  };
}

// ---------------------------------------------------------------------------
// Router — dispatch to the correct parser based on source
// ---------------------------------------------------------------------------

export function parseWebhook(source: string, body: unknown): WebhookPayload | null {
  switch (source) {
    case "github-actions":
      return parseGitHubActionsWebhook(body);
    case "azure-devops":
      return parseAzureDevOpsWebhook(body);
    case "jenkins":
      return parseJenkinsWebhook(body);
    case "gitlab-ci":
      return parseGitLabCIWebhook(body);
    case "circleci":
      return parseCircleCIWebhook(body);
    default:
      return parseGenericWebhook(body);
  }
}
