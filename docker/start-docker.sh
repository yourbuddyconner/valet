#!/usr/bin/env bash
# Launches Docker for a docker-enabled sandbox. A second call while the
# daemon runs is a no-op. Daemon readiness failures do not stop startup.
# Unsafe or incomplete cgroup delegation stops Kubernetes sandbox startup.
# If Docker commands fail, read /var/log/valet/dockerd.log in the sandbox.
#
# Invokes rootlesskit DIRECTLY instead of dockerd-rootless.sh: the wrapper
# forces --detach-netns, and its detached-netns setup runs
# `sysctl net.ipv4.ip_forward=1` through /proc/sys — which is read-only when
# the pod's /proc is masked (any cluster that drops `procMount: Unmasked`,
# e.g. EKS <= 1.32 where the ProcMountType gate is off). Without
# --detach-netns rootlesskit configures the netns itself and the daemon
# starts on masked-proc clusters too. See
# docs/specs/2026-08-15-sandbox-docker-design.md, "Kubernetes reality".
set -u
if [ "${VALET_SANDBOX_DOCKER:-0}" != "1" ]; then exit 0; fi
# On Kubernetes userns pods, reject insufficient outer maps before dockerd
# starts. Local Docker has no outer pod user namespace and skips this guard.
/userns-preflight.sh || exit $?
# XDG_RUNTIME_DIR must be outside /run: rootlesskit's --copy-up=/run makes
# bind-mount paths under /run invisible across the user-namespace boundary,
# which breaks the port-driver API socket.
RUNTIME_DIR=/tmp/valet-docker
SOCK="$RUNTIME_DIR/docker.sock"
LOG=/var/log/valet/dockerd.log
DATA_ROOT=/home/dockerd/.local/share/docker
mkdir -p "$RUNTIME_DIR" /var/log/valet "$DATA_ROOT"
chown -R dockerd:dockerd "$RUNTIME_DIR" "$DATA_ROOT"
touch "$LOG"
chown dockerd:dockerd "$LOG"
# Make the workspace writable by the workload user. Non-recursive on
# purpose: at first start the mount is empty or freshly cloned by prep
# running as dockerd; a recursive chown of a large repo would be slow.
chown dockerd:dockerd /workspace 2>/dev/null || true
if [ -S "$SOCK" ] && su -s /bin/sh dockerd -c "DOCKER_HOST=unix://'$SOCK' docker version" >/dev/null 2>&1; then
  exit 0
fi

# ── Rootful dockerd inside the pod user namespace (kubernetes) ──────────
# The manifest sets VALET_DOCKER_USERNS=1 when the pod runs with
# hostUsers: false. The pod IS a user namespace: in-container root is an
# unprivileged host uid holding a full capability set over namespaced
# resources, so rootlesskit would only nest a second userns inside it —
# and the nested userns holds no NET_ADMIN over the pod netns (forcing
# slirp4netns + /dev/net/tun) and no clean device path (hostPath char
# devices cannot be idmap-mounted). Instead: run dockerd directly as
# in-container root. Bridge networking and overlayfs work natively.
# The workload keeps running as the `dockerd` user (#255); it reaches the
# daemon through the group-owned socket (`--group docker`, mode 660).
if [ "${VALET_DOCKER_USERNS:-0}" = "1" ]; then
  ROOT_SOCK=/var/run/docker.sock
  # Probe as the workload user through the group socket — validates the
  # root:docker 660 access path (#255), not just daemon liveness.
  if [ -S "$ROOT_SOCK" ] && su -s /bin/sh dockerd -c 'docker version' >/dev/null 2>&1; then
    exit 0
  fi
  if [ "${VALET_CGROUP_BOOTSTRAPPED:-0}" != "1" ]; then
    /cgroup-bootstrap.sh || exit $?
  fi
  # overlay2 on the emptyDir data-root; vfs only if the probe fails
  # (nothing in a 6.3+ userns kernel should make it fail — belt and
  # suspenders, not an expected path).
  DRIVER=vfs
  if /bin/sh -c "cd '$DATA_ROOT' && rm -rf .ovlprobe && mkdir -p .ovlprobe/l .ovlprobe/u .ovlprobe/w .ovlprobe/m && mount -t overlay overlay -olowerdir=.ovlprobe/l,upperdir=.ovlprobe/u,workdir=.ovlprobe/w .ovlprobe/m && umount .ovlprobe/m" >>"$LOG" 2>&1; then
    DRIVER=overlay2
  fi
  rm -rf "$DATA_ROOT/.ovlprobe" 2>/dev/null || true
  echo "valet: starting rootful-in-userns dockerd with storage driver: $DRIVER" >> "$LOG"
  nohup dockerd \
    --group docker \
    --storage-driver="$DRIVER" \
    --host="unix://$ROOT_SOCK" \
    --data-root="$DATA_ROOT" \
    >> "$LOG" 2>&1 &
  # Wait for daemon-READY, not socket-exists: dockerd creates the socket
  # file before it accepts connections. Probe as the workload user so
  # readiness also proves the group-660 access path. A timeout is logged,
  # but does not fail startup. Only unsafe cgroup delegation fails closed.
  for _ in $(seq 1 40); do
    [ -S "$ROOT_SOCK" ] && su -s /bin/sh dockerd -c 'docker version' >/dev/null 2>&1 && break
    sleep 0.5
  done
  if ! su -s /bin/sh dockerd -c 'docker version' >/dev/null 2>&1; then
    echo "valet: rootful dockerd not ready after 20s — daemon output above; docker commands will fail until it recovers" >> "$LOG"
  fi
  exit 0
