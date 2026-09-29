import { Fragment, useState } from "react";
import { ArrowDownUp, ChevronDown, ChevronRight, Search, Trash2 } from "lucide-react";
import type { BakeSummary, SourceSummary } from "~/api/sources";
import { Badge, Button, Dialog, DialogContent, DialogFooter, Input, Label, SelectMenu, Spinner, Switch } from "~/components/primitives";
import { BakeQueuePanel } from "~/components/settings/bake-queue-panel";
import { Section } from "~/components/settings/section";
import { RepoSandboxResourcesForm } from "~/components/settings/repo-sandbox-resources-form";
import { ApiError } from "~/api/client";
import { relativeTime } from "~/lib/relative-time";
import {
  useSources,
  useCreateSource,
  usePatchSource,
  useDeleteSource,
  useBakeSource,
  useSourceBakes,
} from "~/api/sources";

/**
 * Organization · Sandbox settings — unified sources page (sandbox-reconciliation
 * plan, Task 18). Three groups on one page: Base image (org-wide setup
 * commands), Repository images (auto-created, per-repo enabled toggle + bake
 * history), External images (admin-registered image refs for catalog use).
 *
 * Replaces `ImageCatalogSection` (kind='external' view) and `PrebuildsSection`
 * (kind='repo' view). Rendered inside `/settings/organization`'s
 * `OrgRouteGuard` — no per-section admin re-check needed.
 */
