import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "~/components/primitives/tooltip";
import { AppShell } from "~/components/layout/app-shell";
import { Sidebar } from "~/components/layout/sidebar";
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
      <AppShell sidebar={<Sidebar onNewSession={() => setNewOpen(true)} />}>
        <Outlet />
      </AppShell>
      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} />
    </TooltipProvider>
  );
}
