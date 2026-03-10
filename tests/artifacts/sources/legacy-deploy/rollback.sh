#!/usr/bin/env bash
# rollback.sh — restore previous deployment of synth-demo-worker
set -euo pipefail

APP_NAME="synth-demo-worker"
DEPLOY_DIR="/opt/${APP_NAME}"
BACKUP_DIR="/opt/${APP_NAME}-backup"
SERVICE_NAME="${APP_NAME}.service"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [[ ! -d "${BACKUP_DIR}" ]]; then
  echo "ERROR: No backup found at ${BACKUP_DIR} — cannot rollback" >&2
  exit 1
fi

log "Rolling back ${APP_NAME} to previous version"
systemctl stop "${SERVICE_NAME}" || true
rm -rf "${DEPLOY_DIR}"
cp -a "${BACKUP_DIR}" "${DEPLOY_DIR}"
systemctl start "${SERVICE_NAME}"

log "Rollback complete"
