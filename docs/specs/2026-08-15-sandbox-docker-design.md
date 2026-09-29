# Sandbox Docker Support (rootless DinD) — Design

Date: 2026-08-15
Status: implemented (feat/sandbox-docker)
Superseded in part: image selection. Sandboxes now boot ONE image lineage
(the full image, docker toolchain always present) — see
`2026-08-16-single-image-lineage-design.md`. The capability grants, exec
identity, and start-script behavior below are unchanged.

## Problem

Sandboxes cannot run docker commands. Workloads that need a docker
daemon — testcontainers suites, image builds, docker-compose stacks,
and valet's own docker-gated e2e suites — fail inside a sandbox. This
blocks valet-on-valet development and any user repo whose tests need
docker.

## Decisions

1. **Audience:** any user workload. This is a platform capability, not
   a dev-only escape hatch. The design must hold for untrusted agent
   code.
2. **Isolation floor: rootless, with minimal capability grants.**
   The daemon runs as a non-root user inside the sandbox container.
   No `--privileged`, no host `docker.sock` mount. On both providers
   the opted-in sandbox receives exactly: CAP_SYS_ADMIN and
   CAP_NET_ADMIN, devices `/dev/fuse` and `/dev/net/tun`, seccomp
   unconfined, AppArmor unconfined, and unmasked system paths
   (`--security-opt systempaths=unconfined` on docker;
   `procMount: Unmasked` on kubernetes). These grants are empirically
   required: `newuidmap` must write to `uid_map` (needs SYS_ADMIN
   and unmasked `/proc/self/uid_map`), and rootlesskit must set
   `net.ipv4.ip_forward` in its netns via sysctl (needs NET_ADMIN
   and unmasked `/proc/sys`). All other capabilities remain dropped.
   This extends the rootless-BuildKit posture that the prebuild
   pipeline already uses in production (see
   `2026-08-02-sandbox-reconcile-design.md`, decision 4).
3. **Opt-in, two switches:** a `docker: true` key in
   `.valet/prebuild.yaml`, or a `docker` option at session create.
   Either one enables it. Sandboxes without the flag pay only image
   size — the daemon does not start.
4. **Placement: in-sandbox daemon, not a sidecar.** One container, one
   lifecycle, the same shape on both providers. A rootless
   `docker:dind-rootless` sidecar was rejected: the docker backend has
   no pod concept, so a sidecar forces paired-container lifecycle
   management for no isolation gain. Sysbox was rejected: it needs a
   runtime install on every node and does not work on Docker Desktop.
5. **Acceptance bar:** valet's own docker-gated e2e suites
   (`sandbox-docker`, `store-postgres` real-PG, `prebuilds-docker`)
   pass inside a `docker: true` sandbox. This implies build, run,
   volumes, networks, and port publishing work.

## Opt-in flow

The flag rides the same path as `profile`:

1. `.valet/prebuild.yaml` gains an optional top-level `docker: boolean`
   key. `loadPrebuildOverride` (`packages/api/src/prebuilds/recipe.ts`)
   parses and validates it. The prebuild identity hash does NOT include
   the key, so existing bakes do not churn.
2. The session-create API gains an optional `docker: boolean`. Session
   meta assembly (`packages/api/src/engine/session-meta.ts`) stores it.
   The `task` built-in carries the same optional `docker` (and `profile`)
   parameters, so an orchestrator can spawn a docker-enabled child: the
   spawner threads them into the child build and persists them on the
   child's `agent_sessions` row, which keeps a post-restart rebuild
   (through the generic `sessionFor`) on the same sandbox shape.
3. `EngineHost.provisionSandbox` (`packages/api/src/engine/host.ts`)
   resolves `docker = sessionMeta.docker || repoConfig.docker` and sets
   it on `SandboxCreateOpts`.
4. `SandboxCreateOpts` (`packages/engine/src/types.ts`) gains
   `docker?: boolean`. `SandboxCapabilities` gains
   `dockerSupport: boolean`. Providers that cannot honor the flag
   (sandbox-local, virtual) report `dockerSupport: false` and ignore
   it.
5. Providers that honor the flag set `VALET_SANDBOX_DOCKER=1` in the
   container env. The start scripts key off that env var.

## Sandbox image changes

`docker/Dockerfile.sandbox-k8s` (both profiles) bakes the rootless
toolchain, dormant by default:

