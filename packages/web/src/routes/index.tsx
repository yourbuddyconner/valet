import { createFileRoute } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Empty,
});

function Empty() {
  return (
    <div className="flex-1 flex items-center justify-center text-center p-12">
      <div className="space-y-3 max-w-sm">
        <div className="mx-auto h-12 w-12 rounded-full bg-accent-100 dark:bg-accent-700/30 grid place-items-center text-accent-600 dark:text-accent-100">
          <Sparkles className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold tracking-tight">Start a session</h1>
        <p className="text-sm text-[--muted]">
          Click <span className="font-medium text-[--fg]">New</span> in the sidebar to spin up an agent
          with a Docker workspace. The agent runs <span className="font-mono text-xs">bash</span>,
          reads, writes, and edits files inside the sandbox.
        </p>
      </div>
    </div>
  );
}
