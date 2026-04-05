/**
 * LocalExecutor — runs Synth operations in-process without an HTTP server.
 *
 * Instantiates an EnvoyAgent directly and orchestrates plan → execute for
 * each step, threading inter-step data flow via the same /tmp convention
 * used by the server's composite orchestration.
 *
 * Suitable for:
 * - Playbook development and testing locally
 * - Single-machine operations without distributed setup
 * - CI pipelines where a full server/envoy deployment is not warranted
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DecisionDebrief, LlmClient } from "@synth-deploy/core";
import type { ArtifactAnalysis, DebriefEntry } from "@synth-deploy/core";
import { EnvoyAgent } from "./agent/envoy-agent.js";
import type { PlanningInstruction, PlanningResult, DeploymentResult } from "./agent/envoy-agent.js";
import { LocalStateStore } from "./state/local-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LocalOperationSpec {
  type: "deploy" | "query" | "investigate" | "maintain" | "execute" | "trigger";
  intent?: string;
  artifact?: {
    id: string;
    name: string;
    type: string;
    analysis: ArtifactAnalysis;
  };
  allowWrite?: boolean;
  triggerCondition?: string;
  triggerResponseIntent?: string;
}

export interface LocalRunSpec {
  /** Human-readable name shown in output */
  name?: string;
  /** Stable ID for this run — used as the pipeline parent ID. Generated if omitted. */
  runId?: string;
  /** Target environment. id is generated from name if omitted. */
  environment: {
    id?: string;
    name: string;
    variables?: Record<string, string>;
  };
  /** Optional partition scope. id is generated from name if omitted. */
  partition?: {
    id?: string;
    name: string;
    variables?: Record<string, string>;
  };
  /** Steps to run — single item for a simple op, multiple for composite. */
  steps: LocalOperationSpec[];
  /**
   * LLM API key. Falls back to SYNTH_LLM_API_KEY env var.
   * Never written to disk — used for this run only.
   */
  llmApiKey?: string;
  /**
   * Base workspace directory. Defaults to /tmp/synth/local/<runId>.
   * Created automatically if it does not exist.
   */
  baseDir?: string;
}

export interface LocalStepResult {
  stepIndex: number;
  type: string;
  intent: string;
  /** Plan produced by the EnvoyAgent — contains the scripted steps and reasoning */
  planResult: PlanningResult;
  /** True for deploy/maintain/execute steps that executed successfully */
  executionSuccess?: boolean;
  /** Failure message if the execution step failed */
  executionError?: string;
  /** Execution result for deploy/maintain/execute steps */
  executionResult?: DeploymentResult;
}