- `docker-ce-cli`, `dockerd`, `dockerd-rootless.sh` + `rootlesskit`,
  `fuse-overlayfs`, `slirp4netns`, `iproute2`. All pinned; bump
  deliberately (same policy as `CODE_SERVER_VERSION` / `GH_VERSION`).
- A dedicated `dockerd` user with `/etc/subuid` and `/etc/subgid`
  ranges baked in. Rootless dockerd requires user-namespace remapping;
  the agent process stays container-root and is unaffected.
- `docker/start-docker.sh`: launches `dockerd-rootless.sh` as the
  `dockerd` user. Socket at `/tmp/valet-docker/docker.sock`
  (`XDG_RUNTIME_DIR` must be outside `/run`: rootlesskit's
  `--copy-up=/run` hides bind-mount paths under `/run` across the
  user-namespace boundary). After the socket appears, the script
  symlinks `/var/run/docker.sock` to it, so root-run docker CLIs need
  no `DOCKER_HOST`. Data-root at
  `/home/dockerd/.local/share/docker`. Daemon log at
  `/var/log/valet/dockerd.log`.
- `start-full.sh` starts `start-docker.sh` when
  `VALET_SANDBOX_DOCKER=1`. For the headless profile, whose command is
  `tail -f /dev/null` today, providers substitute a wrapper command
  (`/start-headless.sh`) that starts `start-docker.sh` when the env
  var is set, then execs the tail. If the daemon fails to start, the
  sandbox still comes up; `docker` commands fail with the daemon's log
  available at a fixed path named in the error.

Cost when disabled: image size only (~150–200 MB). Prebuilt bakes
inherit the toolchain via `FROM`.

## Provider wiring

### sandbox-docker

When `opts.docker`, `buildDockerRunArgs`
(`packages/sandbox-docker/src/sandbox.ts`) adds, in this order:

```
--security-opt seccomp=unconfined
--security-opt apparmor=unconfined
--security-opt systempaths=unconfined
--cap-add SYS_ADMIN
--cap-add NET_ADMIN
--device /dev/fuse
--device /dev/net/tun
--env VALET_SANDBOX_DOCKER=1
```

`systempaths=unconfined` unmasks `/proc/sys` so rootlesskit can set
`net.ipv4.ip_forward` in its netns. Never `--privileged`.

The provider also adapts the shared sandbox memory contract at this boundary.
`SandboxResources.memory` is a positive Kubernetes quantity. The provider
converts it to a decimal byte count for `docker run --memory`. The desired spec
and applied metadata keep the configured quantity string unchanged.

### sandbox-kubernetes

`ContainerSecurityContext`
(`packages/sandbox-kubernetes/src/types.ts`) gains
`capabilities?: { add: string[] }` and
`procMount?: "Unmasked" | "Default"`. When `opts.docker`, the
manifest builder (`packages/sandbox-kubernetes/src/manifest.ts`) adds:

- pod annotation
  `container.apparmor.security.beta.kubernetes.io/<container>: unconfined`
- container `securityContext`:
  `{ seccompProfile: { type: "Unconfined" }, capabilities: { add: ["SYS_ADMIN", "NET_ADMIN"] }, procMount: "Unmasked" }`
- an `emptyDir` volume for docker state
- `VALET_SANDBOX_DOCKER=1` and `VALET_DOCKER_USERNS=1` in the container env

Note: `procMount: Unmasked` requires the ProcMountType feature gate.
Where that gate is unavailable, the k8s DinD path does not converge.
This is checked at acceptance.

**Rootful-inside-the-userns (revision, 2026-08-17).** The first 1.33
deployment (EKS, kernel 6.12) showed hostPath char devices cannot be
idmap-mounted into a `hostUsers: false` pod — devtmpfs has no idmap
support, so runc fails container init with `MOUNT_ATTR_IDMAP EINVAL`
before a log line is written. Rather than delivering `/dev/fuse` and
`/dev/net/tun` through a device plugin, the k8s path drops rootlesskit:
the pod IS a user namespace, and in-container root holds the full
capability set over pod-owned namespaces, so `start-docker.sh`
(`VALET_DOCKER_USERNS=1` branch) runs dockerd directly as in-container
root. Consequences:

- No `/dev/net/tun`, no slirp4netns: the pod userns owns the pod netns,
  so dockerd's bridge/veth/iptables work natively (and faster).
- No `/dev/fuse`, no fuse-overlayfs: overlayfs mounts natively inside a
  userns on kernel >= 5.11; the probe keeps vfs as a paranoid fallback.
