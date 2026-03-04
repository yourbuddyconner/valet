import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useAPIKeys, useRevokeAPIKey, type APIKey } from '@/api/api-keys';
import { CreateAPIKeyDialog } from './create-api-key-dialog';
import { formatDate, formatRelativeTime } from '@/lib/format';

export function APIKeyList() {
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);
  const { data, isLoading, isError } = useAPIKeys();

  if (isLoading) {
    return <APIKeyListSkeleton />;
  }

  if (isError) {
    return (
      <div className="rounded-md bg-red-50 p-4 text-sm text-red-600">
        Failed to load API keys
      </div>
    );
  }

  const keys = data?.keys ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-neutral-500">
          {keys.length === 0
            ? 'Create an API key to authenticate with the Valet API.'
            : `${keys.length} API key${keys.length === 1 ? '' : 's'}`}
        </p>
        <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
          Create Key
        </Button>
      </div>

      {keys.length > 0 && (
        <div className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
          {keys.map((key) => (
            <APIKeyRow key={key.id} apiKey={key} />
          ))}
        </div>
      )}

      <CreateAPIKeyDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </div>
  );
}

function APIKeyRow({ apiKey }: { apiKey: APIKey }) {
  const revokeKey = useRevokeAPIKey();

  return (
    <div className="flex items-center justify-between p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <p className="font-medium text-neutral-900">{apiKey.name}</p>
          <code className="rounded bg-neutral-100 px-2 py-0.5 font-mono text-xs text-neutral-600">
            {apiKey.prefix}
          </code>
        </div>
        <p className="mt-1 text-sm text-neutral-500">
          Created {formatDate(apiKey.createdAt)}
          {apiKey.lastUsedAt && (
            <> · Last used {formatRelativeTime(apiKey.lastUsedAt)}</>
          )}
          {apiKey.expiresAt && (
            <> · Expires {formatDate(apiKey.expiresAt)}</>
          )}
        </p>
      </div>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            Revoke
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API Key</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to revoke "{apiKey.name}"? This action
              cannot be undone and any applications using this key will stop
              working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeKey.mutate(apiKey.id)}
              disabled={revokeKey.isPending}
            >
              {revokeKey.isPending ? 'Revoking...' : 'Revoke Key'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function APIKeyListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="divide-y divide-neutral-200 rounded-md border border-neutral-200">
        {[1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between p-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
