import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { IntegrationList } from '@/components/integrations/integration-list';
import { ConnectIntegrationDialog } from '@/components/integrations/connect-integration-dialog';
import { Button } from '@/components/ui/button';
import { toastSuccess, toastError } from '@/hooks/use-toast';
import { githubKeys } from '@/api/github';

export const Route = createFileRoute('/integrations/')({
  component: IntegrationsPage,
  validateSearch: (search: Record<string, unknown>): { github?: string; reason?: string } => ({
    ...(typeof search.github === 'string' ? { github: search.github } : {}),
    ...(typeof search.reason === 'string' ? { reason: search.reason } : {}),
  }),
});

const REASON_LABELS: Record<string, string> = {
  missing_params: 'Missing parameters from GitHub',
  invalid_state: 'Invalid or expired link — please try again',
  not_configured: 'GitHub OAuth is not configured by your admin',
  token_exchange_failed: 'Failed to exchange token with GitHub',
  profile_fetch_failed: 'Could not fetch your GitHub profile',
};

function IntegrationsPage() {
  const [connectDialogOpen, setConnectDialogOpen] = React.useState(false);
  const { github, reason } = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();

  React.useEffect(() => {
    if (!github) return;

    if (github === 'linked') {
      toastSuccess('GitHub connected', 'Your GitHub account has been linked.');
      qc.invalidateQueries({ queryKey: githubKeys.status });
    } else if (github === 'error') {
      toastError('GitHub linking failed', REASON_LABELS[reason ?? ''] ?? 'An unexpected error occurred.');
    }

    // Clear query params from URL
    void navigate({ to: '/integrations', search: {}, replace: true });
  }, [github, reason, navigate, qc]);

  return (
    <PageContainer>
      <PageHeader
        title="Integrations"
        description="Connect your tools and services"
        actions={
          <Button onClick={() => setConnectDialogOpen(true)}>
            Connect Integration
          </Button>
        }
      />

      <IntegrationList />

      <ConnectIntegrationDialog
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
      />
    </PageContainer>
  );
}
