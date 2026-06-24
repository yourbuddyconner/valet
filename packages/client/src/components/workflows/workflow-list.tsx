import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCreateWorkflow, useWorkflows, type Workflow } from '@/api/workflows';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchInput } from '@/components/ui/search-input';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { formatRelativeTime, slugify } from '@/lib/format';

export function WorkflowList() {
  const [search, setSearch] = React.useState('');
  const { data, isLoading, error } = useWorkflows();

  const workflows = data?.workflows ?? [];

  const filteredWorkflows = React.useMemo(() => {
    if (!search) return workflows;

    const searchLower = search.toLowerCase();
    return workflows.filter((workflow) => {
      const nameMatch = workflow.name?.toLowerCase().includes(searchLower);
      const descMatch = workflow.description?.toLowerCase().includes(searchLower);
      const slugMatch = workflow.slug?.toLowerCase().includes(searchLower);
      return nameMatch || descMatch || slugMatch;
    });
  }, [workflows, search]);

  if (isLoading) {
    return <WorkflowListSkeleton />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
        <p className="text-sm text-pretty text-red-600 dark:text-red-400">
          Failed to load workflows. Please try again.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-xs">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search workflows..."
          />
        </div>
        <CreateWorkflowDialog />
      </div>

      {workflows.length === 0 ? (
        <EmptyState />
      ) : filteredWorkflows.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
          <p className="text-sm text-pretty text-neutral-500 dark:text-neutral-400">
            No workflows match your search.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white dark:divide-neutral-700 dark:border-neutral-700 dark:bg-neutral-800">
          {filteredWorkflows.map((workflow) => (
            <WorkflowRow key={workflow.id} workflow={workflow} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateWorkflowDialog() {
  const navigate = useNavigate();
  const createWorkflow = useCreateWorkflow();
  // React Query dedupes — this shares the cached list with the parent page.
  // isLoading is needed so we don't render misleading "no duplicates" hints
  // (and a green submit button) while the list is still in flight.
  const workflowsQuery = useWorkflows();
  const existingWorkflows = workflowsQuery.data?.workflows ?? [];
  const workflowsLoading = workflowsQuery.isLoading;
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [slug, setSlug] = React.useState('');
  // Auto-derive slug from name until the user manually edits the slug
  // field. After that the slug is theirs and we stop syncing.
  const [slugTouched, setSlugTouched] = React.useState(false);

  const trimmedName = name.trim();
  const duplicateName = React.useMemo(() => {
    if (!trimmedName) return false;
    const lower = trimmedName.toLowerCase();
    return existingWorkflows.some((wf) => wf.name.trim().toLowerCase() === lower);
  }, [existingWorkflows, trimmedName]);
  const duplicateSlug = React.useMemo(() => {
    const s = slug.trim();
    if (!s) return false;
    return existingWorkflows.some((wf) => wf.slug?.trim().toLowerCase() === s.toLowerCase());
  }, [existingWorkflows, slug]);

  function reset() {
    setName('');
    setDescription('');
    setSlug('');
    setSlugTouched(false);
  }

  function handleNameChange(value: string) {
    setName(value);
    if (!slugTouched) {
      setSlug(slugify(value));
    }
  }

  function handleSlugChange(value: string) {
    setSlug(value);
    setSlugTouched(true);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;

    createWorkflow.mutate(
      {
        name: trimmedName,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
      },
      {
        onSuccess: (response) => {
          toastSuccess('Workflow created');
          reset();
          setOpen(false);
          navigate({
            to: '/workflows/$workflowId',
            params: { workflowId: response.workflow.id },
          });
        },
        onError: (err) => {
          toastError(err instanceof Error ? err.message : 'Failed to create workflow');
        },
      },
    );
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        New workflow
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Create workflow</DialogTitle>
              <DialogDescription>
                Start with a blank dag/v1 canvas and configure nodes visually.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  Name
                </span>
                <Input
                  value={name}
                  onChange={(event) => handleNameChange(event.target.value)}
                  placeholder="Daily triage"
                  autoFocus
                />
                {duplicateName && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    A workflow with this name already exists. You can still proceed —
                    the slug below is what uniquely identifies it.
                  </p>
                )}
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  Description
                </span>
                <Input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Optional"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                  Slug
                </span>
                <Input
                  value={slug}
                  onChange={(event) => handleSlugChange(event.target.value)}
                  placeholder="daily-triage"
                  aria-invalid={duplicateSlug || undefined}
                />
                {duplicateSlug ? (
                  <p className="text-[11px] text-red-600 dark:text-red-400">
                    Slug already taken. Pick a different one.
                  </p>
                ) : (
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    Used in URLs and API calls. Must be unique.
                  </p>
                )}
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !name.trim()
                  || duplicateSlug
                  || workflowsLoading
                  || createWorkflow.isPending
                }
              >
                {createWorkflow.isPending ? 'Creating...' : workflowsLoading ? 'Loading…' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function WorkflowRow({ workflow }: { workflow: Workflow }) {
  // Source of truth: workflows.published_version_id. The list endpoint
  // returns the latest published definition under `data` even for
  // unpublished rows (workflows.data is the /sync write surface), so
  // checking data alone would mislabel every workflow as Published.
  const isPublished = Boolean(workflow.publishedVersionId);

  return (
    <li>
      <Link
        to="/workflows/$workflowId"
        params={{ workflowId: workflow.id }}
        className="flex items-start justify-between gap-4 p-4 hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {workflow.name}
            </span>
            <Badge variant={isPublished ? 'success' : 'secondary'}>
              {isPublished ? 'Published' : 'Draft'}
            </Badge>
            {!workflow.enabled && (
              <Badge variant="secondary">Disabled</Badge>
            )}
          </div>
          {workflow.description && (
            <p className="mt-1 line-clamp-2 text-xs text-pretty text-neutral-500 dark:text-neutral-400">
              {workflow.description}
            </p>
          )}
          {workflow.slug && (
            <code className="mt-1 block truncate text-xs text-neutral-400">
              {workflow.slug}
            </code>
          )}
        </div>
        <div className="shrink-0 text-right text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
          <div>v{workflow.version}</div>
          <div>{formatRelativeTime(workflow.updatedAt)}</div>
        </div>
      </Link>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
      <h3 className="text-sm font-medium text-balance text-neutral-900 dark:text-neutral-100">
        No workflows yet
      </h3>
      <p className="mt-1 text-sm text-pretty text-neutral-500 dark:text-neutral-400">
        Create a workflow to open the canvas editor, then publish it when it is ready for triggers.
      </p>
      <div className="mt-4 flex justify-center">
        <CreateWorkflowDialog />
      </div>
    </div>
  );
}

function WorkflowListSkeleton() {
  return (
    <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 bg-white dark:divide-neutral-700 dark:border-neutral-700 dark:bg-neutral-800">
      {Array.from({ length: 5 }).map((_, i) => (
        <li key={i} className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-3 w-16" />
          </div>
        </li>
      ))}
    </ul>
  );
}
