# Operations Model — Design Document

**Date:** 2026-03-20
**Last updated:** 2026-03-23
**Status:** Partially implemented. See Implementation Status section for details.

---

## Problem Statement

Synth today handles one kind of work: deploying artifacts. But deployment engineers do far more than deploy — they run corrective actions, query fleet state, investigate incidents, perform routine maintenance, upgrade tooling, and rotate credentials. These are all operational work, but they don't start with an artifact.

Octopus Deploy solved this with Runbooks — pre-scripted step sequences authored and maintained by humans. Synth can do something fundamentally better: **accept an objective and plan against observed target state**, the same way it already plans deployments. The intelligence that makes Synth's deployments valuable applies to all operational work, not just artifact deployment.

---

## Core Idea

**A deployment is a specific type of operation.** The current flow — artifact, analysis, plan, approve, execute, debrief — generalizes cleanly when the input changes from "here's an artifact" to "here's an objective."

| Today | Generalized |
|---|---|
| Artifact → analysis → plan → approve → execute → debrief | Input → analysis → plan → approve → execute → debrief |

Steps 2–6 are the same machinery. The envoy already probes targets, the LLM already reasons about findings, execution is already deterministic post-approval. The only change is what triggers the process.

---

## Operation Types

### Deploy
What exists today. Input is an artifact reference. LLM analyzes the artifact, probes the target environment, produces a deployment plan. User approves, deterministic execution, debrief.

### Maintain
Mutating operations without an artifact: corrective actions, tooling upgrades, credential rotation, configuration changes. Input is an intent description with optional structured parameters.

Example: *"Rotate TLS certificates on the web-tier partition. Source: /etc/ssl/acme, validity: 90 days."*

The envoy probes current cert state, discovers what infrastructure exists on those specific targets, plans rotation steps appropriate to what it finds. User approves, deterministic execution, debrief.

### Query
Read-only information gathering across targets. Input is a question about infrastructure state. The "plan" is lightweight (what to check and where), risk is near-zero, and the output is a report.

Example: *"What's the cert expiry status across prod?"*

The debrief becomes the deliverable — structured findings, not just a log of actions taken.

### Investigate
Diagnostic operations. Read-only by default, with optional user opt-in for write access. The envoy probes iteratively — each finding informs what to check next. Output is a diagnostic report with structured findings and a proposed resolution.

Example: *"Something is slow on the API tier, investigate."*

The investigation phase IS the planning phase — it's just that planning requires active probing rather than static analysis. Once probing completes, the system has findings and (usually) a proposed fix.

### Trigger
Persistent monitoring directives. Input is a condition and a response intent. The envoy gets a monitoring directive as the "plan" — which probes to run on what schedule, what thresholds to evaluate.

Example: *"When disk > 85%, run log-cleanup"* — typed into the operation input like any other objective.

The LLM parses the condition and response, the user approves the monitoring plan, and the envoy starts watching. When a trigger fires, it spawns a child operation with lineage back to the trigger. The debrief captures what was configured, when it fired, what operation it spawned, and what happened.

Triggers can also be created as a shortcut from debriefs: user sees a successful operation, hits "Create Trigger," and gets a trigger operation pre-filled with the response intent from the debrief — they just add the condition.

### Composite
Multiple operation types in one planned sequence with dependency ordering.

Example: *"Deploy v2.4 to prod, rotate the API keys, and run post-deploy verification."*

Today these are three separate workflows. A composite operation lets the LLM plan them as one coherent sequence.

---

## Investigation → Resolution Pipeline

The key insight: you can't pre-plan a diagnosis tree, but once investigation completes, you have a plan.

**Phase 1 — Investigate** (read-only, light or no approval gate): Envoy probes, correlates, reasons. Output is structured findings plus a proposed resolution.

**Phase 2 — Resolve** (mutating, full approval gate): Findings feed directly into a new operation. The plan is already formed from what was discovered. User reviews, approves, deterministic execution.

The debrief ties both phases into one narrative: investigated X, found Y, proposed Z, executed Z, result was W.

Safety model: read-only investigation can be more autonomous (low risk). The moment mutations are involved, user is back behind an approval gate. Control is never lost.

