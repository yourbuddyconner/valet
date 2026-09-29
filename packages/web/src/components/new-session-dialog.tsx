import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { CreateSessionRequest, RepoBinding } from "@valet/api/wire";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
} from "~/components/primitives";
import { useCreateSession } from "~/api/queries";
import { useRepoPrebuild, useRepos } from "~/api/repos";
import { relativeTime } from "~/lib/relative-time";
import { useWorkspaceScope } from "~/lib/workspace-scope";
import { CreateScopeLine } from "~/components/workspace-clause";
import {
  RepoCombobox,
  repoBaseName,
  workspaceForRepo,
  DEFAULT_WORKSPACE_BASE,
  type RepoOption,
} from "~/components/repo-combobox";

const DEFAULT_WORKSPACE = DEFAULT_WORKSPACE_BASE;
const MAX_REPOS = 5;

interface RepoRow {
  fullName: string;
  cloneUrl: string;
  ref: string;
  auth: "auto" | "app" | "user";
  installed?: boolean;
}

export function NewSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const navigate = useNavigate();
  const create = useCreateSession();
  const reposQ = useRepos();
  // The nav's switcher answers "whose session is this" — the dialog passes
  // that answer through and states it (`CreateScopeLine`) instead of asking
  // again with an owner dropdown. See `workspace-scope.tsx`.
  const scope = useWorkspaceScope();
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);
  const [workspaceTouched, setWorkspaceTouched] = useState(false);
  const [rows, setRows] = useState<RepoRow[]>([]);

  const repos = reposQ.data?.repos ?? [];
  const connected = reposQ.data?.connected ?? false;
  const installed = reposQ.data?.installed ?? false;
  // Neither a personal connection nor an org App install — there is
  // nothing this picker could list, so it never renders an empty/broken
  // combobox; it points the user at settings instead.
  const showConnectHint = !connected && !installed;
  const availableRepos = repos.filter((r) => !rows.some((row) => row.fullName === r.fullName));

  function addRepo(repo: RepoOption) {
    if (rows.length >= MAX_REPOS) return;
    const cloneUrl = repo.cloneUrl ?? repo.url;
    setRows((prev) => [
      ...prev,
      {
        fullName: repo.fullName,
        cloneUrl,
        ref: repo.defaultBranch,
        auth: "auto",
        installed: repo.installed,
      },
    ]);
    // Only the first repo drives the default — and only while the user
    // hasn't typed their own path (editable per the brief: autofill is a
    // convenience, not a lock).
    if (!workspaceTouched) {
      setWorkspace(workspaceForRepo(repo.fullName));
    }
  }

  function removeRepo(fullName: string) {
    setRows((prev) => prev.filter((r) => r.fullName !== fullName));
  }

  function updateRow(fullName: string, patch: Partial<RepoRow>) {
    setRows((prev) => prev.map((r) => (r.fullName === fullName ? { ...r, ...patch } : r)));
  }

  async function submit() {
    const ws = workspace.trim();
    if (!ws) return;
    try {
      const body: CreateSessionRequest = { workspace: ws, profile: "full" };
      if (scope.teamId !== undefined) body.teamId = scope.teamId;
      if (rows.length > 0) {
        const repoBindings: RepoBinding[] = rows.map((r) => ({
          host: "github",
          fullName: r.fullName,
          cloneUrl: r.cloneUrl,
          ref: r.ref,
          auth: r.auth,
        }));
        body.repos = repoBindings;
      }
      // Web-created sessions are interactive (Terminal/VS Code tabs, Task 7)
      // — "full" runs ttyd + code-server behind the sandbox auth gateway
      // alongside the agent, vs. the "headless" default for agent-only
      // (e.g. orchestrator-spawned) sessions.
      const created = await create.mutateAsync(body);
      onOpenChange(false);
      navigate({ to: "/sessions/$sessionId", params: { sessionId: created.id } });
    } catch {
      // useMutation surfaces the error in `create.error`; the dialog stays open.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="New runtime"
        description="The agent runs bash, read, write, and edit tools against this directory inside a Docker sandbox."
      >
        <CreateScopeLine what="runtime" />
        <div className="grid gap-1">
          {/* "Working directory", not "workspace" — that word names the
              switcher scope now (one name for one thing; CLAUDE.md
              terminology note). The field itself is unchanged: the
              in-sandbox path the tools run against. */}
          <Label htmlFor="workspace">Working directory</Label>
          <Input
            id="workspace"
            value={workspace}
            onChange={(e) => {
              setWorkspace(e.target.value);
              setWorkspaceTouched(true);
            }}
            placeholder={DEFAULT_WORKSPACE}
            autoFocus
          />
          <p className="text-xs text-muted">
            Absolute path on this host. Will be created if missing.
          </p>
        </div>

        <div className="grid gap-2">
          <Label>Repositories (optional)</Label>
          {rows.map((row) => (
            <RepoRowView
              key={row.fullName}
              row={row}
              connected={connected}
              onRemove={() => removeRepo(row.fullName)}
              onChange={(patch) => updateRow(row.fullName, patch)}
            />
          ))}

          {showConnectHint ? (
            <p className="text-xs text-muted">
              Connect GitHub or install the App to add repos.{" "}
              <a href="/settings/connected-accounts" className="text-moss underline">
                Go to settings
              </a>
            </p>
          ) : rows.length < MAX_REPOS ? (
            <RepoCombobox
              repos={availableRepos}
              label={rows.length === 0 ? "Search repositories" : "Add another repo"}
              onSelect={addRepo}
            />
          ) : (
            <p className="text-xs text-muted">Up to 5 repos.</p>
          )}
        </div>

        {create.error && (
          <div className="rounded border border-danger-500/30 bg-danger-500/10 px-3 py-2 text-xs text-danger-600">
            {create.error.message}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={create.isPending || !workspace.trim()}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const AUTH_OPTIONS: { value: RepoRow["auth"]; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "app", label: "App (bot)" },
  { value: "user", label: "Me" },
];

function RepoRowView({
  row,
  connected,
  onRemove,
  onChange,
}: {
  row: RepoRow;
  connected: boolean;
  onRemove: () => void;
  onChange: (patch: Partial<RepoRow>) => void;
}) {
  // Only meaningful when there's an actual choice to make: an
  // App-installed repo AND a personal connection both capable of
  // authenticating the clone. Otherwise the server's "auto" pick is the
  // only usable path anyway.
  const showAuthSelect = !!row.installed && connected;
  const prebuildQ = useRepoPrebuild(row.fullName);
  const prebuild = prebuildQ.data?.prebuild;

  return (
    <div className="space-y-1.5 rounded border border-line p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-ink">{row.fullName}</span>
          {prebuild && (
            <span className="shrink-0 text-xs text-muted">
              prebuilt · {repoBaseName(row.fullName)}@{prebuild.commitSha.slice(0, 7)} · built{" "}
              {relativeTime(prebuild.finishedAt)}
            </span>
          )}
        </div>
        <button
          type="button"
          aria-label={`Remove ${row.fullName}`}
          onClick={onRemove}
          className="shrink-0 text-xs text-muted hover:text-danger-500"
        >
          Remove
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <div className="grid gap-1">
          <Label htmlFor={`ref-${row.fullName}`}>Branch</Label>
          <Input
            id={`ref-${row.fullName}`}
            aria-label={`Branch for ${row.fullName}`}
            value={row.ref}
            onChange={(e) => onChange({ ref: e.target.value })}
            className="h-8 w-40 text-xs"
          />
        </div>
        {showAuthSelect && (
          <div className="grid gap-1">
            <Label htmlFor={`auth-${row.fullName}`}>Authenticate as</Label>
            <select
              id={`auth-${row.fullName}`}
              aria-label={`Authenticate as for ${row.fullName}`}
              value={row.auth}
              onChange={(e) => onChange({ auth: e.target.value as RepoRow["auth"] })}
              className="h-8 rounded border border-[--border] bg-[--bg] px-2 text-xs text-[--fg]"
            >
              {AUTH_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  );
}

