#!/usr/bin/env bash
set -euo pipefail

# Synth Installer
# Installs the Synth server and/or Envoy (deployment agent)
# as system services on Linux (systemd) or macOS (launchd).

COMPONENT="all"
INSTALL_DIR="/opt/synth"
DATA_DIR="/var/lib/synth"
REPO_URL="https://github.com/jmfullerton96/synth-deploy.git"
USE_LOCAL=false
SERVER_PORT=9410
ENVOY_PORT=9411
SERVER_URL="http://localhost:${SERVER_PORT}"

# --- Helpers ---

info()  { printf '\033[1;34m[info]\033[0m  %s\n' "$1"; }
warn()  { printf '\033[1;33m[warn]\033[0m  %s\n' "$1"; }
error() { printf '\033[1;31m[error]\033[0m %s\n' "$1" >&2; }
fatal() { error "$1"; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [OPTIONS]

Install Synth services as system daemons.

Options:
  --component <name>   Which component to install: server, envoy, or all (default: all)
  --install-dir <path> Installation directory (default: /opt/synth)
  --data-dir <path>    Data directory for SQLite and artifacts (default: /var/lib/synth)
  --local              Use current directory as source instead of cloning
  --server-url <url>  Synth server URL for Envoy to connect to (default: http://localhost:9410)
  --help               Show this help message

Examples:
  $0                              # Install both services
  $0 --component server          # Install Synth server only
  $0 --component envoy            # Install Envoy only
  $0 --local --component all      # Install from local repo checkout
EOF
  exit 0
}

# --- Parse arguments ---

while [[ $# -gt 0 ]]; do
  case "$1" in
    --component)   COMPONENT="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --data-dir)    DATA_DIR="$2"; shift 2 ;;
    --local)       USE_LOCAL=true; shift ;;
    --server-url) SERVER_URL="$2"; shift 2 ;;
    --help)        usage ;;
    *) fatal "Unknown option: $1. Run $0 --help for usage." ;;
  esac
done

case "$COMPONENT" in
  server|envoy|all) ;;
  *) fatal "Invalid component '${COMPONENT}'. Must be server, envoy, or all." ;;
esac

# --- Check Node.js ---

check_node() {
  if ! command -v node &>/dev/null; then
    fatal "Node.js is not installed. Synth requires Node.js 22 or later.
Install it from https://nodejs.org/ or via your package manager:
  - macOS:  brew install node@22
  - Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  - Fedora: sudo dnf install nodejs22"
  fi

  local node_version
  node_version=$(node -v | sed 's/^v//')
  local major
  major=$(echo "$node_version" | cut -d. -f1)

  if [[ "$major" -lt 22 ]]; then
    fatal "Node.js ${node_version} is too old. Synth requires Node.js 22 or later.
Current: node ${node_version}
Run 'node -v' to confirm, then upgrade from https://nodejs.org/"
  fi

  info "Node.js ${node_version} detected (>= 22 required)"
}

# --- Build ---

build_project() {
  local src_dir="$1"

  info "Installing dependencies..."
  (cd "$src_dir" && npm ci)

  info "Building all packages..."
  (cd "$src_dir" && npm run build)
}

# --- Obtain source ---

obtain_source() {
  if $USE_LOCAL; then
    if [[ ! -f "package.json" ]]; then
      fatal "--local specified but no package.json found in current directory.
Run this script from the Synth repository root."
    fi
    SOURCE_DIR="$(pwd)"
    info "Using local source at ${SOURCE_DIR}"
  else
    SOURCE_DIR=$(mktemp -d)
    info "Cloning Synth into ${SOURCE_DIR}..."
    git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"
  fi
}

# --- Install files ---

