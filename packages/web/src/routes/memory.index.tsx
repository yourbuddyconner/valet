import { createFileRoute } from "@tanstack/react-router";
import { useMemoryTree } from "~/api/memory";
import { useListOwner } from "~/lib/use-list-owner";
import { useWorkspaceName } from "~/lib/workspace-name";

/**
 * `/memory` index child — the explorer's resting state (Task 6 brief,
 * decision 17): an empty doc pane with a hint, or spec-verbatim empty-state
 * copy when nothing's been remembered yet. The tree/search pane is owned by
 * the parent layout (`memory.tsx`); this route only renders the right pane.
 */
export const Route = createFileRoute("/memory/")({
  component: MemoryIndexPage,
});

function MemoryIndexPage() {
  // Memory belongs to a workspace: a team's notes are the team's, not a
  // view of yours. The switcher says which one is being read.
  const owner = useListOwner();
  const treeQ = useMemoryTree(owner);
  // Name the workspace whose memory is being read.
  const name = useWorkspaceName(owner);

  const nothingRemembered = treeQ.data !== undefined && treeQ.data.entries.length === 0;

  return (
    // A plain `div`, not `main`: the app shell already renders the page's one
    // `main` landmark, and this route paints inside it.
    <div className="hidden md:flex flex-1 min-h-0 items-center justify-center p-8 text-center text-sm text-muted">
      {nothingRemembered ? (
        <p>Nothing remembered yet. Start a thread in {name}, or use Import in the left pane to load a memory bundle.</p>
      ) : (
        <p>Select a file from the tree to read it.</p>
      )}
    </div>
  );
}
