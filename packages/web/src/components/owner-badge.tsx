/**
 * "A team owns this" — one badge, wherever the product says it.
 *
 * Skills and skill repositories carry an owner, and every list used to
 * resolve the owning team's name for itself. Four copies drifted into four
 * looks, and the skill card never resolved the name at all.
 *
 * A skill has no owning assistant: every assistant in the workspace may use
 * it. So the team is the whole answer here, and the badge links to the
 * team's default assistant — an owned row is the shortest path to an
 * assistant that can use it. The `?assistant=` search param on `/chat`
 * selects it. Rows that DO name an assistant (workflows, event
 * subscriptions) badge that assistant instead, through `AssistantBadge`.
 *
 * A personal row gets no badge: everything on these pages already belongs to
 * the reader, so a badge on each one carries no information.
 */
import { Link } from "@tanstack/react-router";
import { useTeams } from "~/api/settings";
import { Badge, Tooltip } from "~/components/primitives";

export function OwnerBadge({
  ownerType,
  ownerId,
}: {
  /** `org` renders nothing: this badge links to the OWNING TEAM's
   * assistant, and an org has no team to link to. A list that must label an
   * org row labels it itself (the subscriptions panel does). */
  ownerType: "user" | "team" | "org";
  /** Team id when `ownerType` is `team`; the user id otherwise. */
  ownerId: string;
}) {
  const teams = useTeams();

  if (ownerType !== "team") return null;

  // Not found means the caller cannot see this team, or the id is stale. The
  // row is still team-owned, so name the kind instead of printing an empty
  // badge or dropping the only ownership signal the reader gets.
  const team = (teams.data?.teams ?? []).find((t) => t.id === ownerId);
  const label = team?.name ?? "Team";
  const tip = team ? `Open ${team.name}'s threads` : "Open this team's threads";


  return (
    <Tooltip content={tip}>
      {/* `relative` keeps the badge above a card that covers itself with an
          overlay link (see `SkillCard`), which would otherwise swallow the
          click. */}
      <Link to="/chat" search={{ workspace: ownerId }} className="relative shrink-0">
        <Badge variant="accent">{label}</Badge>
      </Link>
    </Tooltip>
  );
}
