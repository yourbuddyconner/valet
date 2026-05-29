import * as React from 'react';
import type { CustomMcpConnector } from '@valet/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useCustomMcpConnectors,
  useDeleteCustomMcpConnector,
} from '@/api/custom-mcp-connectors';
import { AddMcpConnectorDialog } from './add-mcp-connector-dialog';

export function CustomMcpConnectorsSection() {
  const { data: connectors, isLoading } = useCustomMcpConnectors();
  const deleteConnector = useDeleteCustomMcpConnector();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomMcpConnector | null>(null);
  const [deleting, setDeleting] = React.useState<CustomMcpConnector | null>(null);

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-6 dark:border-neutral-700 dark:bg-neutral-800">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">Custom MCP Connectors</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Add remote MCP servers for org-managed tools.
          </p>
        </div>
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>Add Connector</Button>
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-700" />)}
          </div>
        ) : connectors && connectors.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-700">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800/50">
                  <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Name</th>
                  <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">URL</th>
                  <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Auth</th>
                  <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-neutral-600 dark:text-neutral-400">Tools</th>
                  <th className="px-3 py-2 text-right font-medium text-neutral-600 dark:text-neutral-400">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((connector) => (
                  <tr key={connector.id} className="border-b border-neutral-100 last:border-0 dark:border-neutral-700/50">
                    <td className="px-3 py-2">
                      <div className="font-medium text-neutral-900 dark:text-neutral-100">{connector.displayName}</div>
                      <div className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{connector.serviceSlug}</div>
                    </td>
                    <td className="max-w-[280px] truncate px-3 py-2 text-neutral-500 dark:text-neutral-400">{connector.serverUrl}</td>
                    <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{formatAuth(connector)}</td>
                    <td className="px-3 py-2">
                      <Badge variant={connector.status === 'active' ? 'success' : connector.status === 'error' ? 'error' : 'secondary'}>
                        {connector.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-neutral-700 dark:text-neutral-300">{connector.toolCount ?? 0}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button variant="secondary" onClick={() => { setEditing(connector); setDialogOpen(true); }}>Edit</Button>
                        <Button variant="secondary" onClick={() => setDeleting(connector)}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-neutral-300 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
            No custom MCP connectors configured.
          </div>
        )}
      </div>

      <AddMcpConnectorDialog
        open={dialogOpen}
        connector={editing}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditing(null);
        }}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Connector</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the connector, cached tools, user connections, credentials, and action policies for this service.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleting) return;
                deleteConnector.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
              }}
              disabled={deleteConnector.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatAuth(connector: CustomMcpConnector): string {
  if (connector.authType === 'none') return 'None';
  if (connector.authType === 'oauth') return connector.hasClientSecret ? 'OAuth secret' : 'OAuth PKCE';
  if (connector.authType === 'bearer') return 'Bearer';
  return connector.apiKeyHeaderName || 'API key';
}
