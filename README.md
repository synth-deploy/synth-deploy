<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icons/dark/synth-icon-scalable.svg">
    <img src="assets/icons/light/synth-icon-scalable.svg" width="220" alt="Synth logo" />
  </picture>
</p>

<h1 align="center">Synth</h1>

<p align="center">
  <strong>Operations that reason.</strong><br />
  Intelligent planning. Human approval. Deterministic execution.
</p>

<p align="center">
  <a href="https://synthops.app/docs">Documentation</a> &middot;
  <a href="https://synthops.app/pricing">Pricing</a> &middot;
  <a href="https://synthops.app/roadmap">Roadmap</a>
</p>

---

Every operational tool in production today is, at its core, a script runner. It does what you told it to do when you wrote the script. When something unexpected happens — a service on a different port, a target in a different state than assumed, a conflict between what the runbook says and what the system actually is — it hands you an exit code and waits for you to figure it out.

Synth is built differently. The intelligence is the product, not a feature added on top. You describe an objective — deploy, investigate, maintain, query. Synth probes your actual infrastructure, reasons about what it finds, produces a plan, and explains every decision in plain language before it touches a thing.

## The Problem

Every deployment tool in production today is, at its core, a script runner. It does what you told it to do at the time you wrote the script. When things go wrong, it generates output like this:

| Your pipeline says | Synth's Debrief says |
|---|---|
| `Step 7: FAILED` | Health check timed out on service restart. The service log shows the process was still initializing — this is a timeout threshold issue, not an application failure. Suggested fix: increase health check wait time for this service type. |
| `Deployment: ROLLED BACK` | Partial failure on 1 of 5 targets. This is a database migration — stateful operations require full success across all nodes. Rolled back all 5. Rollback completed cleanly. No data loss. |
| `Variable conflict: prod-db-1` | Two conflicting values for DB_HOST. Used partition-level value (prod-db-1) over environment default (prod-db-2) per defined precedence rules. |

The Debrief is not a log. It is a record of decisions — what was decided, and why, in plain language an engineer can act on.

## How It Works

```
$ synth deploy payments-api v2.4.1 --env production

Agent: Analyzed payments-api v2.4.1 — Node.js container image, health at /health
Agent: Probed production — found running container v2.3.0 on port 3001
Agent: Detected 1 variable conflict: APP_ENV (environment wins over artifact default)
Agent: Planned 4-step deployment pipeline

  [1] Stop existing container       dry-run: will stop payments-api-v2.3.0
  [2] Deploy new container          dry-run: will start payments-api-v2.4.1 on port 3001
  [3] Run migrations                dry-run: 2 schema migrations pending
  [4] Health check                  dry-run: GET /health, expect 200

Approve? [y/n] y

  [1] Stop existing container     ✓  1.2s
  [2] Deploy new container        ✓  8.4s
  [3] Run migrations              ✓  3.1s
  [4] Health check                ✓  0.2s

Deployment succeeded in 12.9s
Debrief: 6 decisions logged
```

1. **You declare intent** — artifact, version, target environment
2. **Synth reasons and plans** — analyzes the artifact, probes the target, resolves variable conflicts, generates steps from context (not templates)
3. **You review and approve** — every step visible before execution, with dry-run observations
4. **Envoy executes deterministically** — the approved plan runs exactly as shown, no re-reasoning
5. **Debrief records everything** — every decision in plain language, queryable and auditable

## Operations

A deployment is one type of operation. Synth handles six:

| Type | Intent | Example |
|------|--------|---------|
| **Deploy** | Artifact → target environment | `Deploy payments-api v2.4.1 to production` |
| **Maintain** | Mutating work without an artifact | `Rotate TLS certificates on the web tier` |
| **Query** | Read-only infrastructure discovery | `What's the cert expiry status across prod?` |
| **Investigate** | Iterative diagnostic probing | `Something is slow on the API tier, investigate` |
| **Trigger** | Persistent monitoring directive | `When disk > 85%, run log-cleanup` |
| **Composite** | Multiple operation types in one plan | `Deploy v2.4, rotate API keys, run post-deploy verification` |

All six follow the same flow: analyze input → plan → approve → deterministic execution → Debrief. The intelligence that makes deployment planning valuable applies to every operation type.

## Architecture

Synth runs as two services:

| Component | Where it runs | Role |
|-----------|--------------|------|
| **Synth** (server) | Your infrastructure | LLM agent, REST API, MCP server, Debrief store |
| **Envoy** | Your target machines | Execution engine — 5 handlers: file, process, config, container, verify |

