import type { IntegrationListItem } from '@/api/integrations';
import { useDeleteIntegration } from '@/api/integrations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { getServiceIcon } from './service-icons';

interface IntegrationCardProps {
  integration: IntegrationListItem;
}

const serviceLabels: Record<string, string> = {
  github: 'GitHub',
  gmail: 'Gmail',
  google_calendar: 'Google Calendar',
  google_workspace: 'Google Workspace',
  notion: 'Notion',
  linear: 'Linear',
  hubspot: 'HubSpot',
  ashby: 'Ashby',
  discord: 'Discord',
  slack: 'Slack',
  xero: 'Xero',
  grafana: 'Grafana Cloud',
};

const statusText: Record<IntegrationListItem['status'], { label: string; className: string }> = {
  active: { label: 'Connected', className: 'text-green-600 dark:text-green-400' },
  pending: { label: 'Pending', className: 'text-amber-600 dark:text-amber-400' },
  error: { label: 'Error', className: 'text-red-600 dark:text-red-400' },
  disconnected: { label: 'Disconnected', className: 'text-neutral-500 dark:text-neutral-400' },
};

export function IntegrationCard({ integration }: IntegrationCardProps) {
  const deleteIntegration = useDeleteIntegration();
  const Icon = getServiceIcon(integration.service);
  const status = statusText[integration.status];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">
              {serviceLabels[integration.service] ?? integration.service}
            </CardTitle>
            <p className={`text-xs ${status.className}`}>
              {status.label}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            OAuth connected
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => deleteIntegration.mutate(integration.id)}
            disabled={deleteIntegration.isPending}
          >
            {deleteIntegration.isPending ? 'Disconnecting...' : 'Disconnect'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
