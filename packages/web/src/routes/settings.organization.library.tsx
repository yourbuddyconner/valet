import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { RepoSourcesPanel } from "~/components/skills/repo-sources-panel";
import {
  readSkillFilter,
  skillFilterQuery,
  SkillGrid,
  type SkillGridFilters,
} from "~/components/skills/skill-grid";
import { Button, Spinner } from "~/components/primitives";
import { Pager } from "~/components/pager";
import {
  currentCursor,
  formatCursorStack,
  pageNumber,
  parseCursorStack,
  popCursor,
  pushCursor,
} from "~/lib/cursor-stack";
import { useOrg } from "~/api/settings";
import { useSkills } from "~/api/skills";
import { textParam } from "~/lib/search-params";

/**
 * `/settings/organization/library` — Organization · Library.
 *
 * Two panels. The sources panel tracks GitHub repositories that mirror skills
 * into every member's library. Below it, the org skills panel lists the org's
 * own skills and prompts.
 *
 * This is the org half of a surface that also lives on `/skills`. The two do
 * not repeat each other: `/skills` lists personal and team sources and files
 * a new one under the workspace they are in. This page pins the org, so an
 * admin reads and changes the org library alone. Members do not open this
 * page until RBAC lands. The personal page that used to sit beside both is
 * gone — a row's scope is a badge now, not a third page.
 *
 * An admin adds, removes, and syncs sources, and writes new org skills.
 * A GitHub push re-reads the source. If the App webhook is not live, the
 * sweep re-reads every 5 minutes, so a member's catalog still updates
 * without a Sync button. `readOnly` hides Import, Sync, and Remove.
 * The missing "New org skill" button carries the rest of that split, keyed
 * off `useOrg()`'s `callerRole`, the same admin signal the members page
 * reads.
 *
 * Both lists are paged, and both keep their filters and cursor stack in the
 * search params so Back pages back.
 */
interface LibrarySearch {
  filter?: string;
  q?: string;
  /** Cursor stack for the org skills grid. */
  page?: string;
  /** Cursor stack for the repositories panel. */
  sourcePage?: string;
}

function readLibrarySearch(raw: unknown): LibrarySearch {
  return {
    filter: textParam(raw, "filter"),
    q: textParam(raw, "q"),
    page: textParam(raw, "page"),
    sourcePage: textParam(raw, "sourcePage"),
  };
}

export const Route = createFileRoute("/settings/organization/library")({
  component: OrganizationLibraryPage,
  validateSearch: readLibrarySearch,
});

export function OrganizationLibraryPage() {
  const orgQ = useOrg();
  const isAdmin = orgQ.data?.callerRole === "admin";
  const orgId = orgQ.data?.id;

  // The top-level hooks, not `Route.useSearch()`: the route suites mock this
  // module and never build a real router context.
  const search = readLibrarySearch(useSearch({ strict: false }));
  const navigate = useNavigate();

  function go(next: Partial<LibrarySearch>): void {
    void navigate({ to: "/settings/organization/library", search: { ...search, ...next } });
  }

  return (
    <div className="space-y-10">
      <Section
        title="Library"
        description="An admin adds, removes, and syncs a repository. Valet re-reads it on each GitHub push. If the webhook is not live, it re-reads every 5 minutes. A private repository is read with the GitHub App installed for this organization."
      >
        {orgId === undefined ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner size={14} /> Loading the organization…
          </div>
        ) : (
          <RepoSourcesPanel
            owner={{ type: "org", id: orgId }}
            readOnly={!isAdmin}
            cursors={parseCursorStack(search.sourcePage)}
            onCursorsChange={(next) => go({ sourcePage: formatCursorStack(next) })}
          />
        )}
      </Section>

      <OrgSkillsSection
        isAdmin={isAdmin}
        orgId={orgId}
        search={search}
        onSearchChange={go}
      />
    </div>
  );
}

/** The org's own skills and prompts. Reuses the `/skills` grid, pinned to the
 * org owner so the server sends org rows alone — a client-side filter over a
 * page would drop every org row that fell on a later page. */
function OrgSkillsSection({
  isAdmin,
  orgId,
  search,
  onSearchChange,
}: {
  isAdmin: boolean;
  orgId: string | undefined;
  search: LibrarySearch;
  onSearchChange: (next: Partial<LibrarySearch>) => void;
}) {
  const filters: SkillGridFilters = {
    filter: readSkillFilter(search.filter),
    // The page pins the org, so the scope select is off and its value fixed.
    scope: "all",
    query: search.q ?? "",
  };
  const cursors = parseCursorStack(search.page);
  const cursor = currentCursor(cursors);
  // The org id is the pin, so the read waits for it. Without the wait the
  // query would ask for the whole catalog once and show a member's own
  // skills under an "Organization skills" heading.
  const { data, isLoading, error, isPlaceholderData } = useSkills(
    {
      ...skillFilterQuery(filters),
      ...(orgId === undefined ? {} : { ownerType: "org", ownerId: orgId }),
      ...(cursor === undefined ? {} : { cursor }),
    },
    { enabled: orgId !== undefined },
  );
  const orgSkills = data?.skills ?? [];
  const waiting = isLoading || orgId === undefined;

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h2 className="font-display text-xl text-ink">Organization skills &amp; prompts</h2>
          <p className="text-sm text-muted">
            Skills and prompts owned by the org. Every member&apos;s runtimes can read them.
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" asChild>
            <Link to="/skills/new" search={{ scope: "org" }}>
              New org skill
            </Link>
          </Button>
        )}
      </div>

      {waiting && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading skills…
        </div>
      )}
      {!waiting && (
        <>
          <SkillGrid
            skills={orgSkills}
            filters={filters}
            onFiltersChange={(next) =>
              onSearchChange({
                filter: next.filter === "all" ? undefined : next.filter,
                q: next.query.trim().length === 0 ? undefined : next.query,
                page: undefined,
              })
            }
            showScopeFilter={false}
            emptyLabel="No org skills yet."
            // Through the grid, not in its place: a failed SEARCH must keep
            // the box that can change or clear it (see `/skills`).
            errorLabel={
              error
                ? "Could not load skills. Check that the server is running, then reload."
                : undefined
            }
          />
          {!error && (
            <Pager
              label="organization skills"
              page={pageNumber(cursors)}
              hasPrevious={cursors.length > 0}
              hasNext={data?.nextCursor != null}
              busy={isPlaceholderData}
              onPrevious={() => onSearchChange({ page: formatCursorStack(popCursor(cursors)) })}
              onNext={() => {
                if (data?.nextCursor != null) {
                  onSearchChange({ page: formatCursorStack(pushCursor(cursors, data.nextCursor)) });
                }
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