export function SourcesSection() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<RepoSort>("name");
  const sourcesQ = useSources();
  const sources = sourcesQ.data?.sources ?? [];
  const builderAvailable = sourcesQ.data?.builderAvailable ?? false;

  const baseSource = sources.find((s) => s.kind === "base");
  const repoSources = sources.filter((s) => s.kind === "repo");
  const query = search.trim().toLowerCase();
  const sortedRepos = repoSources.sort((a, b) => {
    const byName = (a.repoFullName ?? a.name).localeCompare(b.repoFullName ?? b.name);
    if (sort === "recent") return (b.lastBoundAt ?? 0) - (a.lastBoundAt ?? 0) || byName;
    if (sort === "status") return repoStatus(a).order - repoStatus(b).order || byName;
    return sort === "name-desc" ? -byName : byName;
  });
  const visibleRepoIds = new Set(
    sortedRepos
      .filter((source) => (source.repoFullName ?? source.name).toLowerCase().includes(query))
      .map((source) => source.id),
  );
  const externalSources = sources.filter((s) => s.kind === "external");

  return (
    <div className="space-y-10">
      <BakeQueuePanel />
      {/* ── Base image ─────────────────────────────────────────────────── */}
      <Section
        title="Base image"
        description="Commands that install tools every sandbox needs. The base image is built once and shared across runtimes."
      >
        {sourcesQ.isLoading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {sourcesQ.error && (
          <p className="py-4 text-sm text-danger-500">Failed to load image sources. Reload the page.</p>
        )}
        {sourcesQ.data && (
          <BaseImageCard source={baseSource} builderAvailable={builderAvailable} />
        )}
      </Section>

      {/* ── Repository images ───────────────────────────────────────────── */}
      <Section
        title="Repository images"
        description="Per-repo images pre-built from a repo's dependencies. Runtimes boot without a cold install."
      >
        {sourcesQ.data && (
          <div className="space-y-3">
            {repoSources.length > 0 && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted" aria-hidden />
                  <Input
                    type="search"
                    aria-label="Search repositories"
                    placeholder="Search repositories…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="pl-9"
                  />
                </div>
                <SelectMenu
                  value={sort}
                  options={REPO_SORT_OPTIONS}
                  onChange={setSort}
                  triggerLabel={
                    <>
                      <ArrowDownUp className="h-3.5 w-3.5" aria-hidden />
                      Sort: {REPO_SORT_OPTIONS.find((option) => option.value === sort)?.label}
                    </>
                  }
                />
              </div>
            )}
            {repoSources.length === 0 ? (
              <p className="py-4 text-sm text-muted">
                Repository images appear automatically when a runtime binds a repo.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted" aria-live="polite">
                  {visibleRepoIds.size} of {repoSources.length} repositories
                </p>
                <div className="divide-y divide-line rounded-lg border border-line">
                  {visibleRepoIds.size === 0 && (
                    <div className="space-y-2 p-6 text-center">
                      <p className="text-sm text-muted">No repositories match your search.</p>
                      <Button variant="ghost" size="sm" onClick={() => setSearch("")}>Clear search</Button>
                    </div>
                  )}
                  {sortedRepos.map((source) => (
                    <RepoSourceRow key={source.id} source={source} builderAvailable={builderAvailable} visible={visibleRepoIds.has(source.id)} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {sourcesQ.isLoading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
      </Section>

      {/* ── External images ─────────────────────────────────────────────── */}
      <Section
        title="External images"
        description="Admin-registered image refs. Use these when a registry already has the image you need."
      >
        {sourcesQ.data && (
          <div className="divide-y divide-line">
            {externalSources.map((source) => (
              <ExternalSourceRow key={source.id} source={source} />
            ))}
            <CreateExternalSourceRow />
          </div>
        )}
        {sourcesQ.isLoading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
      </Section>
    </div>
  );
}

// ── Base image ────────────────────────────────────────────────────────────────

function BaseImageCard({
  source,
  builderAvailable,
}: {
  source: SourceSummary | undefined;
  builderAvailable: boolean;
}) {
  const createSource = useCreateSource();
  const patchSource = usePatchSource();
  const bakeSource = useBakeSource();

  // Textarea: one command per line. API stores string[].
  const [commands, setCommands] = useState<string>(
    source?.setupCommands?.join("\n") ?? "",
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bakeError, setBakeError] = useState<string | null>(null);

  // Latest bake for the base source — only fetch when source exists.
  const bakesQ = useSourceBakes(source?.id ?? "", { enabled: Boolean(source?.id) });
  const latestBake: BakeSummary | undefined = bakesQ.data?.bakes[0];

  const isSaving = createSource.isPending || patchSource.isPending;
  const isBaking = bakeSource.isPending;

  function handleSave() {
    setSaveError(null);
    // Split on newlines; filter blank lines.
    const setupCommands = commands
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (source) {
      patchSource.mutate(
        { id: source.id, body: { setupCommands } },
        {
          onError: (err) => {
            const msg = extractApiError(err);
            setSaveError(msg ?? "Failed to save. Check your commands and try again.");
          },
        },
      );
    } else {
      createSource.mutate(
        { kind: "base", name: "Base", setupCommands },
        {
          onError: (err) => {
            const msg = extractApiError(err);
            setSaveError(msg ?? "Failed to save. Check your commands and try again.");
          },
        },
      );
    }
  }

  function handleBake() {
    if (!source) return;
    setBakeError(null);
    bakeSource.mutate(source.id, {
      onError: (err) => {
        const msg = extractApiError(err);
        setBakeError(msg ?? "Bake failed to start. Check that an image builder is configured.");
      },
    });
  }

  return (
    <div className="space-y-4 py-4">
      <div className="space-y-1.5">
        <Label htmlFor="base-setup-commands">Setup commands</Label>
        <textarea
          id="base-setup-commands"
          value={commands}
          onChange={(e) => setCommands(e.target.value)}
          rows={6}
          placeholder={
            "Add commands that install the tools every sandbox needs — python3, jq, build tools.\nOne command per line."
          }
          className="w-full rounded-md border border-line bg-paper px-3 py-2 font-mono text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss"
        />
        <p className="text-xs text-muted">One command per line. Multi-line commands are not allowed.</p>
      </div>

      {saveError && <p className="text-sm text-danger-500">{saveError}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving…" : "Save"}
        </Button>
        {source && (
          <Button
            type="button"
            variant="secondary"
            onClick={handleBake}
            disabled={isBaking || !builderAvailable}
          >
            {isBaking ? "Starting…" : "Bake now"}
          </Button>
        )}
      </div>

      {bakeError && <p className="text-sm text-danger-500">{bakeError}</p>}

      {latestBake && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>Last bake:</span>
          <Badge variant={BAKE_STATUS_VARIANT[latestBake.status]}>{latestBake.status}</Badge>
          {latestBake.finishedAt ? (
            <span>{relativeTime(latestBake.finishedAt)}</span>
          ) : latestBake.startedAt ? (
            <span>started {relativeTime(latestBake.startedAt)}</span>
          ) : (
            <span>queued</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Repository source row ─────────────────────────────────────────────────────

type RepoSort = "name" | "name-desc" | "recent" | "status";
const REPO_SORT_OPTIONS: { value: RepoSort; label: string }[] = [
  { value: "name", label: "Name A–Z" },
  { value: "name-desc", label: "Name Z–A" },
  { value: "recent", label: "Recently used" },
  { value: "status", label: "Build status" },
];

const REPO_STATUS: Record<BakeSummary["status"], { label: string; variant: "accent" | "neutral" | "success" | "danger"; order: number }> = {
  building: { label: "Building", variant: "accent", order: 0 },
  queued: { label: "Build queued", variant: "neutral", order: 1 },
  failed: { label: "Build failed", variant: "danger", order: 2 },
  pushed: { label: "Built", variant: "success", order: 3 },
};

function repoStatus(source: SourceSummary) {
  if (source.latestBake) return REPO_STATUS[source.latestBake.status];
  return { label: source.latestBake === null ? "Not built" : "Status unavailable", variant: "neutral" as const, order: 4 };
}

// A repo source is "decayed" when it is disabled and has not been used in
// 30 days (30 * 24 * 60 * 60 * 1000 ms). Show a quiet indicator rather than
// hiding the row — admins may want to re-enable without re-triggering a bind.
const DECAY_MS = 30 * 24 * 60 * 60 * 1000;

function RepoSourceRow({
  source,
  builderAvailable,
  visible,
}: {
  source: SourceSummary;
  builderAvailable: boolean;
  visible: boolean;
}) {
  const patchSource = usePatchSource();
  const bakeSource = useBakeSource();
  const [expanded, setExpanded] = useState(false);
  const [hasExpanded, setHasExpanded] = useState(false);
  const status = repoStatus(source);
  const repoName = source.repoFullName ?? source.name;
  const detailsId = `repo-details-${source.id}`;
  const [bakeError, setBakeError] = useState<string | null>(null);

  const bakesQ = useSourceBakes(source.id, { enabled: expanded && visible });

  const isDecayed =
    !source.enabled &&
    source.lastBoundAt !== null &&
    Date.now() - source.lastBoundAt > DECAY_MS;

  function handleBake() {
    setBakeError(null);
    bakeSource.mutate(source.id, {
      onError: (err) => {
        const msg = extractApiError(err);
        setBakeError(msg ?? "Bake failed to start. Check that an image builder is configured.");
      },
    });
  }

  return (
    <div hidden={!visible} className="space-y-3 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all text-sm font-medium text-ink">
              {source.repoFullName ?? source.name}
            </span>
            <Badge variant={status.variant} className="shrink-0 gap-1.5 rounded-full px-2" role="status">
              <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
              {status.label}
            </Badge>
          </div>
          {isDecayed && (
            <p className="mt-0.5 text-xs text-muted">paused — repo unused</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted">
            Enabled
            <Switch
              checked={source.enabled}
              onCheckedChange={(checked) =>
                patchSource.mutate({ id: source.id, body: { enabled: checked } })
              }
              aria-label={`Enable bakes for ${source.repoFullName ?? source.name}`}
            />
          </label>

          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleBake}
            disabled={bakeSource.isPending || !builderAvailable}
          >
            {bakeSource.isPending ? "Starting…" : "Bake now"}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setExpanded((value) => !value);
              setHasExpanded(true);
            }}
            aria-label={`Details for ${repoName}`}
            aria-expanded={expanded}
            aria-controls={detailsId}
          >
            Details
            {expanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
      </div>

      {bakeError && <p className="text-xs text-danger-500">{bakeError}</p>}

      <div id={detailsId} hidden={!expanded}>
        {hasExpanded && (
          <div className="space-y-5 border-t border-line pt-4">
            <RepoSandboxResourcesForm source={source} />
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-ink">Sandbox history</h3>
              {bakesQ.error ? (
                <p className="text-xs text-danger-500">History could not load. Close and reopen Details to retry.</p>
              ) : (
                <BakeHistoryTable bakes={bakesQ.data?.bakes ?? []} loading={bakesQ.isLoading} />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Bake history table ────────────────────────────────────────────────────────

const BAKE_STATUS_VARIANT: Record<BakeSummary["status"], "neutral" | "accent" | "success" | "danger"> = {
  queued: "neutral",
  building: "accent",
  pushed: "success",
  failed: "danger",
};

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function BakeHistoryTable({ bakes, loading }: { bakes: BakeSummary[]; loading: boolean }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Spinner size={12} /> Loading bakes…
      </div>
    );
  }
  if (bakes.length === 0) {
    return <p className="text-xs text-muted">No bakes yet.</p>;
  }

  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="text-muted">
          <th className="py-1 pr-3 font-medium">Status</th>
          <th className="py-1 pr-3 font-medium">Commit</th>
          <th className="py-1 pr-3 font-medium">When</th>
        </tr>
      </thead>
      <tbody>
        {bakes.map((bake) => {
          const expanded = expandedId === bake.id;
          const hasDetail = Boolean(bake.logTail || bake.error);
          return (
            <Fragment key={bake.id}>
              <tr className="border-t border-line">
                <td className="py-1.5 pr-3">
                  <Badge variant={BAKE_STATUS_VARIANT[bake.status]}>{bake.status}</Badge>
                </td>
                <td className="py-1.5 pr-3 font-mono text-ink">
                  {bake.commitSha ? shortSha(bake.commitSha) : "—"}
                </td>
                <td className="py-1.5 pr-3 text-muted">
                  {bake.finishedAt
                    ? relativeTime(bake.finishedAt)
                    : bake.startedAt
                      ? `started ${relativeTime(bake.startedAt)}`
                      : "queued"}
                  {hasDetail && (
                    <button
                      type="button"
                      className="ml-2 text-moss underline"
                      onClick={() => setExpandedId(expanded ? null : bake.id)}
                    >
                      {expanded ? "Hide details" : "Details"}
                    </button>
                  )}
                </td>
              </tr>
              {expanded && (
                <tr className="border-t border-line">
                  <td colSpan={3} className="py-1.5 pr-3">
                    {bake.error && <p className="text-danger-500">{bake.error}</p>}
                    {bake.logTail && (
                      <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-ink-wash p-2 text-[11px] text-muted">
                        {bake.logTail}
                      </pre>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ── External source row ───────────────────────────────────────────────────────

function ExternalSourceRow({ source }: { source: SourceSummary }) {
  const deleteSource = useDeleteSource();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{source.name}</span>
          {source.pullSecretName && (
            <Badge variant="neutral">{source.pullSecretName}</Badge>
          )}
        </div>
        <span className="block truncate text-xs text-muted">{source.externalRef}</span>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Delete ${source.name}`}
        onClick={() => setConfirmDelete(true)}
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title={`Delete ${source.name}?`}
          description="Runtimes using this image will fall back to the stock sandbox image on their next start."
        >
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={deleteSource.isPending}
              onClick={() => deleteSource.mutate(source.id, { onSuccess: () => setConfirmDelete(false) })}
            >
              {deleteSource.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Create external source row ────────────────────────────────────────────────

function CreateExternalSourceRow() {
  const createSource = useCreateSource();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [pullSecretName, setPullSecretName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    if (!name.trim() || !externalRef.trim()) return;
    setError(null);
    createSource.mutate(
      {
        kind: "external",
        name: name.trim(),
        externalRef: externalRef.trim(),
        pullSecretName: pullSecretName.trim() || undefined,
      },
      {
        onSuccess: () => {
          setName("");
          setExternalRef("");
          setPullSecretName("");
          setOpen(false);
        },
        onError: (err) => {
          const msg = extractApiError(err);
          setError(msg ?? "Failed to add image. Provide a valid name and image ref.");
        },
      },
    );
  }

  if (!open) {
    return (
      <div className="py-4">
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Add external image
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 py-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="new-ext-name">Name</Label>
          <Input
            id="new-ext-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Node 22"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="new-ext-ref">Image ref</Label>
          <Input
            id="new-ext-ref"
            value={externalRef}
            onChange={(e) => setExternalRef(e.target.value)}
            placeholder="registry.example.com/valet-base:node22"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="new-ext-pull-secret">Pull secret name (optional)</Label>
          <Input
            id="new-ext-pull-secret"
            value={pullSecretName}
            onChange={(e) => setPullSecretName(e.target.value)}
            placeholder="regcred"
          />
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          type="button"
          onClick={submit}
          disabled={!name.trim() || !externalRef.trim() || createSource.isPending}
        >
          {createSource.isPending ? "Adding…" : "Add"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-danger-500">{error}</p>}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the server's `{ error: string }` payload from an ApiError, or fall
 * back to `err.message`. Returns undefined when no useful message is found. */
function extractApiError(err: Error): string | undefined {
  if (err instanceof ApiError && typeof err.payload === "object" && err.payload !== null) {
    const payload = err.payload as { error?: string };
    if (typeof payload.error === "string") return payload.error;
  }
  return err.message || undefined;
}
