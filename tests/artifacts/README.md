# Test Artifacts

Six artifacts covering the spectrum: container image, Helm chart, Node package, legacy zip with
shell scripts, and Synth's own server + envoy Dockerfiles (dogfood).

## Step 1 — Generate the artifacts

```bash
cd tests/artifacts
./build.sh
```

Artifacts are written to `generated/`. The directory is gitignored.

| Source | Generated file | Analyzer path |
|---|---|---|
| `sources/nginx-app/Dockerfile` | `nginx-app.tar` (19MB Docker image) | deterministic + LLM-enhanced |
| `sources/helm-chart/Chart.yaml` | `synth-demo-app-0.1.0.tgz` | deterministic + LLM-enhanced |
| `sources/node-service/package.json` | `synth-demo-api-2.1.0.tgz` | deterministic + LLM-enhanced |
| `sources/legacy-deploy/` | `legacy-deploy.zip` | composite → LLM-heavy |
| `Dockerfile.server` (repo root) | `Dockerfile.server` (copied) | deterministic + LLM-enhanced |
| `Dockerfile.envoy` (repo root) | `Dockerfile.envoy` (copied) | deterministic + LLM-enhanced |

---

## Step 2 — Configure `.env` for a clean run

Edit the root `.env` file. Three things must be set before starting:

```bash
# LLM key — the only thing you must provide. Everything else has a working default.
SYNTH_LLM_API_KEY=sk-ant-...

# Tells the UI dev server which origin the server accepts
SYNTH_CORS_ORIGIN=http://localhost:5173

# Skip demo seed data — you want a clean slate for real testing
SYNTH_SEED_DEMO=false
```

`SYNTH_JWT_SECRET` is no longer required — the server auto-generates one on first run and
stores it at `data/jwt-secret`. Set it explicitly only if you need reproducible sessions across
restarts (generally not needed for local testing).

---

## Step 3 — Wipe any existing data

The server and envoy both use SQLite databases. If you've run them before, old seed data is
still on disk. Delete it for a genuinely clean start:

```bash
# From repo root
rm -rf data/ .envoy/
```

This works because the integration testing section of `.env` pins both data directories to the
repo root via `SYNTH_DATA_DIR=data` and `ENVOY_BASE_DIR=.envoy`. Without those settings, npm
workspace scripts run from each package's own directory, putting data in
`packages/server/data/` and `packages/envoy/.envoy/` — which is hard to find and easy to miss
when wiping.

---

## Step 4 — Start everything (3 terminals)

**Terminal 1 — Server** (port 9410):
```bash
npm run dev
```
Reads `.env` automatically via `tsx --env-file`. Watch for:
```
[Synth] Server listening on http://0.0.0.0:9410
```
If you see `FATAL: SYNTH_JWT_SECRET is not set` — check Step 2.

**Terminal 2 — UI** (port 5173):
```bash
npm run dev:ui
```
Vite proxies `/api` and `/health` to `http://localhost:9410`. Open `http://localhost:5173`.

**Terminal 3 — Envoy** (port 9411):
```bash
SYNTH_SERVER_URL=http://localhost:9410 npm run dev --workspace=packages/envoy
```
The envoy reads `.env` via `tsx --env-file` but `SYNTH_SERVER_URL` in the shell takes
precedence. Watch for:
```
╔══════════════════════════════════════════════════════╗
║  Synth Envoy v0.1.0                                  ║
║  Health:  http://0.0.0.0:9411/health                 ║
╚══════════════════════════════════════════════════════╝
```

---

## Step 5 — Register the envoy in the UI

1. Open `http://localhost:5173`
2. Log in (first run: create an account — RBAC is seeded but auth is local)
3. Go to the **Topology** tab (or click the health pill in the header)
4. Click **+ Add Envoy** (top right)
5. Switch to the **Manual** tab
6. Name: `local`, URL: `http://localhost:9411`
7. Click **Connect** — the envoy status should show as healthy

---

## Step 6 — Run the core loop

1. Go to **Artifact Catalog** → **New Artifact**
2. Upload one of the files from `generated/`
3. Go to **Deployments** → **New Deployment**
4. Select the artifact, select the `local` envoy, set a target (for Docker: `nginx-app`, for
   file: a local directory path like `/tmp/synth-test`)
5. Click **Request Plan** — the planner reasons about the artifact and target
6. Review the plan. Read it critically: is it specific? Does it know about ports, env vars,
   sequencing? Or is it generic?
7. **Approve** → watch execution → open the **Debrief**
8. Read the debrief aloud. If it sounds like a briefing, you're ready to ship. If it sounds
   like a log dump, it needs work.

---

## What each artifact tests

**`nginx-app.tar`** — best first test. Docker image built from Dockerfile, deterministic
analysis extracts base image, ports, env vars. Execution: `docker run -d -p 80:80 nginx-app`.
After approve, `docker ps` should show the container running.

**`synth-demo-app-0.1.0.tgz`** (Helm chart) — k8s handler ships in v1.1, so the planner
cannot fully execute this. This is the best test of intelligent degradation: does the plan
explain what it *would* do and why it can't complete, or does it fail silently?

**`synth-demo-api-2.1.0.tgz`** (Node package) — `package.json` has `start`, `build`, and
`deploy` scripts plus explicit `node >=20` engine requirement. Tests whether the planner picks
up the deploy script and engine constraint.

**`legacy-deploy.zip`** — hardest case. The LLM has to read shell scripts to understand
intent. Tests planning quality on the most opaque artifact type. Good signal of whether the
planner is actually reasoning or pattern-matching.

**`Dockerfile.server` / `Dockerfile.envoy`** — dogfood. Multi-stage builds, npm workspace
structure, non-root user, volume mounts, health checks, and `SYNTH_SERVER_URL` dependency
between the two. The interesting question: does the planner notice that the envoy requires the
server to be running first and sequence them correctly?

---

## Failure case to try

After the nginx-app deploys successfully: stop the container mid-way through a second
deployment (`docker stop nginx-app` from another terminal while execution is in progress). Does
the envoy roll back? Does the debrief explain what happened and why? This is the "2am" test.