install_files() {
  info "Installing to ${INSTALL_DIR}..."
  sudo mkdir -p "$INSTALL_DIR"
  sudo mkdir -p "$DATA_DIR"

  # Copy built artifacts and dependencies
  sudo cp -r "$SOURCE_DIR/package.json" "$INSTALL_DIR/"
  sudo cp -r "$SOURCE_DIR/package-lock.json" "$INSTALL_DIR/"
  sudo cp -r "$SOURCE_DIR/node_modules" "$INSTALL_DIR/"
  sudo mkdir -p "$INSTALL_DIR/packages"

  # Always need core
  sudo mkdir -p "$INSTALL_DIR/packages/core"
  sudo cp "$SOURCE_DIR/packages/core/package.json" "$INSTALL_DIR/packages/core/"
  sudo cp -r "$SOURCE_DIR/packages/core/dist" "$INSTALL_DIR/packages/core/"

  if [[ "$COMPONENT" == "server" || "$COMPONENT" == "all" ]]; then
    sudo mkdir -p "$INSTALL_DIR/packages/server"
    sudo cp "$SOURCE_DIR/packages/server/package.json" "$INSTALL_DIR/packages/server/"
    sudo cp -r "$SOURCE_DIR/packages/server/dist" "$INSTALL_DIR/packages/server/"

    sudo mkdir -p "$INSTALL_DIR/packages/ui"
    sudo cp "$SOURCE_DIR/packages/ui/package.json" "$INSTALL_DIR/packages/ui/"
    if [[ -d "$SOURCE_DIR/packages/ui/dist" ]]; then
      sudo cp -r "$SOURCE_DIR/packages/ui/dist" "$INSTALL_DIR/packages/ui/"
    fi
  fi

  if [[ "$COMPONENT" == "envoy" || "$COMPONENT" == "all" ]]; then
    sudo mkdir -p "$INSTALL_DIR/packages/envoy"
    sudo cp "$SOURCE_DIR/packages/envoy/package.json" "$INSTALL_DIR/packages/envoy/"
    sudo cp -r "$SOURCE_DIR/packages/envoy/dist" "$INSTALL_DIR/packages/envoy/"
  fi

  info "Files installed to ${INSTALL_DIR}"
}

# --- Linux: systemd ---

install_systemd_server() {
  info "Creating systemd unit for synth-server..."
  sudo tee /etc/systemd/system/synth-server.service >/dev/null <<UNIT
[Unit]
Description=Synth — orchestration server
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/env node packages/server/dist/index.js
Environment=NODE_ENV=production
Environment=SYNTH_DATA_DIR=${DATA_DIR}
Environment=PORT=${SERVER_PORT}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable synth-server
}

install_systemd_envoy() {
  info "Creating systemd unit for synth-envoy..."
  sudo tee /etc/systemd/system/synth-envoy.service >/dev/null <<UNIT
[Unit]
Description=Synth Envoy — deployment agent
After=network.target
$(if [[ "$COMPONENT" == "all" ]]; then echo "After=synth-server.service"; fi)

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/env node packages/envoy/dist/index.js
Environment=NODE_ENV=production
Environment=ENVOY_PORT=${ENVOY_PORT}
Environment=SYNTH_SERVER_URL=${SERVER_URL}
Environment=ENVOY_BASE_DIR=${DATA_DIR}/envoy-workspace
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable synth-envoy
}

# --- macOS: launchd ---

install_launchd_server() {
  local plist_path="$HOME/Library/LaunchAgents/com.synthdeploy.server.plist"
  info "Creating launchd plist for synth-server..."
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.synthdeploy.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>${INSTALL_DIR}/packages/server/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>SYNTH_DATA_DIR</key>
    <string>${DATA_DIR}</string>
    <key>PORT</key>
    <string>${SERVER_PORT}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DATA_DIR}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${DATA_DIR}/server.err</string>
</dict>
</plist>
PLIST
}

install_launchd_envoy() {
  local plist_path="$HOME/Library/LaunchAgents/com.synthdeploy.envoy.plist"
  info "Creating launchd plist for synth-envoy..."
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.synthdeploy.envoy</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>${INSTALL_DIR}/packages/envoy/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${INSTALL_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>ENVOY_PORT</key>
    <string>${ENVOY_PORT}</string>
    <key>SYNTH_SERVER_URL</key>
    <string>${SERVER_URL}</string>
    <key>ENVOY_BASE_DIR</key>
    <string>${DATA_DIR}/envoy-workspace</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DATA_DIR}/envoy.log</string>
  <key>StandardErrorPath</key>
  <string>${DATA_DIR}/envoy.err</string>
</dict>
</plist>
PLIST
}

# --- Print post-install instructions ---

