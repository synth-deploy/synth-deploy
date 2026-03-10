#!/usr/bin/env bash
# build.sh — generate uploadable test artifact files from sources
# Run from the tests/artifacts/ directory, or anywhere (uses script-relative paths)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCES="${SCRIPT_DIR}/sources"
OUT="${SCRIPT_DIR}/generated"

mkdir -p "${OUT}"

log() { echo "  → $*"; }
section() { echo; echo "[$*]"; }

# ── 1. Docker image tarball ───────────────────────────────────────────────────
section "nginx-app (Dockerfile → docker image tar)"
if command -v docker &>/dev/null; then
  log "Building image synth-test/nginx-app:1.0 from Dockerfile"
  # Create a minimal html dir so COPY succeeds
  mkdir -p "${SOURCES}/nginx-app/html"
  echo '<html><body>synth test</body></html>' > "${SOURCES}/nginx-app/html/index.html"
  docker build -t synth-test/nginx-app:1.0 "${SOURCES}/nginx-app" --quiet
  log "Saving to generated/nginx-app.tar"
  docker save synth-test/nginx-app:1.0 -o "${OUT}/nginx-app.tar"
  log "Done: $(du -sh "${OUT}/nginx-app.tar" | cut -f1)"
else
  log "SKIP: docker not found — copy a Dockerfile directly as artifact instead"
  cp "${SOURCES}/nginx-app/Dockerfile" "${OUT}/Dockerfile"
  log "Copied Dockerfile to generated/Dockerfile (upload this directly)"
fi

# ── 2. Helm chart tarball ─────────────────────────────────────────────────────
section "helm-chart (Chart.yaml → .tgz)"
if command -v helm &>/dev/null; then
  log "Packaging with helm package"
  helm package "${SOURCES}/helm-chart" --destination "${OUT}" --quiet
  log "Done: $(ls "${OUT}"/*.tgz | head -1 | xargs basename)"
else
  log "helm not found — creating tarball manually"
  tar -czf "${OUT}/synth-demo-app-0.1.0.tgz" -C "${SOURCES}" helm-chart
  log "Done: synth-demo-app-0.1.0.tgz"
fi

# ── 3. Node.js package tarball ────────────────────────────────────────────────
section "node-service (package.json → npm pack .tgz)"
if command -v npm &>/dev/null; then
  log "Running npm pack"
  # npm pack needs node_modules absent or present — just pack the source
  (cd "${SOURCES}/node-service" && npm pack --quiet --pack-destination "${OUT}" 2>/dev/null)
  log "Done: $(ls "${OUT}"/*.tgz | tail -1 | xargs basename)"
else
  log "SKIP: npm not found"
fi

# ── 4. Legacy deploy zip ──────────────────────────────────────────────────────
section "legacy-deploy (shell scripts → .zip)"
if command -v zip &>/dev/null; then
  log "Creating legacy-deploy.zip"
  (cd "${SOURCES}" && zip -r "${OUT}/legacy-deploy.zip" legacy-deploy/ -x "*.DS_Store" --quiet)
  log "Done: $(du -sh "${OUT}/legacy-deploy.zip" | cut -f1)"
else
  log "SKIP: zip not found"
fi

# ── 5. Synth's own Dockerfiles (dogfood) ─────────────────────────────────────
section "synth dogfood (Dockerfile.server + Dockerfile.envoy — copied directly)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cp "${REPO_ROOT}/Dockerfile.server" "${OUT}/Dockerfile.server"
cp "${REPO_ROOT}/Dockerfile.envoy" "${OUT}/Dockerfile.envoy"
log "Copied Dockerfile.server → generated/Dockerfile.server"
log "Copied Dockerfile.envoy → generated/Dockerfile.envoy"

echo
echo "Generated artifacts in ${OUT}:"
ls -lh "${OUT}/" | grep -v '^total'
echo
echo "Upload these files to Synth via the Artifact Catalog → New Artifact."
echo "For the Docker tar: target = local Docker (the envoy's ContainerHandler will handle it)."
echo "For the Helm chart: target = Kubernetes (note: k8s handler ships in v1.1 — good stress test of the planner)."
echo "For the Node package: target = a local process or Docker container."
echo "For the legacy zip: target = a Linux VM or local file path (ProcessHandler + FileHandler)."
echo "For Dockerfile.server / Dockerfile.envoy: upload directly — no build needed, analyzer reads content."
