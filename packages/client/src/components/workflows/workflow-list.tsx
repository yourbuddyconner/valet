import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useWorkflows } from '@/api/workflows';
import { WorkflowCard } from './workflow-card';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchInput } from '@/components/ui/search-input';
import { Button } from '@/components/ui/button';

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
        <Button asChild variant="primary" size="sm">
          <Link to="/automation/workflows/new" search={{ editId: undefined }}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            New workflow
          </Link>
        </Button>
      </div>

      {workflows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-1 p-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-surface-2">
            <WorkflowIcon className="size-6 text-neutral-400" />
          </div>
          <h3 className="text-sm font-medium text-balance text-foreground">
            No workflows yet
          </h3>
          <p className="mt-1 text-sm text-pretty text-neutral-500 dark:text-neutral-400 max-w-md mx-auto">
            Describe what you want a workflow to do — Valet drafts it for you, then you refine.
          </p>
          <Button asChild variant="primary" size="md" className="mt-5">
            <Link to="/automation/workflows/new" search={{ editId: undefined }}>
              <Plus className="w-4 h-4 mr-1.5" />
              New workflow
            </Link>
          </Button>
        </div>
      ) : filteredWorkflows.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-8 text-center dark:border-neutral-700 dark:bg-neutral-800">
          <p className="text-sm text-pretty text-neutral-500 dark:text-neutral-400">
            No workflows match your search.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredWorkflows.map((workflow) => (
            <WorkflowCard key={workflow.id} workflow={workflow} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowListSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800"
        >
          <div className="flex items-start justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-16" />
          </div>
          <Skeleton className="mt-2 h-4 w-48" />
          <div className="mt-4 flex items-center justify-between">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkflowIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="m9 14 2 2 4-4" />
    </svg>
  );
}