print_instructions_linux() {
  echo ""
  echo "================================================================"
  echo "  Synth installed successfully"
  echo "================================================================"
  echo ""
  echo "  Install dir: ${INSTALL_DIR}"
  echo "  Data dir:    ${DATA_DIR}"
  echo ""

  if [[ "$COMPONENT" == "server" || "$COMPONENT" == "all" ]]; then
    echo "  Synth Server (port ${SERVER_PORT}):"
    echo "    Start:   sudo systemctl start synth-server"
    echo "    Stop:    sudo systemctl stop synth-server"
    echo "    Status:  sudo systemctl status synth-server"
    echo "    Logs:    journalctl -u synth-server -f"
    echo ""
  fi

  if [[ "$COMPONENT" == "envoy" || "$COMPONENT" == "all" ]]; then
    echo "  Envoy (port ${ENVOY_PORT}):"
    echo "    Start:   sudo systemctl start synth-envoy"
    echo "    Stop:    sudo systemctl stop synth-envoy"
    echo "    Status:  sudo systemctl status synth-envoy"
    echo "    Logs:    journalctl -u synth-envoy -f"
    echo ""
  fi

  echo "================================================================"
}

print_instructions_macos() {
  echo ""
  echo "================================================================"
  echo "  Synth installed successfully"
  echo "================================================================"
  echo ""
  echo "  Install dir: ${INSTALL_DIR}"
  echo "  Data dir:    ${DATA_DIR}"
  echo ""

  if [[ "$COMPONENT" == "server" || "$COMPONENT" == "all" ]]; then
    echo "  Synth Server (port ${SERVER_PORT}):"
    echo "    Start:   launchctl load ~/Library/LaunchAgents/com.synthdeploy.server.plist"
    echo "    Stop:    launchctl unload ~/Library/LaunchAgents/com.synthdeploy.server.plist"
    echo "    Logs:    tail -f ${DATA_DIR}/server.log"
    echo "    Errors:  tail -f ${DATA_DIR}/server.err"
    echo ""
  fi

  if [[ "$COMPONENT" == "envoy" || "$COMPONENT" == "all" ]]; then
    echo "  Envoy (port ${ENVOY_PORT}):"
    echo "    Start:   launchctl load ~/Library/LaunchAgents/com.synthdeploy.envoy.plist"
    echo "    Stop:    launchctl unload ~/Library/LaunchAgents/com.synthdeploy.envoy.plist"
    echo "    Logs:    tail -f ${DATA_DIR}/envoy.log"
    echo "    Errors:  tail -f ${DATA_DIR}/envoy.err"
    echo ""
  fi

  echo "================================================================"
}

# --- Main ---

main() {
  info "Synth Installer"
  info "Component: ${COMPONENT}"

  check_node
  obtain_source
  build_project "$SOURCE_DIR"
  install_files

  local os
  os="$(uname -s)"

  case "$os" in
    Linux)
      if [[ "$COMPONENT" == "server" || "$COMPONENT" == "all" ]]; then
        install_systemd_server
      fi
      if [[ "$COMPONENT" == "envoy" || "$COMPONENT" == "all" ]]; then
        install_systemd_envoy
      fi
      print_instructions_linux
      ;;
    Darwin)
      if [[ "$COMPONENT" == "server" || "$COMPONENT" == "all" ]]; then
        install_launchd_server
      fi
      if [[ "$COMPONENT" == "envoy" || "$COMPONENT" == "all" ]]; then
        install_launchd_envoy
      fi
      print_instructions_macos
      ;;
    *)
      warn "Unsupported OS: ${os}. Files installed to ${INSTALL_DIR} but no service manager configured."
      echo ""
      echo "Manual start commands:"
      if [[ "$COMPONENT" == "server" || "$COMPONENT" == "all" ]]; then
        echo "  Synth:  SYNTH_DATA_DIR=${DATA_DIR} node ${INSTALL_DIR}/packages/server/dist/index.js"
      fi
      if [[ "$COMPONENT" == "envoy" || "$COMPONENT" == "all" ]]; then
        echo "  Envoy:  SYNTH_SERVER_URL=${SERVER_URL} node ${INSTALL_DIR}/packages/envoy/dist/index.js"
      fi
      ;;
  esac

  # Clean up temp dir if we cloned
  if ! $USE_LOCAL && [[ -n "${SOURCE_DIR:-}" ]]; then
    rm -rf "$SOURCE_DIR"
  fi
}

main
