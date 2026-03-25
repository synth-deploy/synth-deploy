# Synth — Testing & QA

Synth has a multi-layer testing architecture designed for a solo developer who needs maximum coverage with minimum manual effort. The system is largely autonomous — it generates tests, runs them on a schedule, and files issues for what it finds.

---

## Quick Reference

| Command | What it does |
|---------|-------------|
| `npm test` | Unit tests across all 4 packages |
| `npm run test:coverage` | Unit tests + coverage enforcement (fails if thresholds drop) |
| `npm run test:integration` | Integration + E2E + scenario tests |
| `npm run test:scenarios` | Scenario tests only (smoke + fault-injection + playbooks) |
| `npm run test:playbooks` | Playbook tests only |
| `npm run exercise` | Standalone playbook runner (no vitest, structured output) |
| `npm run exercise -- --type=trigger` | Run playbooks filtered by operation type |

---

## Layer 1: Unit Tests

Standard vitest tests per package. Each package has coverage thresholds that fail CI if they drop.

```
packages/core/tests/         # Partition isolation, debrief retention
packages/server/tests/       # Auth, envoy client, SSRF, step runner, composites
packages/envoy/tests/        # Lifecycle, query engine, diagnostic investigator, health scheduler
packages/ui/tests/           # Components, authoring panel, debrief rendering, theme compliance
```

**Coverage thresholds** are in each package's `vitest.config.ts`. CI enforces them via `npm run test:coverage`.

---

## Layer 2: Declarative Playbooks

YAML-driven scenario testing. Adding a test = adding a YAML file. No TypeScript needed.

### Playbook location

```
tests/playbooks/
  *.yaml          # Scenario definitions (git-tracked, self-expanding)
  runner.ts       # Engine: parse YAML → create entities → execute → assert
  schema.ts       # Zod validation for playbook format
  types.ts        # TypeScript interfaces
  cli.ts          # Standalone CLI entry point
```

### Playbook format

```yaml
name: "Maintain: rotate API keys"
type: maintain
tags: [maintain, production, security]

setup:
  environments:
    - name: production
      variables: { APP_ENV: production }
  partitions:
    - name: AcmeCorp
      variables: { DB_HOST: acme-db.internal }

operation:
  type: maintain
  intent: "Rotate API keys for the production environment"
  environmentRef: production
  partitionRef: AcmeCorp

assertions:
  - responseStatus: 201
  - statusIn: [pending, planning, awaiting_approval]
  - hasDebrief: true
```

### How playbooks work

1. The runner boots a Synth server + envoy in-process (same harness as scenario tests)
2. Creates entities from `setup` (environments, partitions, artifacts)
3. Maps `environmentRef`/`partitionRef`/`artifactRef` to created IDs
4. Calls `POST /api/operations` with the resolved operation
5. Evaluates assertions against the response and operation state

### Available assertions

| Assertion | What it checks |
|-----------|---------------|
| `responseStatus: 201` | HTTP status of the create-operation call |
| `statusIn: [pending, planning]` | Operation status is one of the listed values |
| `hasDebrief: true` | Operation has at least one debrief entry |
| `debriefMinEntries: 3` | Operation has at least N debrief entries |
| `errorContains: "not found"` | Response body contains the string |

### Writing a new playbook

1. Create `tests/playbooks/<type>-<slug>.yaml`
2. Follow the format above
3. Run `npm run exercise -- --type=<type>` to verify
4. It's automatically picked up by `npm run test:playbooks` and `npm run test:scenarios`

### Current coverage

All 6 operation types have playbooks: deploy (1), maintain (4), query (3), investigate (3), trigger (3), composite (2).

---

## Layer 3: Scenario & Fault-Injection Tests

Hand-written vitest tests for complex multi-step user journeys and failure modes.

```
tests/scenarios/
  harness.ts              # Boots server + envoy in-process, HTTP helpers
  smoke.test.ts           # Deploy happy path, multi-partition isolation, debrief queries
  fault-injection.test.ts # Envoy offline, concurrent deploys, invalid entities, drain/pause
  playbook.test.ts        # Dynamic: discovers all playbook YAMLs, creates a test per file
```

### Harness helpers

The harness at `tests/scenarios/harness.ts` provides helpers for all 6 operation types:

```typescript
import { createHarness, teardownHarness, maintain, queryOp, investigate,
         triggerOp, compositeOp, createOperation, getOperation, waitForStatus,
         seedStandardEntities } from "./harness.js";
```

---

## Layer 4: UI Component Tests