Lineage: the resolution operation references the investigation that spawned it, creating a traceable chain.

---

## Ask Bar Removal

### Problem
The current SynthChannel (ask bar) is a general-purpose natural-language input. This creates a UX expectation mismatch: users exposed to chatbot interfaces will expect it to answer questions like "How do TLS certs work?" — but Synth is not a chatbot, and building one would violate the "no chatbot UI" constraint.

### Decision
**Remove the ask bar. The operation authoring flow IS the natural-language surface.**

"What's the cert expiry across prod?" typed into an **operation input** field (next to a target selector and scope controls) is obviously a query operation. The surrounding UI context — partition dropdown, target selector, operation type — naturally constrains what makes sense to type. Nobody enters "How do I write a Dockerfile?" into a field labeled "Objective."

For general conversational AI, users connect Claude (or any LLM) via MCP. Synth's MCP server already exposes deployment data, debrief resources, and operational tools. This is the intended path for general Q&A, and documentation should say so clearly.

### What changes
- SynthChannel component is removed from AgentCanvas
- The deployment-authoring panel generalizes to an operation-authoring panel
- The operation input field accepts natural language (the "objective")
- `/api/agent/query` endpoint is repurposed or removed — operational queries go through the normal operation flow
- MCP tools and resources become the external chat integration surface

---

## Reuse: Debriefs as the Re-run Mechanism

### No separate recipe entity

The brainstorm explored "recipes" — saved operation templates. The conclusion: **the debrief already captures everything a recipe would capture.** A recipe is a debrief you want to run again.

### How it works
1. Run an operation. Debrief captures the full context: intent, parameters, targets, plan, execution, outcome.
2. Later: search debriefs, find a past operation, hit **Run Again**.
3. Operation authoring form pre-fills with the previous run's inputs. User adjusts what's changed. Go.

No new entity. No recipe management screen. No "save as recipe" ceremony.

### Formalization path
If users run something frequently enough that searching debriefs feels like friction:
- **Pin/bookmark** a debrief — surfaces it in a quick-access area
- Users can also create an operation from scratch and pin it before ever running it (formalize-first path)

The pinned item is still just a pointer to the inputs that produce a plan. The LLM generates a fresh plan each time against current target state, so the "recipe" never goes stale.

### What this requires
- Debrief search improvements: better filtering, full-text search across intent/reasoning/findings
- **Run Again** action on debrief entries that pre-fills the operation authoring form
- Pin/bookmark capability on debriefs
- Debrief list view surfacing pinned items prominently

---

## Built-in Envoy Health Monitoring

### Principle
Synth is the response system AND the detection system for basic operational health. Deep observability (metrics, dashboards, APM) stays with purpose-built tools. But for threshold-based alerting that triggers automated response, Synth handles it natively.

### Why built-in
Envoys are already deployed on targets. They already probe. Making them do lightweight, scheduled health checks is a natural extension — not a new system. Zero additional install for users. The value proposition: **install Synth, get intelligent monitoring that can fix what it finds.**

### How it works
Triggers are an operation type, not a separate system. Users author trigger operations the same way they author any other operation — through the operation input. "When disk > 85%, run log-cleanup" is a trigger operation. The LLM parses the condition and response, produces a monitoring plan (what to check, how often, what thresholds), user approves, envoy starts watching.

**Envoy-side:**
- Approved trigger operations install monitoring directives on envoys
- Envoys run the specified probes on a schedule using existing probe infrastructure (`probe-executor.ts`, `environment-scanner.ts`)
- When a threshold is crossed, envoy reports to the server

**Server-side:**
- Receives trigger events from envoys
- Spawns child operations (with lineage back to the trigger) through the normal operation flow
- Child operations follow standard approval model (type defaults + environment overrides + per-request override)

**Shortcut from debriefs:**
Users can create triggers from successful debriefs: "Create Trigger" pre-fills the response intent from the debrief, user adds the condition. This is the most natural path — you don't automate something you haven't done manually first.

**Escape hatch:**
External monitoring systems (Prometheus, PagerDuty, Datadog, Grafana) can also trigger operations via a webhook endpoint on the Synth server. This is the integration path for users with existing monitoring — Synth doesn't replace their stack, it responds to their alerts.

