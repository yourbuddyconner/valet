import { createRootRouteWithContext, Outlet, useRouterState, redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { useAuthStore } from '@/stores/auth';

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: ({ location }) => {
    const { isAuthenticated, isHydrated } = useAuthStore.getState();

    // Skip auth check for login, OAuth callback, invite, and onboarding pages
    if (location.pathname === '/login' || location.pathname === '/auth/callback' || location.pathname === '/onboarding' || location.pathname.startsWith('/invite/')) {
      return;
    }

    // Wait for hydration before checking auth
    if (!isHydrated) {
      return;
    }

    // Redirect to login if not authenticated
    if (!isAuthenticated) {
      throw redirect({ to: '/login' });
    }
  },
  component: RootLayout,
});

function RootLayout() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isHydrated = useAuthStore((s) => s.isHydrated);
  const routerState = useRouterState();
  const isLoginPage = routerState.location.pathname === '/login' || routerState.location.pathname === '/auth/callback' || routerState.location.pathname === '/onboarding' || routerState.location.pathname.startsWith('/invite/');

  // Show loading while hydrating
  if (!isHydrated) {
    return (
      <div className="flex h-dvh items-center justify-center bg-neutral-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
      </div>
    );
  }

  // Login page has no layout
  if (isLoginPage || !isAuthenticated) {
    return <Outlet />;
  }

  // Session detail pages get full viewport (no sidebar/header)
  const isSessionDetail = /^\/sessions\/[^/]+/.test(routerState.location.pathname);
  if (isSessionDetail) {
    return (
      <div className="h-dvh bg-neutral-50 dark:bg-neutral-900">
        <Outlet />
      </div>
    );
  }

  // Authenticated layout with sidebar and header
  return (
    <div className="flex h-dvh bg-neutral-50 dark:bg-neutral-900">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="min-h-0 flex-1 overflow-auto overscroll-contain">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
