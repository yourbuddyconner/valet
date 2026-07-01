import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { Toaster } from '@/components/ui/toaster';
import { ErrorBoundary } from '@/components/error-boundary';
import { ThemeProvider } from '@/hooks/use-theme';
import { FontScaleProvider } from '@/hooks/use-font-scale';

// Defer syntax highlighting — load the module lazily, then preload
// only the most common languages. Others load on demand.
const scheduleIdle = typeof requestIdleCallback === 'function' ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 1);
scheduleIdle(() => {
  import('@pierre/diffs').then(({ preloadHighlighter }) => {
    preloadHighlighter({
      themes: ['pierre-dark', 'pierre-light'],
      langs: ['typescript', 'javascript', 'json', 'python', 'bash', 'tsx', 'jsx', 'yaml', 'sql'],
    });
  }).catch(() => {});
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
    },
  },
});

export const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <FontScaleProvider>
            <RouterProvider router={router} />
            <Toaster />
          </FontScaleProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