### What this is NOT
- Not a full monitoring/observability platform
- Not competing with Prometheus, Datadog, or Grafana
- Not doing time-series storage, dashboards, or complex alerting rules
- IS doing: basic health thresholds → intelligent automated response

---

## Relationship to Existing Architecture

### What stays the same
- **Planning engine**: LLM reasons during planning, execution is deterministic. No change.
- **Partition scoping**: Operations are scoped to partitions the same way deployments are. Partition isolation is preserved.
- **Debrief system**: Every operation produces debrief entries. The non-negotiable constraint holds for all operation types.
- **Envoy execution model**: Envoys execute approved plans. Probe infrastructure reused for queries and investigations.
- **MCP surface**: MCP tools and resources extend to cover operations, not just deployments.

### What changes

**Data model** (`packages/core/src/types.ts`):
- `Deployment` replaced by `Operation` with discriminated union `OperationInput` (see Decisions section)
- New fields: `type` (deploy | maintain | query | investigate | trigger | composite), `intent` (string, for non-artifact operations), `lineage` (parent operation reference), `findings` (for investigations)
- `DeploymentTrigger` generalizes to `OperationTrigger` — can be user-initiated, triggered by health rule, or triggered by webhook
- Trigger operations produce monitoring directives; no separate `TriggerRule` entity

**Server** (`packages/server`):
- `SynthAgent.triggerDeployment()` generalizes to handle operation types
- Planning pipeline branches on type: deploy → artifact analysis path, others → intent analysis path
- New API routes for health reports, trigger rules, webhook receiver
- Query agent endpoint repurposed or removed

**Envoy** (`packages/envoy`):
- Health check scheduler (periodic probes on configurable intervals)
- Health report push to server
- Investigation mode: extended probe loop where findings inform next probes

**UI** (`packages/ui`):
- SynthChannel removed from AgentCanvas
- Deployment-authoring panel becomes operation-authoring panel with type selector
- Debrief panel gains: improved search, Run Again action, pin/bookmark, Create Trigger shortcut
- Active triggers visible in debrief list (filtered view) and on relevant envoys in Topology

---

## Signals Relationship

The existing Signals system (see `synth-signals-spec.md`) detects drift, health patterns, and inconsistencies. Signals and health monitoring overlap but serve different roles:

- **Signals**: Proactive insights derived from cross-environment analysis and historical patterns. Advisory. "You should know about this."
- **Health monitoring**: Threshold-based detection on individual targets. Actionable. "This needs attention, and here's the operation to fix it."

A signal could recommend an operation. A health trigger fires one automatically. They complement each other — signals are the "you might want to" and triggers are the "this needs to happen now."

---

## Build Sequence

1. **Generalize the input model** — operation type field, intent field on the data model, operation-authoring panel accepts natural language objectives alongside artifact selection. Existing deployment flow unchanged; new types enabled.

2. **Query and investigation operations** — read-only probe-as-product. Lowest risk, highest impact, validates the entire model. Debrief captures findings as structured output. Investigation → proposed resolution pipeline.

3. **Ask bar removal** — once operations handle queries natively, SynthChannel is redundant. Remove it, document MCP as the conversational path.

4. **Debrief reuse** — search improvements, Run Again with pre-fill, pin/bookmark. No new entities.

5. **Built-in health monitoring** — envoy health check scheduler, server trigger rules, auto-queued operations.

6. **External webhook triggers** — HTTP endpoint for PagerDuty/Prometheus/etc. to fire operations.

7. **Composite operations** — multi-type sequencing in a single plan. Most complex orchestration; depends on individual types being proven.

---

## Decisions

### Naming — `Operation` replaces `Deployment` (Option B)
`Operation` is the core entity with a discriminated union type. `Deployment` as a standalone concept goes away. The `type` field drives a union for `OperationInput`:

```typescript
type OperationInput =
  | { type: 'deploy'; artifactId: string; artifactVersionId?: string }
  | { type: 'maintain'; intent: string; parameters?: Record<string, unknown> }
  | { type: 'query'; intent: string }
  | { type: 'investigate'; intent: string; allowWrite?: boolean }
  | { type: 'trigger'; condition: string; responseIntent: string; parameters?: Record<string, unknown> }
  | { type: 'composite'; operations: OperationInput[] };
```

