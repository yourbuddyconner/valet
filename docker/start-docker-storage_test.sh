#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
# Exercise the production selection block with simulated kernel operations.
# No daemon, root user, or host mount is required for these cases.
awk '/^# ── Rootless dockerd/{capture=1} capture {print} /echo "valet: starting rootless dockerd/{exit}' \
  "$ROOT/start-docker.sh" > "$TMP/select.sh"
cat > "$TMP/bin/su" <<'MOCK'
#!/usr/bin/env bash
# The old probe could open the device even when execution failed.
if [[ "$5" == 'exec 3<>/dev/fuse' ]]; then exit 0; fi
exec /bin/sh -c "$5"
MOCK
cat > "$TMP/bin/unshare" <<'MOCK'
#!/usr/bin/env bash
shift 3
exec "$@"
MOCK
cat > "$TMP/bin/mount" <<'MOCK'
#!/usr/bin/env bash
exit "$OVERLAY_STATUS"
MOCK
cat > "$TMP/bin/fuse-overlayfs" <<'MOCK'
#!/usr/bin/env bash
if [ "$FUSE_MOUNT_STATUS" != 0 ]; then exit "$FUSE_MOUNT_STATUS"; fi
printf '#!/bin/sh\nexit %s\n' "$FUSE_EXEC_STATUS" > .ovlprobe/m/probe
chmod +x .ovlprobe/m/probe
MOCK
cat > "$TMP/bin/cp" <<'MOCK'
#!/usr/bin/env bash
# macOS stores this executable under /usr/bin.
if [ "$1" = /bin/true ]; then shift; exec /bin/cp /usr/bin/true "$@"; fi
exec /bin/cp "$@"
MOCK
cat > "$TMP/bin/umount" <<'MOCK'
#!/usr/bin/env bash
printf 'unmounted\n' >> "$UNMOUNT_LOG"
MOCK
chmod +x "$TMP/bin/"*
check() {
  local expected=$1
  export OVERLAY_STATUS=$2 FUSE_MOUNT_STATUS=$3 FUSE_EXEC_STATUS=$4
  export DATA_ROOT="$TMP/data" LOG="$TMP/daemon.log" UNMOUNT_LOG="$TMP/unmount.log"
  mkdir -p "$DATA_ROOT"
  : > "$UNMOUNT_LOG"
  local actual
  actual=$(PATH="$TMP/bin:$PATH" bash -c 'source "$1"; printf "%s" "$DRIVER"' bash "$TMP/select.sh")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: expected $expected, got $actual (overlay=$2 fuse-mount=$3 fuse-exec=$4)" >&2
    cat "$LOG" >&2
    exit 1
  fi
  if [ "$2" != 0 ] && [ "$3" = 0 ] && [ ! -s "$UNMOUNT_LOG" ]; then
    echo 'FAIL: mounted fuse probe was not unmounted' >&2
    exit 1
  fi
  [ ! -d "$DATA_ROOT/.ovlprobe" ] || { echo 'FAIL: probe files remain' >&2; exit 1; }
}
check overlay2 0 0 0
check fuse-overlayfs 1 0 0
check vfs 1 1 0
check vfs 1 0 22
echo 'Docker storage probe tests passed'