React Testing Library tests covering the operation authoring panel, debrief rendering, and theme compliance.

```
packages/ui/tests/
  DeploymentAuthoringPanel.test.tsx  # All 6 op types: field visibility, validation, preselection
  DebriefEntry.test.tsx              # All decision types, timeline, expand/collapse, badges
  theme-compliance.test.tsx          # CSS contract: status pills, dt-badges, entity colors, variables
  StatusBadge.test.tsx               # Status rendering
  EntityTag.test.tsx                 # Entity type colors
  ConfirmDialog.test.tsx             # Dialog interactions
  SectionHeader.test.tsx             # Section headers
  ErrorBoundary.test.tsx             # Error fallback
  api.test.ts                        # API client layer
```

---

## Layer 5: Autonomous CI Pipeline

The CI pipeline runs automatically on every push and on a schedule. No manual intervention needed.

### What runs on every push / PR

| Workflow | What | Cost |
|----------|------|------|
| **CI** (`ci.yml`) | Build → tests with coverage → integration tests → npm audit | Free |
| **CodeQL** (`codeql.yml`) | TypeScript SAST (injection, auth, crypto) | Free |
| **Claude Review** (`claude-review.yml`) | Diff analysis, playbook generation, targeted testing | Max subscription (OAuth) |

### What runs on a schedule

| Workflow | Schedule | What |
|----------|----------|------|
| **Watchdog** (`watchdog.yml`) | Mon + Thu 3am UTC | Full playbook suite + coverage + audit + Claude analysis → files issues |
| **CodeQL** (`codeql.yml`) | Wed 5am UTC | Deep security scan |
| **Dependabot** (`dependabot.yml`) | Weekly (Monday) | Dependency updates + vulnerability alerts |

### What Claude does in CI

**On PRs** (claude-review.yml):
- Reads the diff and checks correctness
- Checks for security issues
- Verifies UI changes against UI_PATTERNS.md
- Runs `npm test` and `npm run exercise`
- Generates playbook YAMLs for untested code paths
- Posts findings as PR review comments
- Responds to `@claude` mentions in PR/issue comments

**On schedule** (watchdog.yml):
- Runs all playbooks and tests
- Audits dependencies for vulnerabilities
- Analyzes recent commits for untested changes
- Generates targeted playbooks for coverage gaps
- Checks coverage hotspots (boundary-validator, operation-executor, approval flow)
- Files GitHub issues for findings (deduplicates against existing issues)

---

## Setup: OAuth Token for Claude CI

The Claude workflows use your Max subscription — no API key costs.

```bash
# Generate the token locally
claude setup-token

# Add to GitHub
# Repository → Settings → Secrets and variables → Actions → New repository secret
# Name:  CLAUDE_CODE_OAUTH_TOKEN
# Value: <the token from setup-token>
```

Dependabot and CodeQL require no secrets — they're GitHub-native.

---

## The `/exercise` Claude Skill

When working locally in Claude, use the `/exercise` skill for on-demand testing:

```
/exercise                          # Run all playbooks + unit tests
/exercise maintain                 # Filter by operation type
/exercise visual                   # Visual QA via preview tools (boots UI)
/exercise generate "check cert expiry on staging"  # Generate a new playbook from English
```

The skill uses the same playbook engine as CI, plus it can do visual QA via preview tools when running locally.

---

## The Feedback Loop

The system is designed to be self-reinforcing:

```
You write code
  → Push to GitHub
  → CI: tests + coverage + CodeQL + npm audit (catches regressions immediately)
  → Claude Review: analyzes diff, generates playbooks, comments on PR

Watchdog (Mon + Thu)
  → Runs everything: playbooks, tests, audit
  → Analyzes recent changes for untested paths
  → Files issues for findings
  → Playbook suite grows automatically

Dependabot (weekly)
  → Opens PRs for vulnerable dependencies
  → Claude reviews those PRs too

You fix issues
  → Push triggers the loop again
```

The test suite self-expands: the watchdog generates playbooks for untested code paths, commits them, and they become permanent fixtures in the suite.

---

## Adding Test Coverage for a New Feature

When you add a new feature:

1. **Playbook** — if it involves an operation type, add a YAML file to `tests/playbooks/`
2. **Component test** — if it touches UI, add assertions to the relevant test file in `packages/ui/tests/`
3. **Scenario test** — if it involves a multi-step flow or failure mode, add to `tests/scenarios/`
4. **Or let the watchdog do it** — push your code, and the watchdog will identify untested paths and generate playbooks on the next sweep

The goal is to make adding tests lower-friction than not adding them.