Each variant carries only the fields relevant to it. Rename is mechanical — significant but not architectural. Better to do it now pre-adoption than after external API consumers exist.

### Approval model — operation-type defaults + environment overrides
Auto-approve by default for read-only operations, require approval for mutating. Environment overrides (user-configured) can tighten defaults for sensitive environments. User can override per-request at authoring time.

```typescript
approvalDefaults: {
  query: 'auto',
  investigate: 'auto',
  trigger: 'required',
  deploy: 'required',
  maintain: 'required',
  composite: 'required',
  environmentOverrides: {
    'production': { query: 'required', investigate: 'required' },
  }
}
```

At request time, the system resolves the default from type + environment, shows it on the authoring form with reasoning ("Auto-approved: read-only query" or "Requires approval: mutating + production"), and the user can flip it.

### Composite operation approval — single approval, extends fleet pattern
Composite plans are presented as one coherent picture and approved once. Representative selection happens per-phase (since different phases may target different envoy subsets). This extends the existing `FleetDeployment` pattern where representatives plan, user approves the full plan, execution fans out.

---

### Health check configuration — triggers are operations, not config
No separate monitoring configuration surface. Triggers are authored as operations through the same operation input used for everything else. "When disk > 85%, run log-cleanup" is a trigger operation. Debriefs provide a "Create Trigger" shortcut that pre-fills the response intent. Active triggers are visible in the debrief list (filterable) and on relevant envoys in the Topology panel.

---

### Trigger management — operations, not config
Triggers are operations. They appear in the operations list with trigger-specific statuses (`active`, `paused`, `disabled`). Users manage them like any operation: find it, take action (pause, resume, modify, delete). Modifying a trigger creates a new trigger operation with lineage to the old one. No separate management UI.

### Trigger deduplication — cooldown + active check + surfacing
Two-layer protection against duplicate firings:

1. **Cooldown** — part of the monitoring plan the LLM produces. "Check disk every 5 minutes, don't fire again within 30 minutes of last firing." LLM sets a sensible default; user can adjust at approval time.
2. **Active operation check** — before spawning a child operation, the server checks if there's already an in-progress operation from this trigger on the same scope. If yes, skip.

When deduplication suppresses a firing, it is surfaced to the user — repeated trigger hits that get suppressed are indicative of an underlying problem that the response operation isn't fully resolving. The system should make this visible, not silently swallow it.

---

### MCP positioning — honest, not promotional
Synth is not a conversational interface. LLMs have a chat experience we won't match and don't want to — it's not the purpose of the tool. Documentation should be straightforward: Synth exposes an MCP server. If you want to extend Synth's data and actions into your LLM interface of choice, you can. This is a capability, not a selling point.

---

## Implementation Status

*Last updated: 2026-03-23*

### Fully Implemented

**Step 1 — Generalize the input model**
- `Deployment` entity renamed to `Operation` across the entire codebase (types, API routes, server, envoy, UI, tests, MCP, API docs)
- `OperationInput` discriminated union implemented with all 6 types: `deploy`, `maintain`, `query`, `investigate`, `trigger`, `composite`
- Each variant carries only its relevant fields (e.g., `artifactId` only on deploy, `intent` on maintain/query/investigate, `condition`+`responseIntent` on trigger)
- `DeploymentDefaults` renamed to `OperationDefaults`, `createDeployment` renamed to `createOperation`, enrichment fields renamed (`recentOperationsToEnv`, `conflictingOperations`, `lastOperationToEnv`)
- All error messages and log strings updated from "Deployment" to "Operation"
- Deprecated type aliases (`Deployment`, `DeploymentId`, etc.) preserved for any transitional references
- Old `deployments.ts` route file deleted; all 8+ test files migrated to `registerOperationRoutes`
- API docs (`website/src/pages/docs/api.astro`) updated to reference `/api/operations` routes