```
                  ┌───────────────────────────────────────┐
                  │              Synth Server              │
                  │                                       │
  Web UI     ────►│  REST API ──┐                        │
  MCP clients────►│  MCP Server ─┼──► LLM Agent          │
                  │             │         │               │
                  │             └─────────▼               │
                  │                   Debrief             │
                  └──────────────────────┬────────────────┘
                                         │ HTTP
                  ┌──────────────────────▼────────────────┐
                  │                  Envoy                 │
                  │         (on your infrastructure)       │
                  │                                       │
                  │  file · process · config              │
                  │  container · verify                   │
                  └───────────────────────────────────────┘
```

**Synth (server)** is the brain. It holds artifacts, operations, environments, and partitions. When an operation is triggered, the LLM agent reasons about what needs to happen — it does not run a pre-built template. Every decision is written to the Debrief.

**Envoy** is the hands. A lightweight agent installed on the machines where software actually runs. It executes the approved plan via five deterministic handlers and reports step-by-step results back to Synth. Planning is intelligent. Execution is not — by design.

**MCP-native from the foundation.** Synth exposes an MCP server alongside its REST API. Any MCP client (Claude Desktop, agent toolchains, custom scripts) can connect to Synth and orchestrate operations. Works with any LLM provider — Claude, GPT, Gemini, Ollama, or anything with an OpenAI-compatible endpoint.

## Quick Start

### Docker Compose (recommended)

```bash
export SYNTH_LLM_API_KEY=your-api-key
export SYNTH_JWT_SECRET=$(openssl rand -hex 32)

docker compose up -d
```

Synth server at `http://localhost:3000`, Envoy at `http://localhost:3001`.

### From Source

Requires Node.js 22+.

```bash
git clone https://github.com/synth-deploy/synth.git
cd synth-deploy
npm install && npm run build

# Start the server
SYNTH_LLM_API_KEY=your-api-key npm run dev

# In another terminal, start the envoy
npm run dev --workspace=packages/envoy
```

## Features

### Community (Free)

- Intelligent operation planning — all five operation types
- Artifact analysis with LLM reasoning
- 5 execution handlers (file, process, config, container, verify)
- Debrief — plain-language decision log across 21 decision types
- Variable resolution with conflict detection and precedence rules
- Dry-run observations before any execution
- REST API and MCP server
- Any LLM provider (Claude, GPT, Gemini, Ollama, and any OpenAI-compatible endpoint)
- Artifact annotations — operator corrections that improve future analysis
- Partitions — isolated configuration and history per team or customer
- Up to 10 registered Envoys

### Enterprise

Everything in Community, plus:

- **Unlimited Envoys** — scale beyond 10 registered agents
- **Fleet Deployments** — batched rollouts and canary strategies across envoy groups
- **Deployment Graphs** — multi-artifact dependency graphs with intelligent ordering
- **SSO** — OIDC, SAML, and LDAP authentication
- **Custom Roles** — granular permissions beyond the built-in roles
- **Multi-Provider LLM** — fallback chains across multiple LLM providers
- **Task Model Routing** — route different tasks to different models
- **LLM Postmortems** — auto-generated postmortem analysis for failed operations
- **External MCP Servers** — register third-party MCP servers as agent tools
- **Co-Branding** — custom operator name, logo, and accent color
- **Telemetry Export** — export operation telemetry to external systems
- **Configurable Retention** — custom Debrief and history retention policies

Contact [licensing@synthops.app](mailto:licensing@synthops.app) for enterprise licensing.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNTH_LLM_API_KEY` | API key for your LLM provider | *required* |
| `SYNTH_LLM_PROVIDER` | LLM provider (`anthropic`, `openai`, `google`, `ollama`, etc.) | `anthropic` |
| `SYNTH_JWT_SECRET` | Secret for JWT token signing | *required* |
| `SYNTH_DATA_DIR` | Data directory for persistence | `./data` |
| `SYNTH_SERVER_URL` | Server URL (for Envoy configuration) | `http://localhost:3000` |
| `SYNTH_LICENSE_KEY` | Base64-encoded enterprise license key | — |
| `SYNTH_LICENSE_FILE` | Path to license key file | `./synth.license` |

## Project Structure

```
packages/
  core/       Shared types, edition gating, utilities
  server/     Synth server — API, agent, MCP server
  envoy/      Envoy agent — execution handlers, reporting
  ui/         Web UI — canvas-based panel system
website/      Product website (Astro)
```

## License

Business Source License 1.1. See [LICENSE](LICENSE).

**Community use** is free for operations with up to 10 registered Envoy agents. **Production use** beyond 10 Envoys, or offering Synth as a managed service, requires a commercial license.

## Pioneer Program

We're looking for engineering teams running Synth in real environments. In exchange for feedback and real-world scenarios: full Enterprise access at no cost, and direct input into the roadmap.

Email [pioneers@synthops.app](mailto:pioneers@synthops.app).

---

<p align="center">
  <a href="https://synthops.app">synthops.app</a>
</p>