fi

# ── Rootless dockerd via rootlesskit (docker local-dev backend) ─────────
# Storage driver: probe what this environment supports, best first.
#  - overlay2: native kernel overlayfs inside the rootless user namespace
#    (kernel >= 5.11). Needs the data-root on a non-overlay filesystem —
#    true on kubernetes (emptyDir volume), false on the docker backend
#    (container rootfs IS overlay, mount returns EINVAL).
#  - fuse-overlayfs: must mount and execute a binary in the rootless user
#    namespace. Some Docker Desktop kernels permit the mount but reject
#    execution with EINVAL. Opening /dev/fuse alone does not prove support.
#  - vfs: always works; slow, no layer sharing. Last resort.
DRIVER=vfs
if su -s /bin/sh dockerd -c "unshare --user --map-root-user --mount /bin/sh -c 'cd $DATA_ROOT && rm -rf .ovlprobe && mkdir -p .ovlprobe/l .ovlprobe/u .ovlprobe/w .ovlprobe/m && mount -t overlay overlay -olowerdir=.ovlprobe/l,upperdir=.ovlprobe/u,workdir=.ovlprobe/w .ovlprobe/m'" >>"$LOG" 2>&1; then
  DRIVER=overlay2
elif su -s /bin/sh dockerd -c "unshare --user --map-root-user --mount /bin/sh -c '
  cd $DATA_ROOT || exit 1
  rm -rf .ovlprobe && mkdir -p .ovlprobe/l .ovlprobe/u .ovlprobe/w .ovlprobe/m || exit 1
  cp /bin/true .ovlprobe/l/probe || exit 1
  fuse-overlayfs -o lowerdir=.ovlprobe/l,upperdir=.ovlprobe/u,workdir=.ovlprobe/w .ovlprobe/m || exit 1
  trap \"umount .ovlprobe/m\" EXIT
  .ovlprobe/m/probe
'" >>"$LOG" 2>&1; then
  DRIVER=fuse-overlayfs
fi
su -s /bin/sh dockerd -c "rm -rf '$DATA_ROOT/.ovlprobe'" 2>/dev/null || true
echo "valet: starting rootless dockerd with storage driver: $DRIVER" >> "$LOG"

su -s /bin/bash dockerd -c \
  "XDG_RUNTIME_DIR='$RUNTIME_DIR' HOME=/home/dockerd PATH=/usr/bin:/usr/sbin:/usr/local/bin \
   nohup rootlesskit \
     --state-dir='$RUNTIME_DIR/rootlesskit' \
     --net=slirp4netns --mtu=65520 \
     --slirp4netns-sandbox=auto --slirp4netns-seccomp=auto \
     --disable-host-loopback --port-driver=builtin \
     --copy-up=/etc --copy-up=/run --propagation=rslave \
     dockerd --storage-driver=$DRIVER --host=unix://'$SOCK' --data-root='$DATA_ROOT' \
     >> '$LOG' 2>&1 &" || true
# Poll until the daemon socket appears (up to ~10s) before creating the symlink.
# If the daemon fails to start, skip the symlink — callers can read $LOG.
for _ in $(seq 1 20); do
  [ -S "$SOCK" ] && break
  sleep 0.5
done
if [ -S "$SOCK" ]; then
  ln -sf "$SOCK" /var/run/docker.sock
fi
exit 0