**Step 2 — Query and investigation operations**
- `QueryEngine` (`packages/envoy/src/agent/query-engine.ts`) — deterministic + LLM-enhanced query answering
- `DiagnosticInvestigator` (`packages/envoy/src/agent/diagnostic-investigator.ts`) — forensic investigation with log pattern matching
- `EnvoyAgent.planQuery()` and `planInvestigation()` — LLM-driven probe loops producing `QueryFindings` and `InvestigationFindings`
- `InvestigationFindings.proposedResolution` carries `intent`, `operationType`, and `parameters` for spawning follow-up operations
- Envoy `PlanRequestSchema` accepts `operationType`, `intent`, and `allowWrite` (fixed from initial implementation where these were missing/stripped)
- `PlanningInstruction.operationType` widened to include all 5 non-composite types

**Step 3 — Ask bar removal**
- `SynthChannel` component fully removed from codebase
- `AgentCanvas` no longer renders any ask bar
- `/api/agent/query` server endpoint removed
- Website API docs updated to remove the endpoint reference
- Operation authoring panel (`DeploymentAuthoringPanel.tsx`) has `opType` selector and `intent` field, serving as the natural-language surface

**Step 4 — Debrief reuse**
- FTS5 full-text search on decision, reasoning, and context fields in `PersistentDecisionDebrief`
- Incremental backfill on startup for existing entries
- `DebriefReader.search()` method with debounced UI input
- Pin/bookmark: `DebriefPinStore` interface, `pinned_operations` SQLite table, `POST/DELETE /api/operations/:id/pin` and `GET /api/operations/pinned` routes
- "Run Again" action in `DebriefPanel.tsx` — pushes operation-authoring panel with pre-filled inputs
- "Create Trigger" shortcut in `DebriefPanel.tsx` — pushes operation-authoring panel with `opType: "trigger"` and pre-filled environment/partition/intent

**Step 5 — Built-in health monitoring**
- `HealthCheckScheduler` (`packages/envoy/src/agent/health-check-scheduler.ts`) — full implementation with install/remove/pause/resume/disable directives
- Probe execution via existing `ProbeExecutor`, condition evaluation (numeric comparisons, string contains, AND/OR logic)
- Cooldown enforcement and suppressed count tracking on the envoy side
- `HealthReport` creation and push to server
- Envoy HTTP routes: `POST /monitor`, `DELETE /monitor/:id`, `POST /monitor/:id/pause`, `POST /monitor/:id/resume`, `GET /monitor`
- Server-side: `POST /api/health-reports` receives reports, validates envoy token, checks deduplication (active child operations), spawns child operations with lineage, tracks fire count and suppressed count
- `EnvoyClient` methods: `installMonitoringDirective`, `pauseMonitoringDirective`, `resumeMonitoringDirective`, `removeMonitoringDirective`, `listMonitoringDirectives`
- Trigger management API routes: `/api/operations/:id/trigger/{pause,resume,disable}`
- Deduplication: two layers (envoy cooldown + server active-operation check), suppressed firings recorded to debrief

**Step 6 — External webhook triggers**
- `registerAlertWebhookRoutes` in `alert-webhooks.ts` — full CRUD for webhook channels
- JWT-exempt alert receipt endpoint for external monitoring systems
- Alert parsers for Prometheus, PagerDuty, Datadog, Grafana, and Generic formats
- Intent interpolation with `{{alert.name}}`, `{{alert.summary}}` template variables
- Per-channel auth (query param, header, or bearer token)
- Deduplication: checks for active operations from the same channel with same alert name
- `triggeredBy: "webhook"` set on webhook-spawned operations; `triggeredBy: "trigger"` set on health-trigger-spawned operations
- `TelemetryAction` and `DecisionType` enums extended with webhook-specific values (no more `as` casts)

**Configurable approval model (cross-cutting)**
- `ApprovalMode` type (`'auto' | 'required'`), `ApprovalDefaults` interface, `DEFAULT_APPROVAL_DEFAULTS` constant in `packages/core/src/types.ts`
- `resolveApprovalMode()` function in `packages/core/src/approval.ts` — resolves from operation type default → environment override → fallback
- `approvalDefaults` field added to `AppSettings` and `DEFAULT_APP_SETTINGS`
- `UpdateSettingsSchema` accepts `approvalDefaults` for configuration via `PUT /api/settings`
- Settings stores (`SettingsStore`, `PersistentSettingsStore`) merge `approvalDefaults` on update
- `operations.ts` planning callback uses `resolveApprovalMode()` instead of hardcoded type checks

