import type { ScriptedPlan, SecurityBoundary } from "@synth-deploy/core";
import { envoyLog, envoyWarn } from "../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BoundaryAuditResult {
  /** Whether the scripts pass boundary review */
  passed: boolean;
  /** Specific violations found */
  violations: string[];
  /** LLM reasoning about the review */
  reasoning: string;
}

/**
 * Minimal interface for the LLM client needed by the audit pass.
 * This avoids a hard dependency on the full LlmClient class.
 */
export interface AuditLlmClient {
  reason(systemPrompt: string, userPrompt: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

// ---------------------------------------------------------------------------
// LLM Boundary Audit — configurable, not mandatory
// ---------------------------------------------------------------------------

/**
 * Reviews generated scripts against declared security boundaries using
 * an LLM. This is a semantic analysis pass that catches violations the
 * static regex-based BoundaryValidator might miss.
 *
 * Opt-in: users who configure boundaries get enforcement. Users who
 * don't configure boundaries skip this entirely.
 *
 * Injected between plan generation and user presentation — scripts that
 * violate boundaries are flagged before the user ever sees them.
 */
export async function auditScriptBoundaries(
  plan: ScriptedPlan,
  boundaries: SecurityBoundary[],
  llm: AuditLlmClient,
): Promise<BoundaryAuditResult> {
  if (boundaries.length === 0) {
    return { passed: true, violations: [], reasoning: "No boundaries configured — audit skipped." };
  }

  envoyLog("Running LLM boundary audit on scripted plan");

  const boundaryDesc = boundaries.map((b) => {
    const config = JSON.stringify(b.config, null, 2);
    return `- **${b.boundaryType}** boundary:\n${config}`;
  }).join("\n\n");

  const systemPrompt = `You are a security boundary auditor for an operations automation system.

Your job is to review scripts against declared security boundaries and report any violations.

## Security Boundaries

${boundaryDesc}

## Rules

1. A **filesystem** boundary with allowedPaths means the script may only read/write within those paths.
2. An **execution** boundary with allowedCommands means the script may only run those commands (and their sub-commands).
3. A **network** boundary with allowedHosts means the script may only connect to those hosts.
4. A **service** boundary with allowedServices means the script may only manage those services.
5. A **credential** boundary with allowedCredentials means the script may only reference those secrets.

## Response Format

Respond with valid JSON only:
{
  "passed": true/false,
  "violations": ["description of violation 1", "..."],
  "reasoning": "Brief explanation of your assessment"
}

If there are no violations, respond with:
{ "passed": true, "violations": [], "reasoning": "All scripts comply with declared boundaries." }`;

  const scripts = plan.steps.map((s, i) => {
    const parts: string[] = [
      `## Step ${i + 1}: ${s.description}\n\`\`\`${plan.platform}\n${s.script}\n\`\`\``,
    ];
    if (s.dryRunScript) parts.push(`### Dry-Run\n\`\`\`${plan.platform}\n${s.dryRunScript}\n\`\`\``);
    if (s.rollbackScript) parts.push(`### Rollback\n\`\`\`${plan.platform}\n${s.rollbackScript}\n\`\`\``);
    return parts.join("\n");
  }).join("\n\n");

  const userPrompt = `Review the following scripts for security boundary violations:\n\n${scripts}`;

  const result = await llm.reason(systemPrompt, userPrompt);

  if (!result.ok) {
    envoyWarn("LLM boundary audit failed — allowing plan through", { error: result.error });
    return {
      passed: true,
      violations: [],
      reasoning: `LLM audit unavailable: ${result.error}. Plan allowed by default.`,
    };
  }

  try {
    // Extract JSON from possible markdown fences
    let text = result.text.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const parsed = JSON.parse(text) as BoundaryAuditResult;
    if (typeof parsed.passed !== "boolean" || !Array.isArray(parsed.violations)) {
      throw new Error("Invalid audit response shape");
    }

    if (!parsed.passed) {
      envoyWarn("LLM boundary audit found violations", parsed.violations);
    } else {
      envoyLog("LLM boundary audit passed");
    }

    return parsed;
  } catch {
    envoyWarn("Failed to parse LLM audit response — allowing plan through");
    return {
      passed: true,
      violations: [],
      reasoning: "LLM audit response was unparseable. Plan allowed by default.",
    };
  }
}