- Exec identity unchanged: the workload still runs as `dockerd` (1500);
  it reaches the daemon through the socket, `root:docker` mode 660
  (`--group docker`; the group comes from the docker-ce package).
- rootlesskit remains the docker (local dev) backend path, where no
  outer userns exists and it does real work. The sub-id ranges in the
  image only matter on that path now.
- A nested-userns rootlesskit cannot hold NET_ADMIN over the pod netns
  (capabilities do not extend to ancestor-owned namespaces) — which is
  why "rootlesskit with --net=host" was not an option and slirp existed
  in the first place.
- cgroup v2 delegation (two layers, both required). Kubelet mounts
  `/sys/fs/cgroup` read-only AND the pod cgroup directory is owned by
  host root, which is unmapped in the pod userns — so runc inside the
  sandbox cannot create per-container groups (`mkdir
  /sys/fs/cgroup/docker: read-only file system`, or EACCES after a rw
  remount; observed live on EKS 1.33, containerd issue #12182).
  - Ownership: the cluster must run the sandbox under a RuntimeClass
    whose containerd runtime sets `cgroup_writable = true` (containerd
    >= 2.1, systemd cgroup driver) — that premounts the cgroupfs rw and
    chowns it to the pod's mapped root. The chart threads the name via
    `sandbox.dockerRuntimeClass` →
    `VALET_SANDBOX_DOCKER_RUNTIME_CLASS` → the manifest's
    `runtimeClassName` (docker sandboxes only). The `docker:dind`
    remount trick alone is NOT enough here: a plain remount is EPERM
    from a userns (superblock op), a bind remount clears the ro flag
    but cannot fix ownership, and a fresh cgroup2 mount over the
    mountpoint is refused (fs already mounted).
  - Bootstrap: before dockerd starts, `start-docker.sh` bind-remounts
    the cgroupfs rw. It moves root processes into `/init` and enables the
    root controllers. It then creates `/init/services` as a root-owned
    leaf. A bounded loop moves each direct `/init` process into that leaf.
    The loop uses `cgroup.procs`, which moves all threads in each process.
    The script enables every available controller below empty `/init`.
    CPU and PID controllers are required. A missing controller, a racing
    process, or an `EBUSY` result stops startup with a corrective error.
  - Ownership: Valet delegates only `/init`, `cgroup.procs`,
    `cgroup.threads`, and `cgroup.subtree_control` to UID 1500. The
    `services` leaf stays owned by mapped root for stable process placement,
    not as a protection boundary. Cgroup v2 does not check target process
    credentials during migration. UID 1500 can move PID 1 or another
    root-owned service through `/init/cgroup.procs` into an owned sibling.
    It can then freeze, kill, or throttle that service. UID 1500 can also
    disable manager subtree controllers or repopulate `/init`. This access
    permits self-denial of service inside the sandbox. It does not permit
    movement across the private cgroup namespace or changes to outer limits.
  - Service placement: Tini is PID 1. It starts the selected startup script
    and forwards signals to its process group. Tini, the startup chain,
    dockerd, containerd, and gateway services inherit `/init/services`.
    Kubernetes exec commands
    are expected to join PID 1's cgroup, as observed in the target cluster.
    Acceptance must verify this behavior after controller or runtime
    upgrades. Valet keeps `services` for the sandbox container lifetime.
  - Nested runtime: mono can create `/init/tkhq-k3s`. RootlessKit can then
    create `k3s_evac` below that sibling without evacuating sandbox
    services or enabling controllers at a populated manager. Mono owns
    creation and cleanup of `tkhq-k3s`; Valet does not create it.
    The proposed first-class replacement moves this ownership to Valet.
    See `2026-09-12-nested-kubernetes-design.md`.
  - Containment: the private cgroup namespace makes the sandbox container
    cgroup appear as `/sys/fs/cgroup`. The visible root and all CPU,
    memory, and PID limit files stay owned by mapped root. Ancestor limits
    remain effective for every nested cgroup.

### Exec identity

Acceptance testing surfaced the root cause of inner-container
failures (`chdir /workspace: permission denied`): the agent's execs
ran as container root, and root-owned files have no mapping inside
the rootless daemon's user namespace. The fix: in a docker-enabled
sandbox, every non-privileged exec runs as the `dockerd` workload
user.

- Contract: `ExecOpts.privileged` (engine). Default false. Prep's
  system steps (the `/usr/local/bin` credential-helper install) pass
  `privileged: true` and keep root. Everything else — the agent's
  commands, git clone and config — runs as `dockerd`.
- sandbox-docker: `buildDockerExecArgs` adds `-u dockerd` and
  `--env HOME=/home/dockerd`. Creds files are written 0644 (dir
  0755) so the credential helper can read them as `dockerd`.
- sandbox-kubernetes: `pods/exec` has no per-call user, so
  `execInPod` wraps the composed command in
  `setpriv --reuid dockerd --regid dockerd --init-groups` with
  HOME/USER/LOGNAME set. The flag reaches the exec layer from
  `SandboxCreateOpts.docker` at create and from the CR's
  `valet.dev/docker` label on restore.
- Workspace ownership: `start-docker.sh` chowns `/workspace` to
  `dockerd` (non-recursive) on the docker provider; the k8s manifest
  sets pod-level `securityContext.fsGroup: 1500` so the PVC mounts
  group-writable.

Sandboxes without `docker: true` are unchanged — `privileged` has no
effect there.

### State lifetime

Docker state (images, containers, volumes created inside the sandbox)
is ephemeral in v1: lost on hibernate, recreate, and reconcile. Images
re-pull on next use. Persisting the data-root on the workspace PVC is
a possible later optimization; it is out of scope here because
fuse-overlayfs state on a shared PVC has unclear crash semantics.

## Security posture

`docker: true` relaxes, per opted-in sandbox only:

- seccomp: unconfined (larger kernel syscall attack surface)
- AppArmor: unconfined
- system paths: unconfined (unmasked `/proc/sys` for sysctl in rootlesskit netns)
- capabilities: adds CAP_SYS_ADMIN and CAP_NET_ADMIN
- devices: adds `/dev/fuse` and `/dev/net/tun`

CAP_SYS_ADMIN on the outer container is the largest single relaxation.
It is confined to opted-in sandboxes and is strictly weaker than
`--privileged` (no raw block devices, all other caps dropped, system
paths selectively unmasked rather than fully exposed).

It does NOT:

- run the sandbox or the daemon as privileged
- mount the host docker socket
- add any capability beyond SYS_ADMIN and NET_ADMIN
- change anything for sandboxes that did not opt in

The daemon and every container it runs live inside the sandbox's user
namespace. A container escape from the inner docker lands in the
rootless daemon's userns, not on the host. The residual risk is kernel
attack surface through unconfined seccomp and SYS_ADMIN — the same
trade already accepted for rootless BuildKit build pods.

`docs/security-model.md` gains a subsection stating the above.

## Testing

1. Unit: `buildDockerRunArgs` and the k8s manifest builder emit the
   exact deltas above when `docker: true`, and emit nothing extra when
   absent. Conformance: `dockerSupport` capability reported correctly
   per provider.
2. E2e (gated `needs: ["docker"]`): create a `docker: true` sandbox,
   then inside it run `docker build` on a small context, `docker run`
   with a bind volume and a published port, and assert output.
3. Acceptance (manual at first): deploy the image and create a fresh
   `docker: true` child. Verify that `/init` is empty and distributes CPU
   and PID controllers. Verify that PID 1, dockerd, containerd, gateway,
   and a new exec run in `/init/services`. Verify that UID 1500 cannot
   change outer limits, but can move itself to `/init/tkhq-k3s`. Start
   RootlessKit and confirm that services stay in place without `EBUSY`.
   Run three ready and cleanup cycles. Then run the docker-gated suites
   (`make e2e E2E_ARGS="--only sandbox-docker,store-postgres,prebuilds-docker"`).
   Record results in the PR. Repeat placement checks after runtime upgrades.

## Kubernetes reality (2026-08-17 addendum)

Live verification on EKS v1.31 (agents-dev) found three failures with a
single dominant root cause. Valet's CR was correct in every case.

1. **The API server drops `procMount: Unmasked`.** The `ProcMountType`
   feature gate is beta and OFF by default until Kubernetes 1.33, and EKS
   does not let operators set control-plane gates. Admission silently
   rewrites the field to `Default` (verified with a server-side dry-run).
   The pod's /proc keeps its masked and read-only paths, which breaks:
   - `dockerd-rootless.sh`: its `--detach-netns` path writes
     `net.ipv4.ip_forward` through the read-only `/proc/sys` → EPERM.
   - runc for EVERY inner container: the kernel refuses a fresh procfs
     mount in a user namespace unless an existing fully-visible procfs is
     present → `mount proc: operation not permitted` on `docker run` and
     `docker build`.
2. **`/dev/fuse` open fails with EPERM.** A hostPath char-device volume
   carries no device-cgroup grant (unlike the docker backend's
   `--device /dev/fuse`), so fuse-overlayfs cannot open the device even
   though the node is mounted.
3. **`overlay2` needs a non-overlay data-root.** The pod rootfs is
   overlay; the emptyDir docker-state volume is not — native rootless
   overlay2 works there (kernel >= 5.11).

Mitigations shipped:

- `start-docker.sh` invokes rootlesskit directly WITHOUT `--detach-netns`
  (empirically starts on masked-proc clusters) and probes storage drivers
  in order overlay2 → fuse-overlayfs → vfs. The daemon now starts
  everywhere; inner containers still need an unmasked /proc.
- The fuse-overlayfs probe mounts a layer and executes a copied binary
  inside the rootless user namespace. An open `/dev/fuse` does not prove
  that executable layers work. Docker Desktop LinuxKit 6.10.14 can reject
  execution with `EINVAL` after a successful mount. The probe selects vfs
  if execution fails. It unmounts the probe before removing its files.
- The manifest sets `hostUsers: false` on docker pods. Kubernetes >= 1.31
  validation requires it for `procMount: Unmasked` and REJECTS the pod
  without it once the ProcMountType gate is on (default from 1.33). On
  clusters with `UserNamespacesSupport` off the field is dropped at
  admission — inert today, load-bearing after the upgrade.
- The image assigns `dockerd:65536:65535` in `/etc/subuid` and
  `/etc/subgid`. RootlessKit maps inner ID 0 to outer ID 1500. It maps
  inner IDs 1 through 65535 to outer IDs 65536 through 131070. This
  preserves all 16-bit IDs without using outer low identities.
- `userns-preflight.sh` rejects a Kubernetes user namespace that cannot
  represent IDs 65536 through 131070. It does not use a shorter range.

> **Deployment order:** Do not deploy this image until default and large
> sandbox nodes run Kubernetes 1.35 with `userNamespaces.idsPerPod: 131072`.
> Older 65536-ID pods fail closed before Docker starts.

Cluster requirement for FULL DinD on kubernetes: **Kubernetes >= 1.33**
(ProcMountType + UserNamespacesSupport on by default) with a node runtime
that supports user-namespaced pods. Until the cluster upgrade, DinD on
kubernetes is degraded: the daemon runs, `docker pull`/`system df` work,
`docker run`/`build` fail on the proc mount.

## Out of scope

- Persistent docker data-root across hibernation.
- docker-compose / buildx multi-arch parity guarantees.
- Per-org policy to forbid `docker: true` (add when org policy
  machinery exists).
- The legacy stack (`packages/worker`, Modal) — frozen.

## Managed browser provider boundary (2026-09-23)

Browser capabilities require explicit provider opt-in. Plain images retain their existing execution identity.
Docker and Helm default to disabled until the managed image and required security profile are installed.
A browser-enabled sandbox uses the separate reviewed seccomp profile in `packages/sandbox-docker/seccomp/browser.json`.
It cannot combine that profile with Docker-in-sandbox or nested Kubernetes.

The workload uses UID 1500 for shell, file APIs, terminal, and editor.
The browser daemon uses another UID and private state outside `/workspace`.
The fixed root-owned client drops to that UID and clears inherited environment values.
Workload commands cannot inherit the gateway signing secret.

Docker keeps an atomic owner inventory and a private state bind mount for each session.
Each API data directory has its own Docker inventory so independent API instances do not reap each other's sessions.
API restart adopts the validated owner; release retains its profile and audit journal.
Docker rejects replacement without browser isolation while the owner has retained browser state.
Final deletion exports the audit first and then removes private state.
A stopped owner uses a read-only journal helper with a shared owner lock.
Before release or deletion, Docker restores working-directory ownership to the API process.

Kubernetes uses a session-owned private PVC without a Sandbox CR owner reference.
Both providers reject browser isolation downgrades while private state remains.
Kubernetes lists private PVC owners after CR deletion so failed state deletion remains retryable.
The provider checks the saved browser owner before it changes credentials or the Sandbox CR.
It uses the node Localhost profile and waits for the browser preflight marker.
Missing retained state fails closed. See `deploy/browser.md` for node installation and image requirements.
