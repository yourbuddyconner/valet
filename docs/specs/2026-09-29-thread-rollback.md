# Thread refactor rollback compatibility

The application migration preserves retired assistant profile fields, default flags,
and follow/schedule assistant addresses. Current models omit these fields, while
older binaries can still read them. New singleton identities default to the legacy
default flag. Both the workspace uniqueness index and legacy default index remain.
Duplicate profiles cause upgrade to reject without deleting history.

Run `mise x node@22 -- node scripts/rollback/check-thread-rollback.mjs`.
The default baseline is `d3e9ede2e7788314dcbd319bfa9aaaa343d21b6a`.
The harness compiles actual migration, store, and routing code from the baseline
and current checkout. Four separate processes seed, upgrade, roll back, and
reopen one isolated on-disk PGlite database. Evidence is retained in the printed
temporary directory. It verifies identity, history, pending decisions, profile
values, followed-thread routing, and schedule addresses, including writes after
upgrade and rollback.

This is bounded storage and service compatibility, not a full older web/API server
deployment. The older binary cannot create a second assistant in a workspace while
the singleton index remains. Columns already deleted by an earlier development
build can be recreated, but their lost values require a backup to recover.

Validation on 2026-09-29: all four phases passed, and singleton migration tests
passed (2 tests). Live Slack interactivity has a separate
[validation procedure](../guides/live-slack-child-approval.md).

## Local validation environment recovery

The `rancher-desktop` context points to k3d in Colima on this machine. Docker
browser tests use the separate Docker Desktop daemon. Recovery kept that Docker
context unchanged. The Colima data filesystem was full and had orphan inode and
bitmap errors. After stopping its services and unmounting the data filesystem,
we saved a copy-on-write copy of the data disk, repaired the filesystem, and grew
it from 50 to 80 GiB. Kubernetes then reported `DiskPressure=False`, with about
30 GiB free. No application volumes or stopped user containers were deleted.

The backup remains at
`~/.colima/_lima/_disks/colima/datadisk.before-thread-repair`.
Do not restore it over a running VM. Keep it until the local environment has been
checked. The separate worktree PGlite data was not changed by this operation.

The nested Docker failure was independent: fuse-overlayfs mounted successfully
but executable files returned EINVAL. The startup probe now tests execution as
well as mounting and falls back to vfs. Real Docker browser lifecycle and API
checks passed after rebuilding the sandbox image.
