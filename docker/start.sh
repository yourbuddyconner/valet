#!/bin/bash
set -e

export DISPLAY=:99
export HOME=/root

OPENCODE_PORT=4096
VSCODE_PORT=8765
VNC_PORT=6080
TTYD_PORT=7681
GATEWAY_PORT=9000

echo "[start.sh] Starting Valet sandbox"
echo "[start.sh] Session: ${SESSION_ID}"

# ─── VNC Stack ─────────────────────────────────────────────────────────

echo "[start.sh] Starting VNC stack (Xvfb + fluxbox + x11vnc + websockify)"
# Clean up stale lock/socket files from previous runs (e.g. after snapshot restore).
# After a filesystem snapshot restore, all processes are dead but their lock files persist.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
rm -f /root/.local/share/code-server/heartbeat /root/.local/share/code-server/*.sock
Xvfb :99 -screen 0 1920x1080x24 &
sleep 1
# Pre-create fluxbox init file to suppress "Failed to read" config spam on stderr
mkdir -p /root/.fluxbox
cat > /root/.fluxbox/init <<'FBEOF'
session.screen0.workspaces: 1
session.screen0.toolbar.visible: false
session.screen0.windowPlacement: RowSmartPlacement
session.screen0.focusModel: ClickFocus
FBEOF
fluxbox &
x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -quiet &
websockify --web /usr/share/novnc ${VNC_PORT} localhost:5900 &
echo "[start.sh] VNC accessible on port ${VNC_PORT}"

# ─── Git Configuration ─────────────────────────────────────────────────
# Git credentials and repo cloning are handled by the Runner process.
# start.sh only sets up the global gitignore.

# Global gitignore — prevent sandbox-injected dirs from being committed
cat > /root/.gitignore_global << 'GITIGNORE'
.valet/
.opencode/
GITIGNORE
git config --global core.excludesFile /root/.gitignore_global

# ─── Workspace Setup ─────────────────────────────────────────────────
# Repo cloning is handled by the Runner process. start.sh just sets up
# a minimal workspace directory and writes initial repo context if available.
WORK_DIR=/workspace

# Write minimal repo context so services starting before the Runner clones
# have some awareness of the target repo.
if [ -n "${REPO_URL:-}" ]; then
  mkdir -p "${WORK_DIR}/.valet/persona"
  {
    echo "# Repository Context"
    echo ""
    echo "- Repo URL: ${REPO_URL}"
    if [ -n "${REPO_BRANCH:-}" ]; then
      echo "- Branch: ${REPO_BRANCH}"
    fi
    echo ""
    echo "The Runner will clone the repo and update this context after startup."
  } > "${WORK_DIR}/.valet/persona/00-repo-context.md"
fi


# ─── code-server (VS Code) ────────────────────────────────────────────
# Started after clone so it opens the correct folder

echo "[start.sh] Starting code-server on port ${VSCODE_PORT} (folder: ${WORK_DIR})"
code-server \
  --bind-addr "127.0.0.1:${VSCODE_PORT}" \
  --auth none \
  --disable-telemetry \
  --disable-update-check \
  --welcome-text "Valet Workspace" \
  "${WORK_DIR}" &

# ─── TTYD (web terminal) ──────────────────────────────────────────────

echo "[start.sh] Starting TTYD on port ${TTYD_PORT}"
# Run TTYD with verbose output to debug
# -W: Writable (allow client input)
# -p: Port
# The command after -- is what runs in the terminal
ttyd -W -p ${TTYD_PORT} bash -c "cd ${WORK_DIR} && exec bash -l" 2>&1 &
TTYD_PID=$!
sleep 2
if ! kill -0 $TTYD_PID 2>/dev/null; then
  echo "[start.sh] ERROR: TTYD failed to start!"
  # Try to get any error output
  wait $TTYD_PID 2>&1 || true
else
  echo "[start.sh] TTYD started with PID ${TTYD_PID}"
  # Verify TTYD is listening
  if command -v ss &>/dev/null; then
    ss -tlnp | grep ":${TTYD_PORT}" || echo "[start.sh] WARNING: TTYD not listening on port ${TTYD_PORT}"
  fi
fi

# ─── Runner Process (manages OpenCode lifecycle) ─────────────────────
# The Runner now owns the full OpenCode lifecycle: writing config files,
# starting/stopping the process, and health-checking. It also connects
# to the SessionAgent DO via WebSocket, receives prompts, forwards them
# to OpenCode, and streams results back. It starts the auth gateway on
# GATEWAY_PORT (for VS Code/VNC/TTYD iframe JWT validation).

# Export workspace dir for Runner to use as OpenCode cwd
export WORK_DIR="${WORK_DIR}"

echo "[start.sh] Starting Runner (manages OpenCode lifecycle)"
echo "[start.sh] Ports: OpenCode=${OPENCODE_PORT} VSCode=${VSCODE_PORT} VNC=${VNC_PORT} TTYD=${TTYD_PORT} Gateway=${GATEWAY_PORT}"

cd /runner
exec bun run src/bin.ts \
  --opencode-url "http://localhost:${OPENCODE_PORT}" \
  --do-url "${DO_WS_URL}" \
  --runner-token "${RUNNER_TOKEN}" \
  --session-id "${SESSION_ID}" \
  --gateway-port "${GATEWAY_PORT}"
