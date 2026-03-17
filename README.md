<p align="center">
  <img src="website/public/favicon.svg" width="80" alt="Synth logo" />
</p>

<h1 align="center">Synth</h1>

<p align="center">
  <strong>Deployment intelligence, not deployment automation.</strong><br />
  You say what and where. Synth figures out the how.
</p>

<p align="center">
  <a href="https://synthdeploy.com/docs">Documentation</a> &middot;
  <a href="https://synthdeploy.com/pricing">Pricing</a> &middot;
  <a href="https://synthdeploy.com/roadmap">Roadmap</a>
</p>

---

Synth is an intelligent deployment system. The intelligence is the product — not a feature bolted on top. You provide what you're deploying and where. The system analyzes your artifacts, reasons about target systems, produces a deployment plan, and explains every decision before it touches a thing.

## How It Works

```
$ synth deploy web-app v2.4.1 --partition acme-corp

Agent: Analyzed web-app v2.4.1 — Node.js app, requires PostgreSQL and Redis
Agent: Planned 3-step pipeline for production

  [1] Install dependencies        ✓ 14.2s
  [2] Run migrations              ✓ 3.1s
  [3] Health check                ✓ 0.2s

Decision: Resolved 4 variables (1 conflict: APP_ENV — environment wins)
Deployment succeeded in 17.5s
```

1. **You declare intent** — artifact, version, target environment
2. **Synth reasons and plans** — analyzes the artifact, resolves variables, probes targets, generates steps (not from templates — from context)
3. **You review and approve** — every step is visible before execution, with dry-run observations showing what will change
4. **Envoy executes deterministically** — the approved plan runs exactly as shown, no re-reasoning
5. **Debrief explains everything** — every decision logged in plain language across 21 decision types

## Key Principles

- **Intelligence is the foundation.** Without an LLM connection, the tool gates honestly. There is no degraded "traditional mode."
- **Planning is intelligent. Execution is deterministic.** The agent reasons freely during planning (read-only, zero side effects). Once approved, execution runs exactly as planned.
- **No silent failures.** The system always leaves the environment in a known state with a plain-language explanation of what happened.
- **Full decision transparency.** The Debrief records actions, decisions, and the information that informed them. Engineers at 2am get specific, actionable explanations.

## Architecture

Synth runs as two lightweight services:

| Component | Role | Description |
|-----------|------|-------------|
| **Synth** (server) | The brain | Manages artifacts, partitions, environments. Runs the intelligent agent, REST API, and MCP server. |
| **Envoy** | The hands | Lightweight agent on target machines. Executes deployment steps via 5 handlers (file, process, config, container, verify). |

```
┌──────────────┐         ┌──────────────┐
│    Synth      │  HTTP   │    Envoy     │
│   (server)    │◄───────►│   (target)   │
│               │         │              │
│  LLM ◄──►    │         │  5 execution │
│  Agent        │         │  handlers    │
│  REST API     │         │              │
│  MCP Server   │         │              │
└──────────────┘         └──────────────┘
```

## Quick Start

### Docker Compose (recommended)

```bash
# Set your LLM API key
export SYNTH_LLM_API_KEY=your-api-key
export SYNTH_JWT_SECRET=$(openssl rand -hex 32)

# Start both services
docker compose up -d
```

Synth server is available at `http://localhost:3000`, Envoy at `http://localhost:3001`.

### From Source

Requires Node.js 22+.

```bash
git clone https://github.com/jmfullerton96/synth-deploy.git
cd synth-deploy
npm install
npm run build

# Start the server
SYNTH_LLM_API_KEY=your-api-key npm run dev

# In another terminal, start the envoy
npm run dev --workspace=packages/envoy
```

## Features

### Community (Free)

- Intelligent deployment planning
- Artifact analysis with LLM reasoning
- 5 execution handlers (file, process, config, container, verify)
- Full Debrief decision log
- Variable resolution with conflict detection
- Dry-run observations before execution
- REST API and MCP server
- Any LLM provider (Claude, GPT, Gemini, Ollama, etc.)
- Artifact annotations — operator corrections that improve future analysis
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
- **LLM Postmortems** — auto-generated postmortem analysis for failed deployments
- **MCP Servers** — register external MCP servers for tool integration
- **Co-Branding** — custom operator name, logo, and accent color
- **Telemetry Export** — export deployment telemetry to external systems
- **Configurable Retention** — custom debrief and history retention policies

Contact [licensing@synthdeploy.com](mailto:licensing@synthdeploy.com) for enterprise licensing.

### Pioneer Program

We're looking for engineering teams to run Synth in real environments and help shape the product. In exchange: full Enterprise access at no cost. Email [pioneers@synthdeploy.com](mailto:pioneers@synthdeploy.com).

## Configuration

Synth is configured via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNTH_LLM_API_KEY` | API key for your LLM provider | *required* |
| `SYNTH_LLM_PROVIDER` | LLM provider (`anthropic`, `openai`, `google`, `ollama`, etc.) | `anthropic` |
| `SYNTH_JWT_SECRET` | Secret for JWT token signing | *required* |
| `SYNTH_DATA_DIR` | Data directory for persistence | `./data` |
| `SYNTH_SERVER_URL` | Server URL (for envoy configuration) | `http://localhost:3000` |
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

**Community use** is free for deployments with up to 10 registered Envoy agents. **Production use** beyond 10 Envoys, or offering Synth as a managed service, requires a commercial license.

---

<p align="center">
  <a href="https://synthdeploy.com">synthdeploy.com</a>
</p>
