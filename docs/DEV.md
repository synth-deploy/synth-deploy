# Synth — Dev Guide

## Prerequisites

- Node.js 22+
- npm (comes with Node)

## Install

```bash
npm install
```

## Run

**Server only** (port 9410):
```bash
npm run dev
```

**UI dev server** (port 5173, proxies API to 9410):
```bash
npm run dev:ui
```

Both must be running for the full UI experience. Start the server first.

**Production-like** (server serves built UI):
```bash
npm run build:ui
npm run dev
# Open http://localhost:9410
```

## Test

**All tests** (server + envoy):
```bash
npm test
```

**Server only:**
```bash
npm test --workspace=packages/server
```

**Envoy only:**
```bash
npm test --workspace=packages/envoy
```

## Build

**Everything:**
```bash
npm run build
```

**Core only** (needed when adding/changing types):
```bash
npx tsc --project packages/core/tsconfig.json
```

**UI only:**
```bash
npm run build:ui
```

**Type-check server without emitting:**
```bash
npx tsc --project packages/server/tsconfig.json --noEmit
```

## Clean

```bash
npm run clean
```

## Project Structure

```
packages/
  core/       Shared types, Decision Diary, partition isolation, stores
  server/     Fastify server, REST API, MCP, Server Agent
  envoy/      Local deployment agent, diagnostics, query engine
  ui/         React SPA (Vite)
```

## Seed Data

The server boots with demo data:
- 1 operation (web-app)
- 1 partition (Acme Corp)
- 2 environments (production, staging)

IDs are printed to the console on startup.

## Key URLs (dev)

| URL | What |
|-----|------|
| `http://localhost:5173` | UI (Vite dev server) |
| `http://localhost:9410/api/operations` | Operations API |
| `http://localhost:9410/api/partitions` | Partitions API |
| `http://localhost:9410/api/environments` | Environments API |
| `http://localhost:9410/api/deployments` | Deployments API |
| `http://localhost:9410/api/diary?limit=10` | Recent diary entries |
| `http://localhost:9410/health` | Server health check |
| `http://localhost:9410/mcp` | MCP endpoint |

## Gotcha: Stale dist/

If you add or rename files in `packages/core/src/`, rebuild core before running tests:

```bash
npx tsc --project packages/core/tsconfig.json
```

The vitest alias resolves source directly, but sub-module `.js` imports may pick up stale `dist/` files.