export interface LocalRunResult {
  runId: string;
  name: string;
  success: boolean;
  stepResults: LocalStepResult[];
  debriefEntries: DebriefEntry[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// LocalExecutor
// ---------------------------------------------------------------------------

/**
 * Runs Synth operations in-process via EnvoyAgent — no HTTP transport required.
 *
 * For composite runs (multiple steps), each step's output is written to disk
 * at /tmp/synth/pipeline/<runId>/step-<n>-output.json and made available to
 * subsequent steps via the standard priorStepOutputs manifest.
 */
export class LocalExecutor {
  async run(spec: LocalRunSpec): Promise<LocalRunResult> {
    const runId = spec.runId ?? `local-${crypto.randomUUID().slice(0, 8)}`;
    const name = spec.name ?? "local-run";
    const baseDir = spec.baseDir ?? path.join(os.tmpdir(), "synth", "local", runId);

    fs.mkdirSync(baseDir, { recursive: true });

    const debrief = new DecisionDebrief();
    const state = new LocalStateStore();
    const llmApiKey = spec.llmApiKey ?? process.env.SYNTH_LLM_API_KEY;

    const llm = new LlmClient(debrief, "envoy", llmApiKey ? { apiKey: llmApiKey } : {});
    // No ServerReporter in local mode — no server to report back to
    const agent = new EnvoyAgent(debrief, state, baseDir, undefined, llm);

    const environment = {
      id: spec.environment.id ?? `local-env-${spec.environment.name.toLowerCase().replace(/\s+/g, "-")}`,
      name: spec.environment.name,
      variables: spec.environment.variables ?? {},
    };

    const partition = spec.partition
      ? {
          id: spec.partition.id ?? `local-part-${spec.partition.name.toLowerCase().replace(/\s+/g, "-")}`,
          name: spec.partition.name,
          variables: spec.partition.variables ?? {},
        }
      : undefined;

    const isComposite = spec.steps.length > 1;
    const start = Date.now();
    const stepResults: LocalStepResult[] = [];
    const priorStepOutputs: NonNullable<PlanningInstruction["priorStepOutputs"]> = [];
    let success = true;

    for (let i = 0; i < spec.steps.length; i++) {
      const step = spec.steps[i];
      const operationId = `${runId}-step-${i}`;

      const instruction: PlanningInstruction = {
        operationId,
        operationType: step.type,
        intent: step.intent,
        artifact: step.artifact,
        environment,
        partition,
        version: "local",
        resolvedVariables: {
          ...environment.variables,
          ...(partition?.variables ?? {}),
        },
        allowWrite: step.allowWrite,
        triggerCondition: step.triggerCondition,
        triggerResponseIntent: step.triggerResponseIntent,
        llmApiKey,
        priorStepOutputs: priorStepOutputs.length > 0 ? priorStepOutputs : undefined,
        // Only set composite context when there are multiple steps
        parentOperationId: isComposite ? runId : undefined,
        compositeStepIndex: isComposite ? i : undefined,
      };

      let planResult: PlanningResult;
      try {
        planResult = await agent.planDeployment(instruction);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Record failure and abort
        stepResults.push({
          stepIndex: i,
          type: step.type,
          intent: step.intent ?? step.type,
          planResult: {
            plan: { reasoning: "", scriptedPlan: { platform: "bash", reasoning: "", steps: [] } },
            rollbackPlan: { reasoning: "", scriptedPlan: { platform: "bash", reasoning: "", steps: [] } },
          },
          executionSuccess: false,
          executionError: `Planning failed: ${msg}`,
        });
        success = false;
        break;
      }

      // Track step output path for subsequent steps (set by planQuery/planInvestigation)
      if (planResult.stepOutputPath) {
        priorStepOutputs.push({
          stepIndex: i,
          type: step.type,
          intent: step.intent ?? step.type,
          outputPath: planResult.stepOutputPath,
        });
      }

      // Blocked plan — cannot proceed
      if (planResult.blocked) {
        stepResults.push({
          stepIndex: i,
          type: step.type,
          intent: step.intent ?? step.type,
          planResult,
          executionSuccess: false,
          executionError: planResult.blockReason ?? "Plan blocked — see plan assessment",
        });
        success = false;
        break;
      }

      // Query / investigate — findings are the output; no execution phase
      if (step.type === "query" || step.type === "investigate" || step.type === "trigger") {
        stepResults.push({
          stepIndex: i,
          type: step.type,
          intent: step.intent ?? step.type,
          planResult,
          executionSuccess: true,
        });
        continue;
      }

      // Deploy / maintain / execute — run the approved plan deterministically
      let execResult: DeploymentResult;
      try {
        execResult = await agent.executeApprovedPlan(
          operationId,
          planResult.plan,
          planResult.rollbackPlan,
          undefined,  // artifactContext
          undefined,  // progressCallbackUrl
          undefined,  // callbackToken
          operationId, // deploymentId
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stepResults.push({
          stepIndex: i,
          type: step.type,
          intent: step.intent ?? step.type,
          planResult,
          executionSuccess: false,
          executionError: `Execution threw: ${msg}`,
        });
        success = false;
        break;
      }

      stepResults.push({
        stepIndex: i,
        type: step.type,
        intent: step.intent ?? step.type,
        planResult,
        executionSuccess: execResult.success,
        executionError: execResult.failureReason ?? undefined,
        executionResult: execResult,
      });

      if (!execResult.success) {
        success = false;
        break;
      }
    }

    // Clean up inter-step pipeline outputs from /tmp
    const pipelineDir = path.join(os.tmpdir(), "synth", "pipeline", runId);
    try {
      fs.rmSync(pipelineDir, { recursive: true, force: true });
    } catch {
      // Non-fatal — temp files will be cleaned by OS eventually
    }

    return {
      runId,
      name,
      success,
      stepResults,
      debriefEntries: debrief.getRecent(1000),
      durationMs: Date.now() - start,
    };
  }
}
