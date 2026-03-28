# Per-Step Script Execution Model — Design Document

**Date:** 2026-03-28
**Status:** Proposed ([synth-deploy/synth#252](https://github.com/synth-deploy/synth/issues/252))
**Supersedes:** Monolithic script execution model from SCRIPTED-PLANS-DESIGN-2026-03-24.md

---

## Problem Statement

The scripted plans design (2026-03-24) replaced structured step handlers with LLM-generated scripts. This was the right move — it eliminated the handler registry, keyword matching, and step-type vocabulary. But it introduced a structural mismatch: **the plan is structured (step summaries) while execution is unstructured (one monolithic script).**

This mismatch creates five concrete problems:

### 1. Marker injection is a hack

The LLM is prompted to embed `##SYNTH_STEP:<n>:<description>` echo markers in the script. It does so inconsistently. `injectStepMarkers()` in `script-runner.ts` (lines 95-151) post-processes the script to heuristically distribute markers across "command blocks" — groups of non-empty, non-comment lines. This is brittle: the heuristic can misattribute steps to the wrong command blocks, and the proportional distribution (`Math.floor((s / stepSummary.length) * blockStarts.length)`) makes assumptions about script structure that may not hold.

### 2. Output attribution is approximate

During execution, the line-by-line parser in `executePlan()` (lines 196-251) assigns every stdout line to "whatever `##SYNTH_STEP` marker we last saw." If the marker injection placed a marker in the wrong position, or if the LLM's markers don't align with its `stepSummary`, output attribution is wrong. The user sees step 2's output under step 3's header in the UI.

### 3. Rollback is imprecise

There is one monolithic `rollbackScript` per plan. When execution fails mid-script, the rollback runs the entire reversal blob — it has no way to know which steps completed and which didn't. It either over-rolls (undoing things that weren't done) or under-rolls (missing things that were). The runner knows which step marker was last seen, but that information isn't used to scope rollback.

### 4. Refinement is all-or-nothing

When the user gives feedback on a plan, the LLM regenerates the entire monolithic `executionScript`, `dryRunScript`, and `rollbackScript`. There is no way to target a specific step. The user cannot see what changed in the regenerated plan without manually diffing the full scripts.

### 5. Dry-run is monolithic

One `dryRunScript` validates the entire plan. The result is a single pass/fail with potentially hundreds of lines of output. The user cannot see which specific step's preconditions failed without reading the raw output.

---

## Core Design Change

**Align the execution unit with the plan unit.** Each plan step is an independently executable, validatable, reviewable, and rollbackable script.

### Before (monolithic)

```
ScriptedPlan {
  executionScript: string          // One script for entire plan
  dryRunScript: string | null      // One validation for entire plan
  rollbackScript: string | null    // One rollback for entire plan
  stepSummary: StepSummary[]       // Metadata about the script (can diverge)
}
```

### After (per-step)

```
ScriptedPlan {
  platform: "bash" | "powershell"
  reasoning: string
  steps: PlanStep[]
  diffFromCurrent?: ConfigChange[]
}

PlanStep {
  description: string              // What this step does (human-readable)
  script: string                   // The executable script for this step
  dryRunScript: string | null      // Validation script for this step
  rollbackScript: string | null    // Reversal script for this step
  reversible: boolean              // Whether this step can be rolled back
}
```

The `executionScript`, `dryRunScript`, `rollbackScript`, and `stepSummary` top-level fields are eliminated. `StepSummary` is eliminated as a separate type — its fields (`description`, `reversible`) are merged into `PlanStep`.

---

## Decision Record

The following decisions were made during brainstorming. Each is documented here so they do not need to be re-reasoned during implementation.

### Decision 1: The LLM decides step granularity

**Decision:** No enforced step count range. The LLM decides how many steps a plan has and what each step contains.

**Rationale:** Synth's value proposition is shared intelligence — the LLM reasons about *how*, the human judges *whether*. Hardcoding a step count range (e.g., "3-8 steps per deploy") would be the system second-guessing both sides. An engineer reviewing a plan with 12 steps can request consolidation through the refinement loop. An engineer reviewing a 2-step plan can request more granularity. The prompt should guide the LLM toward "each step is one logical operation an engineer would describe in a sentence" but not enforce boundaries.

**Implementation note:** The prompt should say something like: "Break the operation into logical steps. Each step should represent a single coherent action — 'install dependencies,' 'deploy the container,' 'verify health.' A step should be meaningful on its own but not so granular that the plan becomes noise." No validation on step count.

### Decision 2: State threading is invisible to the planning stage

**Decision:** The execution engine handles cwd and environment variable continuity between steps. The LLM writes scripts as if they're running in a continuous shell session. The planning prompt does not mention state threading.

**Rationale:** If the planning prompt had to explain "each step runs in a separate process, so you must use absolute paths and re-export variables," it would add cognitive load to the prompt and produce more verbose, defensive scripts. Instead, the runner captures state after each step and injects it into the next. From the LLM's perspective, `cd /opt/app` in step 1 means step 2 starts in `/opt/app`.

**Implementation detail:** After each step's script process exits, the runner should:

1. **Capture cwd:** The step script should end with an implicit `pwd` capture. The runner can append `; echo "##SYNTH_CWD:$(pwd)"` to each step's script (this is an execution-engine concern, not a plan concern — the user sees the clean script, the runner appends the capture internally).
2. **Capture env delta:** Similarly, the runner can append `; env` and diff against the starting environment to detect new or changed variables.
3. **Inject into next step:** The next step's process spawns with the captured cwd as its working directory and the captured env vars merged into its environment.

The LLM never sees this mechanism. The approved plan shows clean scripts. The debrief records the state that flowed between steps (see Decision 8).

**Alternative considered:** Having scripts accept parameters and return structured output. Rejected because it would require the planning stage to reason about inter-step data flow, violating the goal of keeping state threading invisible to planning.

### Decision 3: Rollback walks backward through completed steps

**Decision:** On execution failure, the runner reverses through the list of completed steps and executes each step's `rollbackScript` in reverse order. Steps with `reversible: false` are skipped and flagged in the debrief.

**Rationale:** Today's monolithic rollback script runs blind — it doesn't know how far execution progressed. With per-step scripts, the runner has structural knowledge of which steps completed (their process exited 0). Rollback is precise to the failure point.

**Implementation detail:**

- If step 4 fails, the runner rolls back steps 3, 2, 1 (in that order).
- Step 4 itself is NOT rolled back — it failed, so its changes may be partial and unpredictable. Its `rollbackScript` could make things worse.
- Each rollback step's output is captured individually for the debrief.
- If a rollback step fails, execution continues to the next rollback step (best-effort). The debrief records which rollback steps succeeded and which failed.
- Steps with `reversible: false` are skipped. The debrief explicitly records: "Step 2 (description) was not rolled back — marked as non-reversible at planning time."

**State threading during rollback:** Rollback scripts run in reverse order. Each rollback script receives the env/cwd captured *after* its corresponding execution step completed. This ensures rollback runs in the same context the step created.

### Decision 4: Refinement lets the LLM decide what to change

**Decision:** When the user provides feedback on a plan, the LLM receives the complete step array plus the feedback and returns a complete new step array. The LLM decides which steps to modify — there is no mechanical rule like "regenerate from step N onward."

**Rationale:** A rule like "if the user says fix step 3, regenerate steps 3-N" is the system being rigid when the LLM could be intelligent. The LLM might determine that only step 3 needs to change. Or it might determine that steps 3 and 6 need to change because step 6 references something from step 3. Or it might determine that the entire plan structure needs rethinking. The LLM is better positioned to make this judgment than a mechanical rule.

**Implementation detail:**

- The refinement prompt sends the full current step array (descriptions + scripts) plus the user's feedback.
- The LLM returns a complete new step array.
- The runner diffs the old and new step arrays to determine which steps changed. Diffing is at the script text level — if a step's `script`, `dryRunScript`, or `rollbackScript` changed, the step is marked as "changed."
- The UI shows the diff result (see Decision 5).

**Why not "regenerate from N onward":** Considered and rejected. While it's conservative (avoids silently changing steps the user already approved), it frustrates engineers who carefully reviewed steps 5-7 and asked to fix step 3. The LLM deciding independently + a clear diff UI is the better tradeoff. The engineer sees exactly what changed and re-reviews only those steps.

### Decision 5: Progressive disclosure on refinement diffs

**Decision:** After refinement, each step in the UI shows a changed/unchanged flag. Drilling into a changed step reveals a full script diff against the prior version.

**Rationale:** At 2am nobody is going to carefully re-diff every step to see what changed. The changed/unchanged flag lets the engineer glance at the plan and see "I asked to fix step 3, steps 3 and 4 changed, steps 5-7 are identical." If they care about the exact change, they drill in. Maximum audit capability without overloading the user if they don't care to look.

**Implementation detail:**

- The server stores the prior plan version when refinement begins.
- After the LLM returns the new plan, the server diffs each step:
  - Compare `steps[i].script` text between old and new
  - Compare `steps[i].dryRunScript` text
  - Compare `steps[i].rollbackScript` text
  - Compare `steps[i].description` text
  - If any changed, the step is flagged as `changed: true`
- Steps added or removed are flagged distinctly (not just "changed").
- The diff payload includes both old and new versions of each changed field so the UI can render a side-by-side or inline diff.
- The `OperationPlan` type gains a `diffFromPreviousPlan` field (or similar) that carries this per-step diff metadata. This replaces the current `diffFromPreviousPlan?: string` field which is a free-text summary.

### Decision 6: Per-step dry-run with step-level pass/fail

**Decision:** Each step has its own optional `dryRunScript`. During the dry-run phase, each step's dry-run script runs independently. Results are reported at the step level.

**Rationale:** Today's monolithic dry-run produces one pass/fail for the entire plan. "Dry-run failed" with 200 lines of output is not actionable at 2am. "Step 5 dry-run failed: port 8080 already in use" is immediately actionable and feeds directly into the refinement loop — the engineer says "use port 8081 instead," the LLM regenerates the relevant steps, and dry-run re-runs on the changed steps.

**Implementation detail:**

- Dry-run runs each step's `dryRunScript` sequentially in the same order as execution.
- State threading (cwd, env) applies to dry-run scripts the same way it applies to execution scripts.
- If a step's `dryRunScript` is null, that step is skipped during dry-run (not all steps need validation — e.g., a simple `echo` step).
- Dry-run results per step are reported to the UI: passed, failed, or skipped.
- On failure, the dry-run continues through remaining steps (unlike execution, which stops). This gives the user a complete picture of all failing preconditions, not just the first one.
- Dry-run results feed back to the LLM during the planning loop (existing behavior, but now per-step).

**Open question:** Should dry-run re-run only changed steps after refinement, or all steps? Re-running only changed steps is faster and avoids redundant validation. But a change to step 3 might invalidate step 5's preconditions. Recommendation: re-run all steps after refinement. The cost is minimal (dry-run scripts are read-only probes) and the safety margin is worth it.

### Decision 7: Plan representation matches execution reality

**Decision:** The UI shows the plan as a vertical flow of step blocks. Each block shows the description as a header with the script visible on expand. The boundaries are explicit — each block is what runs as an individual process.

**Rationale:** The user said: "The representation needs to accurately show what is running." If per-step scripts are what actually execute, the UI must show per-step scripts. Showing one merged view would lie about execution boundaries.

**Implementation detail:**

- Plan approval screen: ordered list of collapsible step cards.
  - Header: step number + description + reversible badge
  - Expanded: script text (syntax-highlighted), dry-run script (if present), rollback script (if present)
  - Status indicators during dry-run: checkmark (passed), X (failed), dash (skipped/no dry-run)
- During execution: same card layout, but with real-time progress:
  - Active step: spinner + streaming output
  - Completed steps: checkmark + collapsed output (expandable)
  - Failed step: X + error output
  - Pending steps: grayed out
- The full plan is visible as one cohesive vertical flow. The cards make step boundaries clear without scattering steps across separate views.

### Decision 8: Debrief records everything, including state threading

**Decision:** The debrief records per-step execution output, per-step rollback output, and the environment/cwd state that was threaded between steps. Errs on the side of too much information rather than too little.

**Rationale:** The user said: "Debrief should err on the side of TOO MUCH information rather than too little." An engineer reviewing what happened at 3am needs to see not just what each step did, but what context each step ran in. "Step 2 set CONTAINER_ID=abc123 which step 4 consumed" is useful forensics.

**Implementation detail:**

- Each step's debrief record includes:
  - `description`: What the step was supposed to do
  - `script`: The exact script that ran
  - `stdout`: Full stdout capture
  - `stderr`: Full stderr capture
  - `exitCode`: Process exit code
  - `durationMs`: How long the step took
  - `success`: Boolean
  - `cwdBefore`: Working directory when this step started
  - `cwdAfter`: Working directory when this step ended
  - `envDelta`: Environment variables that changed during this step (key-value pairs of new or modified vars)
  - `envInherited`: Notable env vars inherited from prior steps (what state flowed in)
- Rollback debrief records the same fields per rollback step, plus:
  - `skipped`: Boolean (true if `reversible: false`)
  - `skipReason`: "Non-reversible step" (for debrief clarity)
- Dry-run debrief records per step: pass/fail, output, duration.
- The debrief UI shows this in a timeline view. The default view is high-level (step descriptions with pass/fail). Drilling in shows full output, env deltas, and timing.

### Decision 9: Composite operations are unchanged at the orchestration layer

**Decision:** The per-step change is internal to each child plan. Composite orchestration continues to work the same way.

**Rationale:** A composite operation is already structured as `Operation > ChildOperation[] > Plan`. Each child operation has its own plan with its own lifecycle. The per-step format lives at the leaf level — inside each child's plan. The composite orchestrator sequences or parallelizes child operations, and each child's execution uses the new per-step runner.

**Structure:**

```
CompositeOperation
  └─ ChildOperation[]
       └─ Plan
            └─ steps: PlanStep[]   // Each step: { description, script, dryRunScript?, rollbackScript?, reversible }
```

No changes needed to composite scheduling, child dependency resolution, or cross-child coordination.

---

## Type Changes

### packages/core/src/types.ts

**Remove:**

```typescript
// Remove StepSummary (lines 86-91)
export interface StepSummary {
  description: string;
  reversible: boolean;
}
```

**Replace ScriptedPlan (lines 94-109):**

```typescript
// Before
export interface ScriptedPlan {
  platform: "bash" | "powershell";
  executionScript: string;
  dryRunScript: string | null;
  rollbackScript: string | null;
  reasoning: string;
  stepSummary: StepSummary[];
  diffFromCurrent?: ConfigChange[];
}

// After
export interface PlanStep {
  /** Human-readable description of what this step does */
  description: string;
  /** The executable script for this step */
  script: string;
  /** Read-only validation script for this step. Null if no validation needed */
  dryRunScript: string | null;
  /** Reversal script for this step. Null if the step is non-reversible */
  rollbackScript: string | null;
  /** Whether this step can be rolled back */
  reversible: boolean;
}

export interface ScriptedPlan {
  /** Platform the scripts target */
  platform: "bash" | "powershell";
  /** Plain-english explanation of the plan */
  reasoning: string;
  /** Ordered sequence of execution steps */
  steps: PlanStep[];
  /** What configuration will change */
  diffFromCurrent?: ConfigChange[];
}
```

**Update OperationPlan (lines 111-117):**

The `OperationPlan.scriptedPlan` field type changes automatically since `ScriptedPlan` is redefined. The `diffFromPreviousPlan` field should change from `string` to a structured per-step diff:

```typescript
export interface StepDiff {
  stepIndex: number;
  status: "unchanged" | "changed" | "added" | "removed";
  /** Previous version of the step (null if added) */
  previous: PlanStep | null;
  /** Current version of the step (null if removed) */
  current: PlanStep | null;
}

export interface OperationPlan {
  scriptedPlan: ScriptedPlan;
  reasoning: string;
  diffFromCurrent?: ConfigChange[];
  /** Per-step diff from refinement. Null on first plan, populated after feedback. */
  stepDiffs?: StepDiff[];
}
```

### packages/envoy/src/execution/script-runner.ts

**Remove:**

- `injectStepMarkers()` function (lines 95-151)
- `EXISTING_MARKER_RE` constant (line 84)
- The entire line-by-line marker parsing state machine in `executePlan()` (lines 196-251)

**Replace `executePlan()` with a sequential step runner:**

```typescript
async executePlan(
  plan: ScriptedPlan,
  operationId: string,
  onProgress?: ScriptProgressCallback,
): Promise<ScriptedPlanResult> {
  const totalSteps = plan.steps.length;
  const completedSteps: number[] = [];
  const stepResults: StepResult[] = [];

  for (let i = 0; i < totalSteps; i++) {
    const step = plan.steps[i];

    onProgress?.({
      operationId,
      type: "plan-step-started",
      phase: "execution",
      stepIndex: i,
      stepDescription: step.description,
      totalSteps,
      timestamp: new Date(),
      overallProgress: 10 + (i / totalSteps) * 80,
    });

    const result = await this.runScript(
      step.script,              // Only this step's script
      plan.platform,
      (chunk) => { /* emit step-output events with stepIndex: i */ },
      {
        cwd: capturedCwd,       // From prior step
        env: capturedEnv,       // From prior step
      }
    );

    // Capture cwd and env delta for next step
    // (implementation: append pwd/env capture to script internally)

    if (result.success) {
      completedSteps.push(i);
      onProgress?.({ type: "plan-step-completed", stepIndex: i, ... });
    } else {
      onProgress?.({ type: "plan-step-failed", stepIndex: i, ... });
      // Trigger rollback of completedSteps in reverse order
      await this.rollbackSteps(plan, completedSteps, operationId, onProgress);
      break;
    }
  }
}
```

**Add `rollbackSteps()` method:**

```typescript
private async rollbackSteps(
  plan: ScriptedPlan,
  completedSteps: number[],
  operationId: string,
  onProgress?: ScriptProgressCallback,
): Promise<void> {
  for (const stepIndex of completedSteps.reverse()) {
    const step = plan.steps[stepIndex];

    if (!step.reversible || !step.rollbackScript) {
      // Record skip in debrief
      onProgress?.({ type: "rollback-step-skipped", stepIndex, ... });
      continue;
    }

    onProgress?.({ type: "rollback-step-started", stepIndex, ... });
    const result = await this.runScript(
      step.rollbackScript,
      plan.platform,
      (chunk) => { /* emit rollback output events */ },
      {
        cwd: capturedCwdForStep[stepIndex],  // Context from after this step ran
        env: capturedEnvForStep[stepIndex],
      }
    );
    // Continue even if rollback fails — best effort, record in debrief
  }
}
```

**Update `runScript()` signature** to accept cwd and env overrides:

```typescript
async runScript(
  script: string,
  scriptPlatform: ScriptedPlan["platform"],
  onOutput?: (chunk: string) => void,
  context?: { cwd?: string; env?: Record<string, string> },
): Promise<ScriptResult>
```

The `spawn()` call in `runScript()` uses `context.cwd` and `context.env` when provided:

```typescript
const child = spawn(shell, args, {
  stdio: ["ignore", "pipe", "pipe"],
  timeout: this.timeoutMs,
  cwd: context?.cwd ?? undefined,
  env: { ...process.env, ...context?.env },
});
```

### packages/envoy/src/execution/progress-reporter.ts

**Update event translation** to handle new event types:

- `rollback-step-started` / `rollback-step-completed` / `rollback-step-skipped` (new)
- Remove handling for `script-output` (replaced by per-step `step-output`)

### packages/server/src/api/progress-event-store.ts

**Update `ProgressEvent` type** to include new event types:

```typescript
type:
  | "plan-step-started"
  | "plan-step-completed"
  | "plan-step-failed"
  | "step-output"
  | "rollback-step-started"
  | "rollback-step-completed"
  | "rollback-step-skipped"
  | "deployment-completed"
```

Remove event types that no longer apply: `script-started`, `script-output`, `script-completed`, `script-failed`, `rollback-started`, `rollback-completed`. These are replaced by the per-step equivalents.

### packages/server/src/api/schemas.ts

**Update `ProgressEventSchema`** Zod schema to match new event types.

---

## Planning Prompt Changes

### Current prompt structure (envoy-agent.ts, lines 2459-2483)

The LLM is told to produce:

```json
{
  "platform": "bash",
  "executionScript": "#!/bin/bash\nset -euo pipefail\n...",
  "dryRunScript": "...",
  "rollbackScript": "...",
  "reasoning": "...",
  "stepSummary": [
    { "description": "Install dependencies", "reversible": true }
  ]
}
```

Plus instructions to embed `##SYNTH_STEP` markers in the script.

### New prompt structure

The LLM produces:

```json
{
  "platform": "bash",
  "reasoning": "...",
  "steps": [
    {
      "description": "Install dependencies",
      "script": "set -euo pipefail\napt-get update && apt-get install -y nginx",
      "dryRunScript": "apt-cache show nginx > /dev/null 2>&1",
      "rollbackScript": "apt-get remove -y nginx",
      "reversible": true
    },
    {
      "description": "Deploy application files",
      "script": "cp -r /tmp/artifact/* /opt/app/",
      "dryRunScript": "test -d /tmp/artifact && test -d /opt/app",
      "rollbackScript": "rm -rf /opt/app/*",
      "reversible": true
    },
    {
      "description": "Verify deployment health",
      "script": "curl -sf http://localhost:8080/health",
      "dryRunScript": null,
      "rollbackScript": null,
      "reversible": false
    }
  ]
}
```

**What changes in the prompt:**

1. **Remove** all instructions about `##SYNTH_STEP` markers. They no longer exist.
2. **Remove** the `executionScript`, `dryRunScript`, `rollbackScript` top-level fields.
3. **Remove** the `stepSummary` field.
4. **Add** the `steps` array with per-step fields.
5. **Add** guidance on step granularity: "Each step should represent one logical operation an engineer would describe in a sentence. Don't make steps so granular that the plan is noisy, and don't make steps so coarse that they lose meaning."
6. **Add** guidance on per-step scripts: "Each step's script runs in its own process but inherits the working directory and environment from the previous step. Write scripts naturally — use `cd`, set variables, reference relative paths — as if they were part of a continuous session."
7. **Add** guidance on per-step dry-run: "Each step's dryRunScript should validate the preconditions for that specific step. Set dryRunScript to null if the step doesn't need validation."
8. **Add** guidance on per-step rollback: "Each step's rollbackScript should reverse exactly what that step's script did. Set rollbackScript to null and reversible to false for steps that cannot be reversed (e.g., sending a notification, running a health check)."
9. **Keep** the `set -euo pipefail` guidance but apply it per-step: "Each step's script should use appropriate error handling for its platform (set -euo pipefail for bash, $ErrorActionPreference = 'Stop' for PowerShell)."

### ParsedPlan type update (envoy-agent.ts, line 2644)

```typescript
// Before
type ParsedPlan = {
  platform: "bash" | "powershell";
  executionScript: string;
  dryRunScript: string | null;
  rollbackScript: string | null;
  reasoning: string;
  stepSummary: Array<{ description: string; reversible: boolean }>;
  diffFromCurrent?: Array<{ key: string; from: string; to: string }>;
};

// After
type ParsedPlan = {
  platform: "bash" | "powershell";
  reasoning: string;
  steps: Array<{
    description: string;
    script: string;
    dryRunScript: string | null;
    rollbackScript: string | null;
    reversible: boolean;
  }>;
  diffFromCurrent?: Array<{ key: string; from: string; to: string }>;
};
```

### Parsing validation update (envoy-agent.ts, line 2657-2681)

Replace validation of `executionScript` (string) and `stepSummary` (array) with validation of `steps` (array where each element has `description` (string) and `script` (string)).

---

## Refinement Flow Changes

### Current flow (envoy-agent.ts line 2454, operations.ts line 916)

1. User provides feedback text
2. `validateRefinementFeedback()` classifies as `replan`, `rejection`, or `response`
3. If `replan`: full `requestPlan()` call with `refinementFeedback` string appended to prompt
4. LLM generates entirely new `executionScript` + `dryRunScript` + `rollbackScript`
5. New plan replaces old plan wholesale

### New flow

1. User provides feedback text (may reference specific step: "step 3 should use port 8081")
2. `validateRefinementFeedback()` — unchanged, still classifies intent
3. If `replan`:
   a. The refinement prompt includes the **complete current step array** (all descriptions + scripts)
   b. The prompt tells the LLM: "The user reviewed this plan and provided feedback. Return a complete updated steps array. You may modify any steps that need to change — only modify what's necessary to address the feedback."
   c. LLM returns a complete new step array
4. Server diffs old steps vs new steps:
   - For each index, compare `script`, `dryRunScript`, `rollbackScript`, `description`
   - If text changed → `status: "changed"`
   - If step exists in new but not old → `status: "added"`
   - If step exists in old but not new → `status: "removed"`
   - Otherwise → `status: "unchanged"`
5. `stepDiffs` is populated on `OperationPlan` and sent to the UI
6. UI renders changed/unchanged flags (see Decision 5)

### Refinement prompt addition

```
## Current Plan Steps

${steps.map((s, i) => `### Step ${i + 1}: ${s.description}\n\`\`\`bash\n${s.script}\n\`\`\`\nDry-run: ${s.dryRunScript ?? 'none'}\nRollback: ${s.rollbackScript ?? 'none'}\nReversible: ${s.reversible}`).join('\n\n')}

## User Refinement Request

${feedback}

Return a complete updated steps array. Modify only the steps that need to change to address the feedback. Do not change steps that are unaffected.
```

---

## Execution Engine: State Threading Detail

This section documents the exact mechanism for maintaining shell state continuity across per-step processes. This is the most implementation-critical section of the design.

### Goal

The LLM writes scripts as if they're in a continuous shell session. The runner makes that assumption true without the LLM's knowledge.

### Mechanism

**After each step completes successfully**, the runner captures the process's final state:

1. **Working directory:** Append `echo "##SYNTH_INTERNAL_CWD:$(pwd)"` to the step's script before execution. Parse the last occurrence of this marker from stdout. Strip it from the output the user sees.
2. **Environment variables:** Append `env | sort` after a unique delimiter (`echo "##SYNTH_INTERNAL_ENV_START"`) to the step's script. Parse the environment block from stdout. Diff against the starting environment to find new/changed variables. Strip from visible output.

**Before each subsequent step**, the runner:

1. Sets `cwd` on the `spawn()` options to the captured working directory.
2. Merges captured env delta into the `spawn()` options' `env`.

### What the user sees

The plan approval UI shows the clean scripts as the LLM generated them — no `##SYNTH_INTERNAL_*` markers. The markers are appended by the runner at execution time, invisible to the user.

The debrief records the captured state transitions: "Step 1 changed cwd from /home/user to /opt/app. Step 2 set CONTAINER_ID=abc123."

### Edge cases

- **Step script explicitly calls `env` or `pwd`**: The runner's appended captures are at the end of the script, after all user-visible output. The internal markers use a unique prefix (`##SYNTH_INTERNAL_`) that won't collide with script output.
- **Step fails**: State is NOT captured from a failed step. Rollback runs with the state from the last *successful* step.
- **Step produces no output**: The internal markers are still emitted (they're part of the appended commands, not the LLM's script).
- **PowerShell**: Use `Write-Output "##SYNTH_INTERNAL_CWD:$(Get-Location)"` and `Get-ChildItem Env: | Format-Table -HideTableHeaders` instead.

### Alternative considered: Explicit script parameters

Having each step declare inputs/outputs (e.g., "step 1 outputs CONTAINER_ID, step 3 inputs CONTAINER_ID"). Rejected because it requires the planning stage to reason about inter-step data flow, which contradicts Decision 2. The env capture mechanism achieves the same result transparently.

---

## Dry-Run Execution Detail

### Current behavior

1. Single `dryRunScript` runs once
2. Output feeds back to LLM for plan refinement
3. Repeat until LLM is satisfied or max iterations reached
4. Present final plan to user

### New behavior

1. Each step's `dryRunScript` runs sequentially (same order as execution)
2. State threading applies — dry-run step 2 inherits cwd/env from dry-run step 1
3. Steps with `dryRunScript: null` are skipped
4. Unlike execution, dry-run does NOT stop on first failure — it runs all steps to give a complete picture
5. Per-step results (pass/fail/skipped + output) feed back to LLM
6. LLM refines the plan (may change any steps)
7. After refinement, dry-run re-runs ALL steps (not just changed ones) — a change to step 3 might invalidate step 5's preconditions
8. Repeat until LLM is satisfied or max iterations reached
9. Present final plan to user with per-step dry-run results

### Dry-run progress events

New event types for the UI:

- `dry-run-step-started` (stepIndex, stepDescription)
- `dry-run-step-passed` (stepIndex, output)
- `dry-run-step-failed` (stepIndex, error, output)
- `dry-run-step-skipped` (stepIndex — no dryRunScript)

---

## Progress Events: What Changes

### Events removed

| Event | Why |
|-------|-----|
| `script-started` | Replaced by first `plan-step-started` |
| `script-output` | Replaced by per-step `step-output` |
| `script-completed` | Replaced by last `plan-step-completed` + `deployment-completed` |
| `script-failed` | Replaced by `plan-step-failed` |
| `rollback-started` | Replaced by first `rollback-step-started` |
| `rollback-completed` | Replaced by last `rollback-step-completed` + `deployment-completed` |

### Events kept

| Event | Change |
|-------|--------|
| `plan-step-started` | No longer parsed from stdout markers — emitted structurally when process spawns |
| `plan-step-completed` | Emitted when process exits 0 |
| `plan-step-failed` | Emitted when process exits non-zero |
| `step-output` | Attribution is perfect — all output from a process IS that step's output |
| `deployment-completed` | Unchanged |

### Events added

| Event | Purpose |
|-------|---------|
| `rollback-step-started` | Per-step rollback tracking |
| `rollback-step-completed` | Per-step rollback success |
| `rollback-step-failed` | Per-step rollback failure |
| `rollback-step-skipped` | Non-reversible step skipped during rollback |
| `dry-run-step-started` | Per-step dry-run tracking |
| `dry-run-step-passed` | Per-step dry-run success |
| `dry-run-step-failed` | Per-step dry-run failure |
| `dry-run-step-skipped` | Step with no dryRunScript |

---

## What Gets Deleted

| File | What | Lines |
|------|------|-------|
| `script-runner.ts` | `injectStepMarkers()` function | 95-151 |
| `script-runner.ts` | `EXISTING_MARKER_RE` constant | 84 |
| `script-runner.ts` | Marker regex + line buffer state machine in `executePlan()` | 196-251 |
| `envoy-agent.ts` | `##SYNTH_STEP` marker instructions in planning prompts | ~1899-1902, ~2480-2483 |
| `types.ts` | `StepSummary` interface | 86-91 |
| `types.ts` | `executionScript`, `dryRunScript`, `rollbackScript`, `stepSummary` fields on `ScriptedPlan` | 97-106 |

---

## Migration Strategy

This is a replacement, not a parallel system. The monolithic script format is removed, not deprecated.

### Sequence

1. **Define new types** — `PlanStep`, updated `ScriptedPlan`, `StepDiff` in `packages/core/src/types.ts`
2. **Update planning prompts** — new JSON format, remove marker instructions, add per-step guidance
3. **Update plan parsing** — validate `steps[]` array instead of `executionScript` string
4. **Build per-step runner** — sequential execution with state threading, replacing marker-based tracking
5. **Build per-step dry-run** — sequential validation with step-level results
6. **Build per-step rollback** — reverse walk with per-step rollback scripts
7. **Update progress events** — new event types, remove old ones, update schemas
8. **Update refinement flow** — send full step array, diff old vs new, populate `stepDiffs`
9. **Update server plan storage** — store new format
10. **Update UI plan display** — step cards, per-step progress, refinement diff view
11. **Delete old code** — `injectStepMarkers()`, marker regex, `StepSummary`, monolithic script fields
12. **Update debrief recording** — per-step output, env delta, cwd tracking

### Risk mitigation

- Steps 1-3 can be done together (type + prompt + parse)
- Steps 4-6 are the core engine change — implement together with thorough testing
- Step 7 can be done alongside 4-6 (progress events are emitted by the runner)
- Step 8 builds on 1-3 (needs new types) and 4 (needs diff logic)
- Steps 9-10 are the server/UI layer — depend on all above
- Step 11 is cleanup after everything works
- Step 12 can be done alongside 9-10

---

## Open Questions (Remaining)

1. **Script timeout per step vs per plan.** Currently `DEFAULT_TIMEOUT_MS = 300_000` (5 min) applies to the entire script. With per-step scripts, does the timeout apply per step or to the total plan execution? Per-step is more forgiving for plans with many steps. Per-plan prevents runaway total execution time. Could do both: per-step timeout (5 min default) + total plan timeout (30 min default).

2. **Step reordering during refinement.** If the user says "run step 4 before step 2," should the LLM reorder steps? Yes — the LLM returns a complete step array and can reorder freely. The diff logic needs to handle reordering: a step that moved positions but didn't change content should be flagged as "moved," not "removed + added."

3. **Parallel steps.** Some operations have steps that could run in parallel (e.g., deploy to 3 independent services). The current sequential model doesn't support this. Out of scope for this design — can be added later by allowing `steps` to contain either a `PlanStep` or a `PlanStepGroup` (parallel batch). Not needed for v1.

4. **Script signing/integrity.** The prior design doc (2026-03-24) raised this as an open question. Still relevant: each step's script should be checksummed at approval time and verified at execution time to guarantee what runs matches what was approved.
