#!/usr/bin/env bash
# deploy.sh — legacy deployment script for synth-demo-worker
# Usage: ./deploy.sh [version]
set -euo pipefail

VERSION="${1:-latest}"
APP_NAME="synth-demo-worker"
DEPLOY_DIR="/opt/${APP_NAME}"
BACKUP_DIR="/opt/${APP_NAME}-backup"
SERVICE_NAME="${APP_NAME}.service"
ARTIFACT_URL="${ARTIFACT_REPO_URL}/${APP_NAME}/${VERSION}/${APP_NAME}.tar.gz"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

log "Deploying ${APP_NAME} v${VERSION}"

# Pre-flight checks
if [[ -z "${ARTIFACT_REPO_URL:-}" ]]; then
  echo "ERROR: ARTIFACT_REPO_URL is not set" >&2
  exit 1
fi

if [[ -z "${DB_HOST:-}" ]]; then
  echo "ERROR: DB_HOST is not set" >&2
  exit 1
fi

# Stop service
log "Stopping ${SERVICE_NAME}"
systemctl stop "${SERVICE_NAME}" || true

# Backup current deployment
if [[ -d "${DEPLOY_DIR}" ]]; then
  log "Backing up current deployment to ${BACKUP_DIR}"
  rm -rf "${BACKUP_DIR}"
  cp -a "${DEPLOY_DIR}" "${BACKUP_DIR}"
fi

# Download and extract artifact
log "Downloading ${ARTIFACT_URL}"
mkdir -p "${DEPLOY_DIR}"
curl -fsSL "${ARTIFACT_URL}" | tar -xz -C "${DEPLOY_DIR}" --strip-components=1

# Apply configuration
log "Writing configuration"
cat > "${DEPLOY_DIR}/app.env" <<EOF
APP_ENV=${APP_ENV:-production}
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT:-5432}
DB_NAME=${DB_NAME:-worker}
QUEUE_URL=${QUEUE_URL:-amqp://localhost}
LOG_LEVEL=${LOG_LEVEL:-warn}
WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-4}
EOF

# Run database migrations
log "Running database migrations"
"${DEPLOY_DIR}/bin/migrate" up

# Start service
log "Starting ${SERVICE_NAME}"
systemctl start "${SERVICE_NAME}"

# Health check
log "Waiting for health check"
for i in $(seq 1 10); do
  if curl -sf "http://localhost:${HEALTH_PORT:-8080}/health" > /dev/null 2>&1; then
    log "Health check passed on attempt ${i}"
    log "Deployment complete: ${APP_NAME} v${VERSION}"
    exit 0
  fi
  sleep 3
done

log "ERROR: Health check failed after 10 attempts — rolling back"
./rollback.sh
exit 1
