import { createFileRoute, Outlet, Link, useRouterState, redirect } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import { cn } from '@/lib/cn';

const TABS = [
  { path: '/automation/triggers', label: 'Triggers' },
  { path: '/automation/workflows', label: 'Workflows' },
  { path: '/automation/executions', label: 'Runs' },
] as const;

export const Route = createFileRoute('/automation')({
  component: AutomationLayout,
  beforeLoad: ({ location }) => {
    // Redirect /automation to /automation/triggers (default tab)
    if (location.pathname === '/automation' || location.pathname === '/automation/') {
      throw redirect({ to: '/automation/triggers' });
    }
  },
});

function AutomationLayout() {
  const router = useRouterState();
  const currentPath = router.location.pathname;

  return (
    <PageContainer>
      <PageHeader
        title="Automation"
        description="Manage triggers, workflows, and run history"
      />

      {/* Tab Navigation */}
      <div className="border-b border-neutral-200 dark:border-neutral-700">
        <nav className="-mb-px flex gap-6">
          {TABS.map((tab) => {
            const isActive = currentPath.startsWith(tab.path);
            return (
              <Link
                key={tab.path}
                to={tab.path}
                className={cn(
                  'border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-accent text-accent'
                    : 'border-transparent text-neutral-500 hover:border-neutral-300 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300'
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Child Route Content */}
      <div className="mt-6">
        <Outlet />
      </div>
    </PageContainer>
  );
}