### Partially Implemented — Gaps Remaining

**Trigger operations via natural-language authoring**
- **What exists:** The `trigger` type is in the `OperationInput` union. The envoy health monitoring infrastructure works (scheduler, directives, reports, child operation spawning). The operation authoring panel has an `opType` selector that includes trigger.
- **What's missing:** Users cannot type "When disk > 85%, run log-cleanup" into the operation authoring panel and have the LLM parse it into a structured trigger operation (extracting the condition, response intent, and parameters). Currently triggers are created via the API with explicitly structured `condition` and `responseIntent` fields, not via natural-language parsing. The design doc envisions the LLM doing this parsing as part of the planning step — that LLM integration for trigger parsing does not exist yet.

**Investigation → Resolution pipeline (UI flow)**
- **What exists:** `InvestigationFindings.proposedResolution` carries `intent`, `operationType`, and `parameters`. The `lineage` field on `Operation` supports linking a resolution operation back to its parent investigation. The data model is complete.
- **What's missing:** There is no UI flow for promoting investigation findings into a new mutating operation. After an investigation completes and shows findings with a proposed resolution, the user should be able to click a button (e.g., "Apply Fix" or "Create Resolution") that opens the operation authoring panel pre-filled with the proposed resolution's intent, type, and parameters, with `lineage` set to the investigation's ID. This one-click promotion flow does not exist in the UI.

**Run Again pre-fill for non-deploy operations**
- **What exists:** `handleRunAgain()` in `DebriefPanel.tsx` pushes an operation-authoring panel with pre-filled `artifactId`, `environmentId`, `partitionId`, `opType`, and `intent`.
- **What's missing:** Verification that this works correctly for all operation types. The pre-fill was built around the deploy flow. For query/investigate/maintain operations, the `intent` field should pre-fill from the original operation's intent. For trigger operations, `condition` and `responseIntent` should pre-fill. These non-deploy pre-fill paths need testing and likely fixes to ensure the authoring panel correctly receives and displays these values.

**Per-request approval override in the UI**
- **What exists:** The server-side `resolveApprovalMode()` function correctly computes the approval mode from type + environment. The settings API accepts `approvalDefaults` configuration.
- **What's missing:** The operation authoring form does not display the resolved approval mode to the user (e.g., "Auto-approved: read-only query" or "Requires approval: mutating + production"). There is no toggle for the user to override the resolved default at request time. The design doc specifies that users should see the approval reasoning and be able to flip it per-request.

**Create Trigger shortcut from debriefs (end-to-end)**
- **What exists:** `handleCreateTrigger()` in `DebriefPanel.tsx` pushes an operation-authoring panel with `opType: "trigger"` and pre-filled environment/partition/intent.
- **What's missing:** End-to-end verification that this flow works. The authoring panel needs to correctly render the trigger-specific fields (condition input, response intent) when opened in trigger mode. The pre-filled intent from the debrief should populate the `responseIntent` field, not the general `intent` field.

**Monitoring directive defaults from LLM**
- **What exists:** When a trigger operation is created, the server constructs a `MonitoringDirective` from the plan steps with hardcoded defaults (`intervalMs: 60000`, `cooldownMs: 300000`).
- **What's missing:** The design doc says "the LLM sets a sensible default; user can adjust at approval time." Currently the monitoring intervals and cooldowns are hardcoded, not influenced by the LLM's reasoning about the specific condition being monitored. For example, a cert expiry check might warrant a daily interval, while a disk usage check might need 5-minute intervals — the LLM should determine this based on context.

### Not Started

**Step 7 — Composite operations**
- The `composite` type exists in the `OperationInput` union (`{ type: 'composite'; operations: OperationInput[] }`)
- No planning, execution, or UI logic exists for composite operations
- Requires: LLM planning of multi-operation sequences with dependency ordering, per-phase representative selection (extending the `FleetDeployment` pattern), single-approval UI for the full composite plan, phased execution with proper error handling and rollback across phases
- This is the most complex feature in the design doc and depends on all other operation types being proven first
