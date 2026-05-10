import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "~/components/primitives/tooltip";
import { AppShell } from "~/components/layout/app-shell";
import { TopNav } from "~/components/layout/top-nav";
import { ThreadList } from "~/components/session/thread-list";
import { NewSessionDialog } from "~/components/new-session-dialog";

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  const [newOpen, setNewOpen] = useState(false);
  return (
    <TooltipProvider>
      <AppShell
        topNav={<TopNav onNewSession={() => setNewOpen(true)} />}
        sidebar={<ThreadList />}
      >
        <Outlet />
      </AppShell>
      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} />
    </TooltipProvider>
  );
}
