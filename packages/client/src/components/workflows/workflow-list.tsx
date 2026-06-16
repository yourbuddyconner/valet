import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useWorkflows, type Workflow } from '@/api/workflows';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchInput } from '@/components/ui/search-input';
import { formatRelativeTime } from '@/lib/format';

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
        Ask the agent to draft a workflow, or open one and click <em>Publish</em> to make it available to triggers.
      </p>
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
