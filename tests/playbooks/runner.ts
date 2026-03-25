/**
 * Playbook runner — reads YAML playbook files, boots the harness,
 * creates entities, executes operations, and evaluates assertions.
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { PlaybookSchema } from "./schema.js";
import type { PlaybookDefinition, PlaybookResult, AssertionResult, PlaybookAssertion } from "./types.js";
import type { ScenarioHarness } from "../scenarios/harness.js";
import {
  createHarness,
  teardownHarness,
  createPartition,
  createEnvironment,
  createArtifact,
  createOperation,
  getOperation,
} from "../scenarios/harness.js";

// ---------------------------------------------------------------------------
// Playbook discovery
// ---------------------------------------------------------------------------

export interface DiscoveredPlaybook {
  name: string;
  path: string;
  type: string;
  tags: string[];
}

export function discoverPlaybooks(dir: string): DiscoveredPlaybook[] {
  const absDir = path.isAbsolute(dir) ? dir : path.resolve(dir);
  if (!fs.existsSync(absDir)) return [];

  return fs.readdirSync(absDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => {
      const filePath = path.join(absDir, f);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = parseYaml(raw);
      return {
        name: parsed.name ?? f,
        path: filePath,
        type: parsed.type ?? "unknown",
        tags: parsed.tags ?? [],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Parse & validate
// ---------------------------------------------------------------------------

export function parsePlaybook(filePath: string): PlaybookDefinition {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw);
  const result = PlaybookSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid playbook ${filePath}: ${result.error.message}`);
  }
  return result.data as PlaybookDefinition;
}

// ---------------------------------------------------------------------------
// Execute a single playbook
// ---------------------------------------------------------------------------

export async function runPlaybook(
  harness: ScenarioHarness,
  playbookPath: string,
): Promise<PlaybookResult> {
  const start = Date.now();
  const playbook = parsePlaybook(playbookPath);

  try {
    // --- Setup: create entities ---
    const entityMap: Record<string, string> = {}; // name → ID

    for (const env of playbook.setup.environments ?? []) {
      entityMap[`env:${env.name}`] = await createEnvironment(
        harness.server.baseUrl,
        env.name,
        env.variables ?? {},
      );
    }
    for (const part of playbook.setup.partitions ?? []) {
      entityMap[`part:${part.name}`] = await createPartition(
        harness.server.baseUrl,
        part.name,
        part.variables ?? {},
      );
    }
    for (const art of playbook.setup.artifacts ?? []) {
      entityMap[`art:${art.name}`] = await createArtifact(harness.server.baseUrl, art.name);
    }

    // --- Resolve refs ---
    const op = playbook.operation;
    const resolvedEnvironmentId = op.environmentRef ? entityMap[`env:${op.environmentRef}`] : undefined;
    const resolvedPartitionId = op.partitionRef ? entityMap[`part:${op.partitionRef}`] : undefined;
    const resolvedArtifactId = op.artifactRef ? entityMap[`art:${op.artifactRef}`] : undefined;

    // Resolve composite child refs
    const resolvedOperations = op.operations?.map((child) => ({
      type: child.type,
      intent: child.intent,
      artifactId: child.artifactRef ? entityMap[`art:${child.artifactRef}`] : undefined,
      condition: child.condition,
      responseIntent: child.responseIntent,
    }));

    // --- Execute operation ---
    const res = await createOperation(harness.server.baseUrl, {
      type: op.type,
      intent: op.intent,
      environmentId: resolvedEnvironmentId,
      partitionId: resolvedPartitionId,
      artifactId: resolvedArtifactId,
      version: op.version,
      allowWrite: op.allowWrite,
      condition: op.condition,
      responseIntent: op.responseIntent,
      requireApproval: op.requireApproval,
      operations: resolvedOperations,
    });

    // --- Get operation detail for status/debrief assertions ---
    const deployment = res.body.deployment as Record<string, unknown> | undefined;
    const operationId = deployment?.id as string | undefined;
    let detail: { status: number; body: Record<string, unknown> } | undefined;
    if (operationId) {
      detail = await getOperation(harness.server.baseUrl, operationId);
    }

    // --- Evaluate assertions ---
    const assertionResults = playbook.assertions.map((assertion) =>
      evaluateAssertion(assertion, res, detail),
    );

    return {
      name: playbook.name,
      type: playbook.type,
      passed: assertionResults.every((a) => a.passed),
      assertions: assertionResults,
      durationMs: Date.now() - start,
    };
  } catch (error) {
    return {
      name: playbook.name,
      type: playbook.type,
      passed: false,
      assertions: [],
      durationMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Assertion evaluation
// ---------------------------------------------------------------------------

function evaluateAssertion(
  assertion: PlaybookAssertion,
  response: { status: number; body: Record<string, unknown> },
  detail?: { status: number; body: Record<string, unknown> },
): AssertionResult {
  if ("responseStatus" in assertion) {
    const passed = response.status === assertion.responseStatus;
    return {
      assertion,
      passed,
      message: passed
        ? `Response status ${response.status} matches expected ${assertion.responseStatus}`
        : `Expected status ${assertion.responseStatus}, got ${response.status}: ${JSON.stringify(response.body)}`,
    };
  }

  if ("statusIn" in assertion) {
    const dep = (detail?.body.deployment ?? response.body.deployment) as Record<string, unknown> | undefined;
    const status = dep?.status as string | undefined;
    const passed = !!status && assertion.statusIn.includes(status);
    return {
      assertion,
      passed,
      message: passed
        ? `Operation status "${status}" is in [${assertion.statusIn.join(", ")}]`
        : `Operation status "${status ?? "unknown"}" not in [${assertion.statusIn.join(", ")}]`,
    };
  }

  if ("hasDebrief" in assertion) {
    const debrief = detail?.body.debrief as unknown[] | undefined;
    const hasEntries = Array.isArray(debrief) && debrief.length > 0;
    const passed = assertion.hasDebrief ? hasEntries : !hasEntries;
    return {
      assertion,
      passed,
      message: passed
        ? `Debrief presence matches expected (${assertion.hasDebrief})`
        : `Expected hasDebrief=${assertion.hasDebrief}, got ${hasEntries} (${debrief?.length ?? 0} entries)`,
    };
  }

  if ("debriefMinEntries" in assertion) {
    const debrief = detail?.body.debrief as unknown[] | undefined;
    const count = debrief?.length ?? 0;
    const passed = count >= assertion.debriefMinEntries;
    return {
      assertion,
      passed,
      message: passed
        ? `Debrief has ${count} entries (≥ ${assertion.debriefMinEntries})`
        : `Debrief has ${count} entries (expected ≥ ${assertion.debriefMinEntries})`,
    };
  }

  if ("errorContains" in assertion) {
    const bodyStr = JSON.stringify(response.body);
    const passed = bodyStr.toLowerCase().includes(assertion.errorContains.toLowerCase());
    return {
      assertion,
      passed,
      message: passed
        ? `Response contains "${assertion.errorContains}"`
        : `Response does not contain "${assertion.errorContains}": ${bodyStr.slice(0, 200)}`,
    };
  }

  return { assertion, passed: false, message: "Unknown assertion type" };
}

// ---------------------------------------------------------------------------
// Standalone runner — boots its own harness
// ---------------------------------------------------------------------------

export async function runAllPlaybooks(
  dir: string,
  filter?: { type?: string; tags?: string[] },
): Promise<PlaybookResult[]> {
  let playbooks = discoverPlaybooks(dir);

  if (filter?.type) {
    playbooks = playbooks.filter((p) => p.type === filter.type);
  }
  if (filter?.tags?.length) {
    playbooks = playbooks.filter((p) => filter.tags!.some((t) => p.tags.includes(t)));
  }

  if (playbooks.length === 0) {
    console.log("No playbooks found.");
    return [];
  }

  const harness = await createHarness();
  const results: PlaybookResult[] = [];

  try {
    for (const pb of playbooks) {
      const result = await runPlaybook(harness, pb.path);
      results.push(result);
    }
  } finally {
    await teardownHarness(harness);
  }

  return results;
}
